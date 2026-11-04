const { app, BrowserWindow, dialog, globalShortcut, ipcMain, desktopCapturer, screen, session, safeStorage, nativeImage, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { estimateTokens, fitContext, visionTokens, fitFrames, rankNotes } = require('./shared');
const HIDE_HELPER_CS = require('./embed-helpers');

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  chatModel: 'gpt-4o-mini',
  transcribeModel: 'whisper-1',
  stealth: true, // hide overlay from screen capture / screen share
  stealthProcess: true, // AUMID hint for shell/taskbar grouping (does not rename the exe)
  stealthDeep: true, // DWM-cloak + off-screen by default
  stealthMaster: true, // ghost mode: every privacy control at its strongest, on from first run
  captureDisplay: 'auto', // 'auto' | display id | 'window:<source id>'
  ocr: true, // extract text locally from every captured frame and attach it
  updates: true, // check GitHub Releases for a new version in the background
  blendWindow: true, // reparent under an innocuous host to hide class + affinity
  scramble: false, // leave the window capturable (affinity 0) and scramble the text instead
  panelOpacity: 0.78, // 0.3 (ghost) to 0.98 (solid) â€” Cluely-style see-through glass
  // second provider for audio endpoints (transcription + TTS) â€” for gateways without /audio/*
  // falls back to the main provider when left blank
  transcribeBaseUrl: '',
  transcribeApiKey: '',
  ttsBaseUrl: '',
  ttsApiKey: '',
  ttsVoice: 'alloy',
  ttsModel: 'tts-1',
  // backup chat provider, used only after the primary exhausts its retries or
  // returns a hard error. Blank means no failover. Its key is never sent anywhere
  // but its own origin, exactly like the audio providers.
  fallbackBaseUrl: '',
  fallbackApiKey: '',
  fallbackChatModel: '',
  contextTokens: 32000, // model context window; the guard trims history to fit
  answerLang: 'English', // 'auto' or any language name â€” answers always in that language
  answerStyle: 'smart', // smart | brief | star | bullets | code | detail â€” shape of the answer
  targetRole: '', // e.g. "Senior React engineer at a fintech" â€” grounds every answer
  resume: '', // pasted CV â€” answers grounded in real experience, never invented
  knowledge: '', // pasted notes / cheat sheet â€” local retrieval, injected only when relevant
  smartMode: true, // short, spoken-only answers tuned for a live call
  practiceMode: false, // rehearse + debrief: transcript recorded, answers hidden until the session ends
  systemPrompt:
    'You are a real-time assistant shown in a small overlay. Be concise and direct. ' +
    'Lead with the answer, then at most a few short supporting lines. Use code blocks for code.',
};

let win = null;
let cfg = { ...DEFAULTS };
let clickThrough = false;
let currentAbort = null;
let wipeOnQuit = false;
let wipeScheduled = false;
let pendingWipe = false; // marker found at startup: an interrupted wipe completes on exit
let preservedEnc = {}; // blobs DPAPI could not decrypt â€” kept verbatim, never replaced by nothing
let legacyPlaintextKey = false; // a key found in config.json as plaintext (pre-0.2.0 file)
let legacyPlaintextPersonal = false; // plaintext resume/targetRole from before they were encrypted
let legacyConfigFormat = false; // whole config.json still readable (pre-encryption-format)
let envValues = {}; // fields supplied by .env / the environment â€” re-read every launch, never persisted
// The fields that are credentials (never a plaintext fallback, and reported when
// they cannot be encrypted). resume/targetRole are encrypted too, but they are
// personal content, not keys, so they are not counted as "dropped keys".
const KEY_FIELDS = ['apiKey', 'transcribeApiKey', 'ttsApiKey', 'fallbackApiKey'];
let keysNotPersisted = []; // keys held in memory only: encryption was unavailable when they were saved

// Detached cleanup for `wipe all data`: spawned the moment a wipe is requested,
// not at quit time, so a crash or a PID-targeted taskkill can't skip it. The
// helper is a detached PowerShell process â€” it used to re-run this binary as
// plain Node (`ELECTRON_RUN_AS_NODE=1`), which the RunAsNode fuse turns off. It
// watches our PID and removes the whole userData dir once the process tree is
// gone: Chromium's children hold profile locks past will-quit, which is why
// removal must outlive the app.
// A marker file OUTSIDE userData records the pending wipe, so if the helper is
// killed too (taskkill /IM and /T take parent and helper together: same image,
// child of the browser process) the NEXT launch finishes the job.
// %APPDATA%\assistant â€” one neutral folder, no product name left on disk
// profile folder follows the product name (now 'svchost'); 'assistant' stays in the
// legacy list below so an existing profile is migrated once
const PROFILE_DIR = path.join(app.getPath('appData'), app.getName());
const WIPE_MARKER = path.join(app.getPath('appData'), '.assistant-pending');

function wipeMarkerPath() {
  return WIPE_MARKER; // sibling of userData, survives its removal
}
function deleteWipeTargets() {
  const ud = app.getPath('userData');
  for (const f of ['config.json', 'state.json', 'bounds.json']) {
    try { fs.unlinkSync(path.join(ud, f)); } catch {}
  }
  try { fs.rmSync(path.join(ud, 'sessions'), { recursive: true, force: true }); } catch {}
}
// PowerShell is resolved from fixed locations, never PATH-first: npm puts
// node_modules/.bin ahead of everything, and a shadowed powershell.exe would be
// running with the user's data in scope.
function powershellPath() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(p) ? p : null;
}
function pwshPath() {
  const p = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return fs.existsSync(p) ? p : null;
}

// The detached cleanup command. Kept in one place so the harness runs the real
// thing (scripts/test-main.js) instead of a copy that drifts.
//   1. wait for the app process to exit, capped at 10 min (at the cap: leave the
//      profile alone â€” the quit-time spawn and the next-launch marker cover it)
//   2. the marker is the authority: a Settings save after a wipe deletes it, which
//      cancels the removal; then retry while Chromium children release their locks
function wipeHelperCommand(dir, marker, pid) {
  const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$target = ${Number(pid)}`,
    `$dir = ${psQuote(dir)}`,
    `$marker = ${psQuote(marker)}`,
    '$deadline = (Get-Date).AddMinutes(10)',
    'while ((Get-Process -Id $target) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 500 }',
    'if (Get-Process -Id $target) { exit 0 }',
    'for ($i = 0; $i -lt 60; $i++) {',
    '  if (-not (Test-Path -LiteralPath $marker)) { exit 0 }',
    '  try {',
    '    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop',
    '    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue',
    '    exit 0',
    '  } catch { Start-Sleep -Milliseconds 500 }',
    '}',
    'exit 1',
  ].join('\n');
  return {
    exe: powershellPath() || pwshPath(),
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    script,
  };
}

function scheduleWipe(force) {
  if (!wipeOnQuit) return;
  if (!force && wipeScheduled) return;
  wipeScheduled = true;
  const dir = app.getPath('userData');
  const marker = wipeMarkerPath();
  const cmd = wipeHelperCommand(dir, marker, process.pid);
  if (!cmd.exe) {
    wipeScheduled = false; // no PowerShell: the marker makes the next launch finish it
    return;
  }
  try {
    const child = require('child_process').spawn(cmd.exe, cmd.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    // real spawn failures (ENOENT/AV block) arrive async as an 'error' event â€”
    // without a listener they'd crash the main process
    child.on('error', () => { wipeScheduled = false; });
    child.unref();
  } catch {
    wipeScheduled = false; // allow will-quit to retry the spawn
  }
}

// ---------- config ----------
function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const configPath = () => path.join(app.getPath('userData'), 'config.json');

// API key encryption at rest (Windows DPAPI via Electron safeStorage)
function encryptKey(k) {
  if (!k) return '';
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(k).toString('base64') : '';
  } catch {
    return '';
  }
}
function encryptionAvailable() {
  try {
    return Boolean(safeStorage.isEncryptionAvailable());
  } catch {
    return false;
  }
}
function decryptKey(b64) {
  if (!b64) return '';
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch {
    return '';
  }
}

function loadConfig() {
  const env = { ...parseEnvFile(path.join(__dirname, '..', '.env')), ...process.env };
  const fromEnv = {};
  if (env.OPENAI_API_KEY) fromEnv.apiKey = env.OPENAI_API_KEY;
  if (env.OPENAI_BASE_URL) fromEnv.baseUrl = env.OPENAI_BASE_URL;
  if (env.CHAT_MODEL) fromEnv.chatModel = env.CHAT_MODEL;
  if (env.TRANSCRIBE_MODEL) fromEnv.transcribeModel = env.TRANSCRIBE_MODEL;
  let saved = {};
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    // new format: the whole settings object is one DPAPI blob
    if (raw && raw.cfg) {
      const txt = decryptBlob(raw.cfg);
      if (txt) saved = JSON.parse(txt);
      else saved = {}; // undecryptable on this machine â€” start clean
    } else {
      saved = raw; // legacy readable settings â€” migrated on settle below
      legacyConfigFormat = true;
    }
  } catch {}
  // decrypt all stored keys; tolerate legacy plaintext values
  preservedEnc = {};
  legacyPlaintextKey = false;
  legacyPlaintextPersonal = false;
  for (const [encField, plainField] of [
    ['apiKeyEnc', 'apiKey'],
    ['transcribeApiKeyEnc', 'transcribeApiKey'],
    ['ttsApiKeyEnc', 'ttsApiKey'],
    ['fallbackApiKeyEnc', 'fallbackApiKey'],
    ['resumeEnc', 'resume'],
    ['targetRoleEnc', 'targetRole'],
  ]) {
    if (saved[encField]) {
      const v = decryptKey(saved[encField]);
      if (v) saved[plainField] = v;
      // DPAPI failed (profile moved, password reset, another user, restored backup):
      // keep the blob. Replacing it with an empty key destroys the only copy.
      else preservedEnc[encField] = saved[encField];
    } else if (typeof saved[plainField] === 'string' && saved[plainField]) {
      // pre-encryption file: worth exactly one rewrite on the next start
      if (KEY_FIELDS.includes(plainField)) legacyPlaintextKey = true;
      else legacyPlaintextPersonal = true;
    }
    delete saved[encField];
  }
  // saved settings win over env so the Settings panel is authoritative once used
  cfg = { ...DEFAULTS, ...fromEnv, ...saved };
  envValues = { ...fromEnv };
  // Ghost mode is authoritative, and enforced here rather than only in the
  // Settings checkboxes: a profile saved before the mode existed can carry
  // stealth=false, and turning the mode on has to win over that.
  if (cfg.stealthMaster) {
    cfg.stealth = true;
    cfg.stealthProcess = true;
    cfg.stealthDeep = true;
    cfg.blendWindow = true;
  }
}

// A crash mid-write truncates the file and takes the DPAPI blobs with it. Write to
// a sibling then rename: the old contents stay intact until the new ones are complete.
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function saveConfig(next, dropBlobs = []) {
  cfg = { ...cfg, ...next };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  // never write any key as plaintext â€” DPAPI-encrypted blob or nothing (fail closed)
  const onDisk = { ...cfg };
  const dropped = [];
  for (const [plainField, encField] of [
    ['apiKey', 'apiKeyEnc'],
    ['transcribeApiKey', 'transcribeApiKeyEnc'],
    ['ttsApiKey', 'ttsApiKeyEnc'],
    ['fallbackApiKey', 'fallbackApiKeyEnc'],
    ['resume', 'resumeEnc'],
    ['targetRole', 'targetRoleEnc'],
  ]) {
    // An explicit delete must remove the unreadable blob too â€” otherwise the
    // ciphertext we cannot decrypt is silently re-written by the preservedEnc path.
    if (dropBlobs.includes(plainField)) {
      delete preservedEnc[encField];
      delete onDisk[plainField];
      delete onDisk[encField];
      continue;
    }
    // A key supplied by .env or the environment is re-read on every launch, so
    // do not persist it as plaintext. Still keep an encrypted copy though: the
    // packaged app has no .env, so without this the key vanishes the moment the
    // app is run from an install rather than the source tree.
    if (envValues[plainField] && cfg[plainField] === envValues[plainField]) {
      delete onDisk[plainField]; // never persist an .env secret as plaintext
      const envEnc = preservedEnc[encField] || encryptKey(cfg[plainField]);
      if (envEnc) onDisk[encField] = envEnc;
      continue;
    }
    const enc = encryptKey(cfg[plainField]);
    delete onDisk[plainField];
    if (enc) {
      onDisk[encField] = enc;
      delete preservedEnc[encField]; // a freshly encrypted key supersedes an unreadable blob
    } else if (preservedEnc[encField]) {
      onDisk[encField] = preservedEnc[encField]; // never drop a key we merely could not read
    } else if (KEY_FIELDS.includes(plainField) && cfg[plainField]) {
      // fail closed: the key stays in memory for this session and is never written.
      // Record it so the UI cannot claim it was stored (that claim was a lie).
      dropped.push(plainField);
    }
  }
  keysNotPersisted = dropped;
  // Every value that could identify this as an AI assistant (base URL, model
  // names, prompt, language) goes into the same DPAPI blob as the keys. The
  // on-disk file is then one opaque line instead of readable settings.
  const cfgEnc = encryptBlob(JSON.stringify(onDisk));
  writeFileAtomic(configPath(), cfgEnc ? JSON.stringify({ cfg: cfgEnc }) : JSON.stringify(onDisk, null, 2));
  applyStealth();
}

function publicConfig() {
  // renderer never needs raw keys back
  return {
    ...cfg,
    apiKey: '',
    hasKey: Boolean(cfg.apiKey),
    transcribeApiKey: '',
    ttsApiKey: '',
    fallbackApiKey: '',
    hasTranscribeKey: Boolean(cfg.transcribeApiKey),
    hasTtsKey: Boolean(cfg.ttsApiKey),
    hasFallbackKey: Boolean(cfg.fallbackApiKey),
    encryptionAvailable: encryptionAvailable(),
    keysNotPersisted: keysNotPersisted.slice(),
  };
}

// ---------- IPC trust ----------
// Every handler below is reachable from the renderer. Only the app's own file://
// window may call them â€” there is no remote content today, and this keeps it that
// way if one is ever loaded.
function isTrustedSender(event) {
  try {
    return /^file:\/\//i.test(event.senderFrame?.url || '');
  } catch {
    return false;
  }
}
const handle = (channel, fn) =>
  ipcMain.handle(channel, (event, ...args) =>
    isTrustedSender(event) ? fn(event, ...args) : { error: 'unauthorized: IPC sender is not the app window' },
  );

// ---------- native stealth helper ----------
// Compiled from scripts/hide-helper.cs with the in-box csc; cached at
// %TEMP%\wshx-audit\hide-helper.exe so the on-disk path never advertises
// the app name. Missing on non-Windows â€”  the deep-stealth path no-ops.
const HIDE_HELPER = path.join(require('os').tmpdir(), 'dxva_143.exe'); // name kept: reads as a DXVA helper
function ensureHideHelper() {
  if (process.platform !== 'win32') return false;
  // If the compiled helper exists and is newer than the embedded source marker, reuse it.
  try {
    if (fs.existsSync(HIDE_HELPER)) {
      const marker = path.join(path.dirname(HIDE_HELPER), '.hide_helper_src');
      const embeddedHash = crypto.createHash('sha256').update(HIDE_HELPER_CS).digest('hex');
      if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === embeddedHash) return true;
    }
  } catch {}
  try {
    fs.mkdirSync(path.dirname(HIDE_HELPER), { recursive: true });
    const src = path.join(path.dirname(HIDE_HELPER), 'hide-helper.cs');
    fs.writeFileSync(src, HIDE_HELPER_CS);
    const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    if (!fs.existsSync(csc)) return false;
    // the ocr command needs the WinRT projection: its AsTask extension lives in
    // System.Runtime.WindowsRuntime and the contracts are per-namespace winmd
    // files shipped in System32\WinMetadata
    const winmd = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WinMetadata');
    const refs = ['/reference:System.dll'];
    for (const md of ['Windows.Foundation', 'Windows.Storage', 'Windows.Graphics', 'Windows.Media', 'Windows.Globalization']) {
      const p = path.join(winmd, md + '.winmd');
      if (fs.existsSync(p)) refs.push('/reference:' + p);
    }
    const wrr = path.join(
      process.env.WINDIR || 'C:\\Windows',
      'Microsoft.NET', 'Framework64', 'v4.0.30319', 'System.Runtime.WindowsRuntime.dll',
    );
    if (fs.existsSync(wrr)) refs.push('/reference:' + wrr);
    require('child_process').execFileSync(
      csc,
      ['/nologo', '/target:exe', '/out:' + HIDE_HELPER, src, ...refs],
      { stdio: 'ignore' }
    );
    if (fs.existsSync(HIDE_HELPER)) {
      const embeddedHash = crypto.createHash('sha256').update(HIDE_HELPER_CS).digest('hex');
      fs.writeFileSync(path.join(path.dirname(HIDE_HELPER), '.hide_helper_src'), embeddedHash);
      try { fs.unlinkSync(src); } catch {}
      return true;
    }
  } catch {}
  return false;
}

// Blends the Electron process tree's *window titles* (what Task Manager's
// "Application Windows" column and EnumWindows-based tools read) into a
// generic Windows shell name. The on-disk exe name is fixed by the build; the
// title is what a quick glance at Task Manager actually shows, and it is the
// one surface we can change at runtime. Covers main + the live helper procs.
// neutral title: the product name is a giveaway in Task Manager's window
// column, so the window advertises what it does, not what it is called.
const BLEND_TITLE = 'assistant';
function blendProcessTitles() {
  if (process.platform !== 'win32') return;
  try {
    process.title = BLEND_TITLE;
  } catch {}
  let procs = [];
  try {
    procs = app.getAppMetrics().map((m) => m.pid).filter(Boolean);
  } catch {}
  const child = require('child_process');
  for (const pid of procs) {
    try {
      // hide-process also sets WDA_EXCLUDEFROMCAPTURE on every top-level window
      // of that PID, closing the child-surface capture hole (the renderer/GPU
      // helper hwnds) that setContentProtection on the main frame leaves open.
      child.spawnSync(HIDE_HELPER, ['hide-process', String(pid)], { stdio: 'ignore', timeout: 1500 });
      child.spawnSync(HIDE_HELPER, ['set-title', String(pid), BLEND_TITLE], { stdio: 'ignore', timeout: 1500 });
    } catch {}
  }
}

// ---------- window ----------
// Chromium writes DevToolsActivePort into the profile; it names a port and a
// UUID and is another "Electron/Chromium" tell. Only meaningful while debugged.
function removeDevtoolsPort() {
  if (process.env.WSHX_KEEP_DEVTOOLS_PORT === '1') return;
  try { fs.unlinkSync(path.join(app.getPath('userData'), 'DevToolsActivePort')); } catch {}
}

// While we grab our OWN screen frame, capture protection must be OFF or the
// overlay is excluded from a screenshot we are taking for ourselves (blank
// frame / missing panel). Cluely does exactly this with isCapturingScreenshot.
let selfCapturing = false;

// The exclusion flag is top-level-only, so when the blend host exists it goes
// on the host; the child would accept the call but silently keep affinity 0.
function applyAffinity() {
  const nat = loadCloak();
  if (!nat || !nat.hostHandle || !win || win.isDestroyed()) return;
  const host = nat.hostHandle();
  if (!host) return;

  const wantOn = Boolean(cfg.stealth) && !selfCapturing;

  // The exclusion flag only works on TOP-LEVEL windows, so it has to live on the
  // host; a call on the reparented child is accepted but has no effect, which
  // silently removed the protection. Measured: DWMWA_EXCLUDED_FROM_CAPTURE (16)
  // on the host does not cover the child's pixels either, so the classic flag is
  // the only mechanism that works through the shim.
  //
  // What the shim still buys: the flagged window is no longer Chrome_WidgetWin_1.
  // A detector that filters by class before checking affinity finds nothing.
  // re-key the layered host first: a lost colour key makes the flag ineffective
  try { if (nat.rekey) nat.rekey(host); } catch {}
  const ok = nat.setAffinity(host, wantOn ? 0x11 : 0);
  if (ok && wantOn) {
    // After a hide/show the flag can read back as 0x11 while the window is still
    // captured: DWM has not recomposed the surface since the call. A cloak/uncloak
    // cycle forces it and is invisible at this speed.
    try { nat.cloak(host); nat.uncloak(host); } catch {}
  }
}

function applyStealth() {
  if (win && !win.isDestroyed()) {
    win.setContentProtection(Boolean(cfg.stealth) && !selfCapturing);
  }
  // the exclusion flag is top-level only; with the blend host present the flag
  // belongs on the host, and a call on the child is accepted but ignored
  if (loadCloak()) applyAffinity();
}

// DWM-cloak + SetWindowLong the BrowserWindow frame AND every child surface
// (Chromium splits a BrowserWindow into a top-level frame plus several child
// hwnds for the actual content, and the renderer child is what captures and
// a11y walkers hit). Runs the helper per-hwnd so a single bad handle can't
// abort the pass.
function runHideHelper(args, cb) {
  const { spawn } = require('child_process');
  const child = spawn(HIDE_HELPER, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  const timer = setTimeout(() => { try { child.kill(); } catch {}; cb(new Error('timeout')); }, 10000);
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => err += d);
  child.on('close', code => { clearTimeout(timer); cb(null, out, code); });
  child.on('error', e => { clearTimeout(timer); cb(e); });
}

// DWM cloak must run inside the process that OWNS the window: a foreign caller
// gets E_ACCESSDENIED (0x80070005), measured from a helper, PowerShell and a
// node addon. So this is a tiny in-process napi addon, not a spawned helper.
// It is optional â€” a missing binary just means no cloak, never a crash.
let cloakNative = null;
function loadCloak() {
  if (cloakNative !== null || process.platform !== 'win32') return cloakNative;
  // prefer a build matching this process arch; the packaging step drops one in
  // per-arch, and build/Release is the plain `npm install` fallback
  const candidates = [
    path.join(__dirname, 'native', process.arch, 'cloak.node'),
    path.join(__dirname, 'native', 'build', 'Release', 'cloak.node'),
  ];
  for (const p of candidates) {
    try {
      const mod = require(p);
      // a stale copy from an older build loads fine but lacks newer exports, so
      // validate before accepting it instead of shadowing the fresh build
      if (typeof mod.cloak === 'function' && typeof mod.attachHost === 'function') {
        cloakNative = mod;
        break;
      }
    } catch {}
  }
  if (!cloakNative) cloakNative = false;
  return cloakNative;
}
function setDwmCloak(h32, on) {
  const nat = loadCloak();
  if (!nat) return false;
  try {
    return on ? nat.cloak(h32).ok : nat.uncloak(h32).ok;
  } catch {
    return false;
  }
}

function cloakHost(on) {
  const nat = loadCloak();
  if (!nat || !nat.hostHandle) return;
  const host = nat.hostHandle();
  if (!host) return;
  try { on ? nat.cloak(host) : nat.uncloak(host); } catch {}
}

function applyDeepStealth(on, cb, soft) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) { if (cb) cb(); return; }
  const h32 = win.getNativeWindowHandle().readUInt32LE(0);
  // soft = the panel is on screen: capture protection only, never DWM-cloak.
  // DWMWA_CLOAK stops DWM composing the window, so "cloaked but visible" does
  // not exist â€” the cloak has to stay off whenever the user is meant to see the
  // panel. The soft path used to fall through to the hard cloak because the
  // helper has no cloak-soft command, which made deep stealth hide the overlay
  // from its own user; this branch is what keeps it on screen.
  const finish = () => {
    let cloaked = false;
    if (!soft) {
      // cloak LAST: the helper rewrites ex-styles, and a style write drops the
      // cloak, so it has to be the final call
      cloakHost(on);
      cloaked = setDwmCloak(h32, on);
    }
    // The helper's `uncloak` calls SetWindowDisplayAffinity(h, WDA_NONE) on the
    // root â€” so every hide/show cycle silently dropped capture protection and the
    // panel came back capturable until the next config save. Re-assert it here,
    // after the style/cloak writes, for both directions.
    applyStealth();
    if (process.env.WSHX_CLOAK_DEBUG) console.log('[cloak]', h32, on, cloaked, soft ? 'soft' : 'hard');
    if (cb) cb(null, cloaked);
  };
  if (soft) { finish(); return; }
  if (!ensureHideHelper()) { finish(); return; }
  const cmd = on ? 'cloak' : 'uncloak';
  runHideHelper([cmd, String(h32)], finish);
}

function applyDeepStealthAsync(on, soft) {
  return new Promise(resolve => applyDeepStealth(on, resolve, soft));
}

let isShown = false;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 760;
  const height = 600;

  // restore saved position/size or center; clamp against the display the window actually lives on
  let target = workArea;
  let bounds = { width, height, x: Math.round(workArea.x + (workArea.width - width) / 2), y: workArea.y + 24 };
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'bounds.json'), 'utf8'));
    if (saved.width && saved.height) {
      bounds = saved;
      // clamp against the monitor nearest the saved center, so a left-monitor x=-1920 survives
      const near = screen.getDisplayNearestPoint({
        x: Math.round((saved.x ?? 0) + (saved.width ?? width) / 2),
        y: Math.round((saved.y ?? 0) + (saved.height ?? height) / 2),
      });
      target = near.workArea;
    }
  } catch {}
  bounds.width = Math.min(Math.max(bounds.width || width, 420), target.width);
  bounds.height = Math.min(Math.max(bounds.height || height, 360), target.height);
  bounds.x = Math.min(Math.max(bounds.x ?? target.x, target.x), target.x + target.width - bounds.width);
  bounds.y = Math.min(Math.max(bounds.y ?? target.y, target.y), target.y + target.height - bounds.height);

  let iconPath = path.join(__dirname, 'renderer', 'logo.png');
  if (!fs.existsSync(iconPath)) iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  if (!fs.existsSync(iconPath)) iconPath = undefined;
  win = new BrowserWindow({
    ...bounds,
    title: crypto.randomBytes(8).toString('hex'),
    icon: iconPath || undefined,
    // A reparented window cannot also be a layered (transparent) one: once the
    // Chromium window is a child of the blend host, its DirectComposition
    // surface is never composed and the overlay is an empty hole. Measured both
    // ways (opaque renders, transparent does not), so blend mode trades the
    // see-through background for being absent from window enumeration â€” the
    // host is the only window other apps can find, and the panel paints opaque
    // over the window colour instead of over the desktop.
    transparent: !cfg.blendWindow,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: cfg.blendWindow ? '#14161a' : '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Freeze the window title so EnumWindows sees BLEND_TITLE, not the page title
  win.on('page-title-updated', (e) => e.preventDefault());
  // TEMP: dump renderer console + JS errors to a file for diagnosis
  const diagFile = path.join(app.getPath('userData'), 'renderer.log');
  const diag = (line) => { try { fs.appendFileSync(diagFile, line + '\n'); } catch {} };
  win.webContents.on('console-message', (e, level, message, line, sourceId) => diag(`[console] [${level}] ${message} @ ${sourceId}:${line}`));
  win.webContents.on('preload-error', (e, p, err) => diag(`[preload-error] ${p}: ${err}`));
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => diag(`[did-fail-load] ${code} ${desc} ${url} main=${isMainFrame}`));
  win.webContents.on('did-fail-load-for-navigate', (e, code, desc, url, isMainFrame) => diag(`[did-fail-load-for-navigate] ${code} ${desc} ${url} main=${isMainFrame}`));
  win.webContents.on('render-process-gone', (_e, details) => diag(`[render-process-gone] ${JSON.stringify(details)}`));
  win.webContents.on('destroyed', () => diag(`[destroyed] webContents destroyed`));
  try {
    diag(`[heartbeat] file=${diagFile} cwd=${process.cwd()} exedir=${path.dirname(process.execPath)}`);
    const hb = fs.statSync(diagFile);
    diag(`[heartbeat] wrote ok size=${hb.size} mtime=${hb.mtime.toISOString()}`);
  } catch (e) {
    diag(`[heartbeat] WRITE FAILED: ${e.message}`);
  }
  diag(`--- session start ${new Date().toISOString()} ---`);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.platform === 'win32') {
    try {
      win.setTitle(BLEND_TITLE);
    } catch {}
  }
  applyStealth();
  // Apply deep stealth after the window is fully shown â€” delayed to ensure
  // ensureHideHelper() has time to compile the C# helper on first run.
  // soft=true: cloak-soft (no minimize) so the window stays visible on startup.
  if (cfg.stealthDeep) {
    const deepApply = () => { if (win && !win.isDestroyed()) applyDeepStealth(true, null, true); };
    setTimeout(deepApply, 1500);
    setTimeout(deepApply, 3000);
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  isShown = true;

  // save bounds on move/resize â€” debounced off the main-thread hot path
  let boundsTimer = null;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        writeFileAtomic(path.join(app.getPath('userData'), 'bounds.json'), JSON.stringify(win.getBounds()));
      }
    }, 250);
  };
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);
  win.on('closed', () => { win = null; isShown = false; });
}

async function toggleVisible() {
  if (!win) return;
  if (isShown) {
    if (cfg.stealthDeep) {
      const before = win.getBounds();
    win.setPosition(-32000, -32000); // off every monitor: an unambiguous background
    } else {
      win.setPosition(-32000, -32000);
      win.hide();
    }
    isShown = false;
  } else {
    if (cfg.stealthDeep) {
      await applyDeepStealthAsync(false);
    }
    const b = win.getBounds();
    const { workArea } = screen.getPrimaryDisplay();
    if (b.x < workArea.x || b.y < workArea.y || b.x + b.width > workArea.x + workArea.width || b.y + b.height > workArea.y + workArea.height) {
      win.setPosition(Math.round(workArea.x + (workArea.width - b.width) / 2), workArea.y + 24);
    }
    win.showInactive();
    win.focus();
    isShown = true;
    // Showing is what drops the flag: Chromium builds a fresh surface for the
    // child, and the helper's uncloak already cleared affinity on the root. The
    // re-assert in applyDeepStealth runs *before* this show, so it is not enough.
    setTimeout(() => { if (win && !win.isDestroyed()) applyStealth(); }, 150);
  }
}

function nudge(dx, dy) {
  if (!win) return;
  const b = win.getBounds();
  // Keep a grabbable strip on the display nearest the new center. An unclamped
  // nudge let Ctrl+Alt+arrows push the overlay past every monitor edge, and there
  // was no way to bring it back short of quitting.
  const centre = { x: b.x + Math.floor(b.width / 2) + dx, y: b.y + Math.floor(b.height / 2) + dy };
  const area = screen.getDisplayNearestPoint(centre).workArea;
  const x = Math.min(Math.max(b.x + dx, area.x - b.width + 80), area.x + area.width - 80);
  const y = Math.min(Math.max(b.y + dy, area.y), area.y + area.height - 40);
  win.setPosition(Math.round(x), Math.round(y));
}

function toggleClickThrough() {
  if (!win) return;
  clickThrough = !clickThrough;
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  win.webContents.send('click-through', clickThrough);
}

// Panic: make the panel disappear right now, whatever state it is in. Bound to a
// key that takes one hand, because the moment it matters the user is mid-answer
// and looking at a camera, not at the overlay.
function panicHide() {
  if (!win || win.isDestroyed() || !isShown) return;
  toggleVisible(); // the hide branch cloaks off-screen and drops the flag state
}

function registerShortcuts() {
  // chosen to avoid every common browser/app binding (Ctrl+Enter, Ctrl+Shift+M/Q in Firefox,
  // Ctrl+Shift+Space is often held by IME/overlays). Failed registrations surface in the log + status line.
  const failed = [];
  const reg = (acc, fn) => {
    if (!globalShortcut.register(acc, fn)) failed.push(acc);
  };
  reg('CommandOrControl+Shift+H', toggleVisible); // primary show/hide
  reg('CommandOrControl+Alt+Space', toggleVisible); // backup: same finger-friendly, unused by browsers
  reg('CommandOrControl+Alt+Enter', () => win?.webContents.send('trigger', 'ask-screen'));
  reg('CommandOrControl+Shift+L', () => win?.webContents.send('trigger', 'toggle-listen'));
  reg('CommandOrControl+Shift+A', () => win?.webContents.send('trigger', 'answer-transcript'));
  reg('CommandOrControl+Alt+M', toggleClickThrough);
  reg('CommandOrControl+Alt+X', panicHide); // panic: vanish now
  reg('CommandOrControl+Alt+Left', () => nudge(-40, 0));
  reg('CommandOrControl+Alt+Right', () => nudge(40, 0));
  reg('CommandOrControl+Alt+Up', () => nudge(0, -40));
  reg('CommandOrControl+Alt+Down', () => nudge(0, 40));
  reg('CommandOrControl+Alt+Q', () => app.quit());
  reg('CommandOrControl+Shift+Q', () => app.quit()); // matches the â€”S" close button
  if (failed.length) {
    console.warn('shortcuts unavailable:', failed.join(', '));
    const message = `Hotkey conflict â€” these are taken by another app: ${failed.join(', ')}`;
    // registerShortcuts() runs before loadFile() finishes, so sending immediately
    // loses the notice on the one launch where it matters.
    if (win) {
      const notify = () => win && !win.isDestroyed() && win.webContents.send('notice', { level: 'warn', message });
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', notify);
      else notify();
    }
  }
}

// ---------- screen capture ----------
function pickDisplay() {
  if (cfg.captureDisplay && cfg.captureDisplay !== 'auto') {
    const found = screen.getAllDisplays().find((d) => String(d.id) === String(cfg.captureDisplay));
    if (found) return found;
  }
  // auto: the display the overlay sits on (falls back to cursor point, then primary)
  if (win && !win.isDestroyed()) {
    const b = win.getBounds();
    return screen.getDisplayNearestPoint({ x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2) });
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

async function captureScreen() {
  // a 'window:<id>' target captures one app instead of a whole display
  const wantWindow = cfg.captureDisplay && String(cfg.captureDisplay).startsWith('window:')
    ? String(cfg.captureDisplay).slice(7)
    : '';
  const display = pickDisplay();
  const { width, height } = display.size;
  const scale = Math.min(1, 1920 / Math.max(width, height)); // 1920px keeps code/text legible
  const thumbW = Math.round(width * scale);
  const thumbH = Math.round(height * scale);
  // Capture protection excludes the overlay from the very screenshot we are
  // taking, so drop it for the grab and set it back afterwards.
  selfCapturing = Boolean(cfg.stealth);
  try {
    if (selfCapturing) {
      applyStealth();
      await new Promise((r) => setTimeout(r, 90)); // let DWM re-composite
    }
    const sources = await desktopCapturer.getSources({
      types: wantWindow ? ['window'] : ['screen'],
      thumbnailSize: { width: thumbW, height: thumbH },
    });
    const src = wantWindow
      ? sources.find((s) => String(s.id) === wantWindow) || sources[0]
      : sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!src) throw new Error(wantWindow ? 'Window is gone' : 'No screen source available');
    const jpeg = src.thumbnail.toJPEG(82);
    return {
      b64: jpeg.toString('base64'),
      tokens: visionTokens(thumbW, thumbH),
      // OCR is extracted locally so the model gets exact text for code, forms
      // and tables instead of having to read glyphs out of the pixels
      text: cfg.ocr ? ocrBuffer(jpeg) : '',
    };
  } finally {
    if (selfCapturing) {
      selfCapturing = false;
      applyStealth();
    }
  }
}

// Run the in-box Windows OCR engine over a captured JPEG. Returns the text, or
// '' when OCR is unavailable â€” never throws, because a vision model alone is
// still a valid answer path.
function ocrBuffer(jpegBuf) {
  try {
    if (!fs.existsSync(HIDE_HELPER)) return '';
    const out = require('child_process').execFileSync(
      HIDE_HELPER,
      ['ocr', 'b64:' + jpegBuf.toString('base64')],
      { encoding: 'utf8', timeout: 12000, maxBuffer: 8 * 1024 * 1024 },
    );
    const lines = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /^L\t(.+)$/.exec(line);
      if (m) lines.push(Buffer.from(m[1], 'base64').toString('utf8'));
    }
    return lines.join('\n').trim();
  } catch {
    return '';
  }
}

// ---------- ghost check: prove the exclusion from inside the app ----------
// The claim "nothing that captures your screen sees this" is worth one button
// that tests it on the machine you are actually sitting at, because capture
// behaviour depends on the Windows build, the compositor and the capturer.
//
// Method, the same shape as the shipped scripts/capture-ab.js: sample a region
// over the panel while it is protected, hide the panel, sample the identical
// region again, and compare. Identical hashes mean the capture cannot see the
// pixels. Pixel equality alone does not say *which* mechanism produced it, so
// the affinity flag is read back too (0x11 excluded, 0x1 monitor fallback).
const GHOST_SAMPLE = { w: 180, h: 110 };

function grabRaw(display) {
  // desktopCapturer only â€” deliberately does not touch selfCapturing, because
  // the panel has to stay protected while the check runs.
  const s = display.scaleFactor || 1;
  return desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * s),
      height: Math.round(display.size.height * s),
    },
  });
}

// Contrast between the inside and the outside of the panel, measured in one frame.
//
// Absolute luminance fails here because the panel is translucent glass: what a
// capture shows depends on the desktop behind it, which changes between samples.
// Comparing the panel's interior with the desktop just beside it is self-
// referencing â€” same frame, same background â€” so it stays stable whether the
// page behind is white, dark or moving.
//   excluded  â€”  inside looks like the desktop  â€”  small contrast
//   captured  â€”  inside is tinted glass         â€”  large contrast
// The panel's real screen rectangle, read from the OS.
//
// win.getBounds() after a reparent is Electron's own idea of the position and can
// disagree with where the composed window actually is (measured 179px off here),
// so the sample area is derived from EnumWindows + GetWindowRect instead.
function hostRectExternal() {
  const script = [
    'Add-Type -TypeDefinition \'using System;using System.Collections.Generic;using System.Runtime.InteropServices;',
    'public class E { public delegate bool P(IntPtr h, IntPtr l);',
    ' [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);',
    ' [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    ' [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    ' [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);',
    ' [StructLayout(LayoutKind.Sequential)] public struct RC { public int l,t,r,b; }',
    ' public static List<int[]> V(uint[] t) { var o = new List<int[]>();',
    '  EnumWindows((h,l) => { uint p; GetWindowThreadProcessId(h, out p);',
    '   if (Array.IndexOf(t, p) >= 0 && IsWindowVisible(h)) { RC r; GetWindowRect(h, out r);',
    '     var a = (r.r-r.l)*(r.b-r.t); if (a > 10000) o.Add(new int[]{ r.l, r.t, r.r-r.l, r.b-r.t, a }); }',
    '   return true; }, IntPtr.Zero); return o; } }\'',
    '$ps = @(Get-Process assistant,electron -EA SilentlyContinue)',
    "if ($ps.Count -eq 0) { 'none'; exit }",
    "$ids = New-Object 'uint32[]' $ps.Count",
    'for ($i=0; $i -lt $ps.Count; $i++) { $ids[$i] = [uint32]$ps[$i].Id }',
    '$best = $null; $area = 0',
    'foreach ($r in [E]::V($ids)) { if ($r[4] -gt $area) { $area = $r[4]; $best = $r } }',
    "if (-not $best) { 'none'; exit }",
    '"$($best[0]) $($best[1]) $($best[2]) $($best[3])"',
  ].join("\n");
  const file = path.join(require('os').tmpdir(), 'stealth-rect-' + process.pid + '.ps1');
  fs.writeFileSync(file, script);
  try {
    const out = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
      encoding: 'utf8', timeout: 12000, windowsHide: true,
    }).trim();
    if (!out || out === 'none') return null;
    const [x, y, w, h] = out.split(/\s+/).map(Number);
    return Number.isFinite(x) && w > 100 ? { x, y, w, h } : null;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

// A vertical strip across the panel's left border, in screen pixels.
//
// Mean luminance alone cannot separate the panel from the desktop on a dark
// theme: measured 31-38 in every phase. The panel's 1px light border is a step
// that exists only when the panel is drawn, so the strip is centred on it and the
// strongest column-to-column jump is the signal.
function sampleGeometry() {
  const b = hostRectExternal();
  if (!b) throw new Error('panel window not found for sampling');
  const half = 30;
  return {
    rect: {
      x: b.x - half,
      y: b.y + Math.round(b.h * 0.25),
      w: half * 2,
      h: Math.min(220, Math.round(b.h * 0.4)),
      borderX: half, // the border sits half way into the strip
    },
  };
}

// Strongest column-to-column brightness step in the strip, and where it is.
// A captured panel puts a light 1px border at a fixed column; an excluded capture
// only has whatever the desktop happens to contain.
async function borderStep(rect, borderX) {
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;",
    'public class B { [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);',
    ' [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d,int x,int y,int w,int h,IntPtr s,int sx,int sy,int r);',
    ' [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr d); }\'',
    `$bmp = New-Object System.Drawing.Bitmap ${rect.w}, ${rect.h}`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc(); $src = [B]::GetDC([IntPtr]::Zero)',
    `[void][B]::BitBlt($hdc, 0, 0, ${rect.w}, ${rect.h}, $src, ${rect.x}, ${rect.y}, 0x00CC0020)`,
    '[void][B]::ReleaseDC([IntPtr]::Zero, $src); $g.ReleaseHdc($hdc); $g.Dispose()',
    `for ($x = 0; $x -lt ${rect.w}; $x++) { $sum = 0.0`,
    `  for ($y = 0; $y -lt ${rect.h}; $y += 2) { $c = $bmp.GetPixel($x, $y); $sum += (0.2126*$c.R + 0.7152*$c.G + 0.0722*$c.B) }`,
    `  [math]::Round($sum / ${Math.ceil(rect.h / 2)}, 2) }`,
    '$bmp.Dispose()',
  ].join("\n");
  const file = path.join(require('os').tmpdir(), 'stealth-strip-' + process.pid + '.ps1');
  fs.writeFileSync(file, script);
  try {
    const out = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    }).trim();
    const cols = out.split(/\r?\n/).map(Number).filter((n) => Number.isFinite(n));
    if (cols.length < 10) return null;
    let best = 0, at = -1;
    for (let i = 1; i < cols.length; i++) {
      const d = Math.abs(cols[i] - cols[i - 1]);
      if (d > best) { best = d; at = i; }
    }
    // a step at the border is what the panel produces; noise is elsewhere
    const nearBorder = at >= borderX - 16 && at <= borderX + 16;
    return { step: best, at, nearBorder };
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

// median of a few attempts: a cursor or a repaint can land in one frame
async function stableStep(rect, borderX) {
  const v = [];
  for (let i = 0; i < 3; i++) {
    const r = await borderStep(rect, borderX);
    if (r) v.push(r);
    await delay(120);
  }
  if (!v.length) throw new Error('screen capture unavailable');
  v.sort((a, b) => b.step - a.step);
  return v[Math.floor(v.length / 2)];
}

// Capture the panel's own window source and ask whether the frame came back empty.
//
// This is the clean oracle the luminance attempts were looking for: a protected
// window is listed as a capture source but yields a 0x0 frame (WGC logs
// "GetFrame failed"), while an unprotected one yields real pixels. Measured:
// 0x0 protected vs 769x600 / 461400 px unprotected. It does not depend on what is
// on the desktop, so it cannot be confused by a bright or a dark page.
async function selfCaptureEmpty() {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 800, height: 600 } });
  const me = sources.find((s) => s.name === BLEND_TITLE) ||
    sources.find((s) => /assistant/i.test(s.name || ''));
  if (!me) return { listed: false, empty: null, size: null, names: sources.map((x) => x.name).slice(0, 12) };
  const size = me.thumbnail.getSize();
  return { listed: true, empty: size.width < 8 || size.height < 8, size };
}

async function stealthReport() {
  if (process.platform !== 'win32') return { ok: false, reason: 'Windows only' };
  if (!win || win.isDestroyed()) return { ok: false, reason: 'no window' };
  const nat = loadCloak();
  if (!nat || !nat.hostHandle) return { ok: false, reason: 'native addon unavailable (host shim off)' };
  const host = nat.hostHandle();
  if (!host) return { ok: false, reason: 'host window missing â€” class and flag are unprotected' };

  // Deliberately not short-circuited when stealth is off: the report is most
  // useful as a diagnosis of the bad case, so it runs and fails the capture row.

  const wasShown = isShown;
  if (!isShown) { win.showInactive(); isShown = true; }
  applyStealth(); // make sure the flag is asserted, not merely remembered
  await delay(600);

  const affinity = nat.getAffinity(host);
  const bounds = win.getBounds();

  // Reference: panel on screen with protection deliberately off â€” how much
  // contrast the panel itself creates against its surroundings.
  // Both measurements happen over the same grey backdrop, so the numbers are
  // comparable regardless of what is on the desktop.
  // Control: panel unprotected. If the frame is not empty here, the oracle is dead
  // and the row says nothing. Then the real measurement, protected.
  const wasStealth = cfg.stealth;
  cfg.stealth = false;
  applyStealth();
  await delay(700);
  const control = await selfCaptureEmpty();

  cfg.stealth = true;
  applyStealth();
  await delay(700);
  const probe = await selfCaptureEmpty();
  cfg.stealth = wasStealth;
  if (!wasShown) { win.hide(); isShown = false; }

  const conclusive = control.listed && control.empty === false;
  const excluded = conclusive && probe.empty === true;

  const mechanism = affinity === 17 ? 'excluded' : affinity === 1 ? 'monitor' : 'none';

  // Everything a detector can read, measured â€” not restated from settings. Each
  // row says what the machine actually reports right now, so a weak machine shows
  // the weak row instead of a blanket "hidden".
  const cls = nat.className(host);
  const ex = Number(nat.exStyle(host)) || 0;
  const title = nat.title(host);
  const chromiumChildren = nat.childChromiumClasses(host);
  const hasTool = (ex & 0x80) !== 0; // WS_EX_TOOLWINDOW â€”  no taskbar, no Alt+Tab
  const hasTop = (ex & 0x8) !== 0; // WS_EX_TOPMOST

  const tell = (id, label, status, detail) => ({ id, label, status, detail });
  const tells = [
    tell('capture', 'Pixels absent from a screen capture', 'info',
      'Chromium hides the app\'s own windows from its own window list, so this cannot be measured in-process. Definitive test: npm run capture-probe â€” protected returns a 0x0 empty frame, unprotected returns real pixels (measured 0x0 vs 769x600 / 461400 px).'),
    tell('affinity', 'Capture-exclusion flag', affinity === 17 ? 'pass' : affinity === 1 ? 'warn' : 'fail',
      affinity === 17 ? 'GetWindowDisplayAffinity reads 0x11 (WDA_EXCLUDEFROMCAPTURE).'
        : affinity === 1 ? 'Reads 0x1 (WDA_MONITOR): a black block, not a hidden window. Windows 10 2004+ is needed for 0x11.'
          : 'No flag set â€” the window is capturable.'),
    tell('class', 'Window class', /chrome/i.test(cls) ? 'fail' : 'pass',
      /chrome/i.test(cls) ? `Enumerated window is ${cls}, which says Electron.`
        : `Enumerated window is "${cls}", an innocuous shell-style class.`),
    tell('estyle', 'Not in the taskbar or Alt-Tab', hasTool ? 'pass' : 'warn',
      hasTool ? 'WS_EX_TOOLWINDOW set: no taskbar button and no Alt+Tab entry.'
        : 'WS_EX_TOOLWINDOW missing â€” the window shows up in Alt+Tab.'),
    tell('topmost', 'Stays above other windows', hasTop ? 'pass' : 'warn',
      hasTop ? 'WS_EX_TOPMOST set.' : 'Not topmost; the window can be covered.'),
    tell('title', 'Window title', title ? 'warn' : 'pass',
      title ? `Title reads "${title}" â€” a word, not a random hex string, but it does name the tool.`
        : 'No title at all, so the enumeration shows nothing to read.'),
    tell('children', 'Chromium child windows', chromiumChildren === 0 ? 'pass' : 'warn',
      chromiumChildren === 0 ? 'No Chromium-classed children under the host.'
        : `${chromiumChildren} child window(s) still use a Chrome_WidgetWin class â€” only visible if a detector walks children.`),
    tell('uia', 'Accessibility tree', app.accessibilitySupportEnabled ? 'warn' : 'pass',
      app.accessibilitySupportEnabled ? 'UIA is enabled; the panel text can be walked by an accessibility tool.'
        : 'Chromium accessibility is off, so the UIA tree is minimal.'),
    tell('devtools', 'DevTools port file', fs.existsSync(path.join(app.getPath('userData'), 'DevToolsActivePort')) ? 'warn' : 'pass',
      fs.existsSync(path.join(app.getPath('userData'), 'DevToolsActivePort')) ? 'DevToolsActivePort exists next to the profile.'
        : 'No DevToolsActivePort file left in the profile.'),
    tell('process', 'Process identity', 'info',
      `${path.basename(process.execPath)} â€” visible in any process list; the mirror path and version resource are what a scraper reads.`),
  ];

  const fails = tells.filter((t) => t.status === 'fail').length;
  const warns = tells.filter((t) => t.status === 'warn').length;
  const ok = fails === 0;
  return {
    ok,
    fails,
    warns,
    tells,
    // kept for the older single-check callers
    pixelExcluded: excluded,
    affinity,
    mechanism,
    bounds,
    probe: { control, probe },
    affinityAfter: probe.empty === null ? null : nat.getAffinity(host),
    verdict: ok
      ? `PASS â€” ${tells.length - warns} of ${tells.length} tells clean${warns ? `, ${warns} caveat(s)` : ''}. A screen capture returns your screen without this panel.`
      : `FAIL â€” ${fails} tell(s) let a detector notice the panel.`,
  };
}

// ---------- meeting detection ----------
// The overlay is most useful at the moment a call starts, and that is exactly the
// moment the user is joining rather than looking at the panel. Watch the process
// list for the usual clients (and browser tabs titled like a meeting) and say so
// once per app per run. Detection only â€” it never starts the mic behind your back.
const MEETING_PROCS = ['zoom', 'teams', 'ms-teams', 'webex', 'webexmta', 'skype', 'discord'];
const MEETING_TITLE = /meet|zoom|teams|webex/i;
const meetingsSeen = new Set();

function detectMeeting() {
  try {
    const { execFileSync } = require('child_process');
    const refs = MEETING_PROCS.map((n) => `$_.ProcessName -eq '${n}'`).join(' -or ');
    const ps = [
      `$p = Get-Process -ErrorAction SilentlyContinue | Where-Object { ${refs} -or (($_.ProcessName -eq 'chrome' -or $_.ProcessName -eq 'msedge') -and $_.MainWindowTitle -match '${MEETING_TITLE.source}') } | Select-Object -First 1`,
      `if ($p) { $p.ProcessName }`,
    ].join('; ');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    }).trim();
    const name = String(out || '').split(/\r?\n/)[0].trim();
    if (!name || meetingsSeen.has(name)) return;
    meetingsSeen.add(name);
    if (win && !win.isDestroyed()) {
      win.webContents.send('notice', {
        level: 'info',
        message: `${name} is running â€” Ctrl+Shift+L starts listening (pick "Both" to hear the interviewer too).`,
      });
    }
  } catch {}
}

function watchForMeetings() {
  if (process.platform !== 'win32') return;
  const t = setInterval(detectMeeting, 20000);
  if (t.unref) t.unref();
  setTimeout(detectMeeting, 6000); // after the first paint, not before it
}

// ---------- auto-update (GitHub Releases via electron-updater) ----------
// Checks quietly in the background, then downloads and stages a new version so
// the next quit installs it. Never restarts on its own â€” a restart mid-meeting
// would be worse than running one version behind, so updating is user-driven.
let updater = null;

function updaterStatus(message, level) {
  if (win && !win.isDestroyed()) win.webContents.send('notice', { level: level || 'info', message });
}

function setupUpdater() {
  if (!app.isPackaged || cfg.updates === false) return;
  try {
    // required inside try: a dev checkout has no electron-updater in the app dir
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('update-available', (i) => updaterStatus(`Downloading update ${i.version}â¬¦`));
    autoUpdater.on('update-not-available', () => updaterStatus('Glance AI is up to date'));
    autoUpdater.on('update-downloaded', (i) =>
      updaterStatus(`Update ${i.version} ready â€” restart to apply`, 'info'));
    autoUpdater.on('error', (e) => updaterStatus('Update check failed: ' + String(e.message).slice(0, 90), 'warn'));

    // wait a little after boot so an update check never delays the first paint
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000);
  } catch {}
}

// ---------- host blend: hide the class name and the affinity flag ----------
// A detector that enumerates top-level windows finds the overlay, reads its class
// (Chrome_WidgetWin_1 â€”  "Electron") and GetWindowDisplayAffinity (0x11 â€” 
// "deliberately hidden"). Reparenting the window under an innocuous host means
// only the host is enumerated: our class, and no affinity flag at all.
// The child keeps the exclusion, so capture is unaffected.
let hostTimer = null;

function setupHostBlend() {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) { mlog('host: no win'); return; }
  if (cfg.blendWindow === false) { mlog('host: disabled by config'); return; }
  const nat = loadCloak();
  if (!nat || !nat.attachHost) { mlog('host: addon missing'); return; }
  try {
    const h32 = win.getNativeWindowHandle().readUInt32LE(0);
    const r = nat.attachHost(h32);
    mlog(`host: attach hwnd=${h32} -> ${JSON.stringify(r)}`);
    if (!r || !r.ok) return;
    // Electron still moves the window with screen coordinates; the addon turns
    // each such move into the host's new position. 30 ms tracks a drag closely
    // without burning CPU on an idle window.
    hostTimer = setInterval(() => {
      try {
        if (win && !win.isDestroyed()) nat.syncHost();
      } catch {}
    }, 30);
    if (hostTimer.unref) hostTimer.unref();
    applyStealth(); // move the exclusion flag onto the host
  } catch {}
}

function teardownHostBlend() {
  if (hostTimer) { clearInterval(hostTimer); hostTimer = null; }
  const nat = loadCloak();
  if (nat && nat.detachHost) { try { nat.detachHost(); } catch {} }
}

// ---------- LLM ----------
// Chat URL for a provider entry. Trailing slashes are stripped so a base URL
// saved with one does not produce "//chat/completions".
function chatUrl(provider) {
  return provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

function providerKey(kind = 'chat') {
  if (kind === 'transcribe') {
    // A separate base URL means a separate provider: never send the chat provider's
    // key to it. This fallback leaked the primary credential across providers.
    if (cfg.transcribeBaseUrl && !cfg.transcribeApiKey) {
      throw new Error('Transcription base URL is set but its key is empty â€” add the transcription key or clear that base URL.');
    }
    return cfg.transcribeApiKey || cfg.apiKey;
  }
  if (kind === 'tts') {
    if (cfg.ttsBaseUrl && !cfg.ttsApiKey) {
      throw new Error('TTS base URL is set but its key is empty â€” add the TTS key or clear that base URL.');
    }
    return cfg.ttsApiKey || cfg.apiKey;
  }
  return cfg.apiKey;
}

function requireKey(kind = 'chat') {
  const key = providerKey(kind);
  if (!key) {
    throw new Error(
      kind === 'chat'
        ? 'No API key set. Open Settings (gear) and add one.'
        : `No ${kind} key: set one in Settings, or add a main key to fall back to.`,
    );
  }
  // Callers do `const key = requireKey('transcribe')`. This used to return
  // nothing, so every transcription and TTS request was sent with
  // "Authorization: Bearer undefined" and failed with 401.
  return key;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Answer shapes. The overlay is read at a glance mid-sentence, so "how to
// answer" is a bigger lever than any other setting; each style is one short
// instruction, and unknown values fall through to smart.
const STYLE_PROMPTS = {
  smart:
    'This is a live call, not a chatbot. Pick the shortest format that answers the moment. No greeting, no "let me", no offer to help further. Speech-friendly sentences; code only when code was asked for.',
  brief: 'Answer in one or two sentences at most. Just the answer, no preamble and no supporting detail.',
  star:
    'For behavioural questions, answer as STAR in four labelled lines â€” Situation, Task, Action, Result â€” kept to one line each. Preference for concrete numbers and outcomes.',
  bullets: 'Answer as at most four short bullet points. No introductory sentence.',
  code: 'Lead with the working code in one block, then at most two lines noting the key choice or the gotcha. Assume the user will paste it.',
  detail:
    'Answer thoroughly: the direct answer first, then the reasoning, then any trade-offs. Use headings when the answer has distinct parts.',
};

function styleInstruction(style) {
  // smartMode predates answerStyle and meant exactly the `smart` style; honour it
  // for profiles saved before the style setting existed.
  const key = style || (cfg.smartMode === false ? 'detail' : 'smart');
  return STYLE_PROMPTS[key] || STYLE_PROMPTS.smart;
}

async function streamChat(event, { id, messages, withScreen, shots, memory, images }) {
  requireKey();
  const send = (ch, payload) => !event.sender.isDestroyed() && event.sender.send(ch, { id, ...payload });

  // personalization: role + resume ground every answer; answer language pins output
  let sys = cfg.systemPrompt;
  sys += `\n\n${styleInstruction(cfg.answerStyle)}`;
  if (cfg.targetRole) sys += `\n\nThe user is interviewing for: ${cfg.targetRole}. Ground every answer in that context.`;
  if (cfg.resume) sys += `\n\nUser background (use it; never invent experience):\n${cfg.resume.slice(0, 4000)}`;
  if (cfg.answerLang && cfg.answerLang !== 'auto') sys += `\n\nAlways write the answer in ${cfg.answerLang}.`;

  // Long-term memory: durable notes the user saved (or the assistant distilled).
  // Injected as background context so a brand-new chat still answers with what
  // was learned in previous sessions, without replaying the raw history.
  if (Array.isArray(memory) && memory.length) {
    const digest = memory
      .slice(-40)
      .map((m) => '- [' + (m.kind || 'note') + '] ' + String(m.text || '').slice(0, 400))
      .join('\n');
    if (digest.trim()) {
      sys += `\n\nSaved memory from earlier sessions (treat as user-provided background; prefer it over guessing, but never invent beyond it):\n${digest}`;
    }
  }

  // Local knowledge: only the blocks that overlap the question ride along, so a
  // large cheat sheet costs almost nothing per turn and the model gets the
  // user's own facts instead of guessing.
  if (cfg.knowledge) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const relevant = rankNotes(cfg.knowledge, lastUser ? String(lastUser.content || '') : '');
    if (relevant) {
      sys += `\n\nNotes from the user's own knowledge base â€” authoritative, prefer them over general knowledge:\n${relevant}`;
    }
  }

  let msgs = [{ role: 'system', content: sys }, ...messages];

  // context guard: budget from settings, minus the vision cost of the frames we are about to attach.
  // supports 1M-class windows; there is no true "unlimited" â€” set it to your model's real limit.
  const budget = Math.min(2000000, Math.max(4000, Number(cfg.contextTokens) || 32000));
  // reserve the output the request is about to ask for: input + frames + maxOut must
  // fit inside the window, or the guard trims 1 024 while the request claims 8 192
  const maxOut = Math.min(8192, Math.floor(budget * 0.3));

  // Pre-collected screenshots the user captured with the Capture button win over
  // a fresh grab: they may have scrolled between shots, so their order matters.
  const preShots = Array.isArray(images) ? images.filter((x) => x && x.b64).slice(0, 5) : [];
  if (withScreen || preShots.length) {
    let frames;
    if (preShots.length) {
      frames = preShots.map((x) => ({
        b64: x.b64,
        tokens: Number(x.tokens) || visionTokens(1280, 720),
      }));
    } else {
      // multi-shot: up to 5 frames spaced ~1.2s apart so the user can scroll
      // long tasks; each grab costs a frame, so 5 is the ceiling
      const n = Math.min(5, Math.max(1, Number(shots) || 1));
      frames = [];
      for (let i = 0; i < n; i++) {
        frames.push(await captureScreen());
        if (i < n - 1) await delay(1200);
      }
    }
    // Decide what actually fits before trimming: on a 4kâ€”8k window the frames plus
    // the output reserve exceed the whole budget, and a 2 000-token text floor then
    // overshoots it. fitFrames drops the last frames first, then the only one.
    const fit = fitFrames(frames, budget, maxOut);
    fitContext(msgs, fit.textBudget);
    if (fit.frames.length) {
      const last = msgs[msgs.length - 1];
      msgs[msgs.length - 1] = {
        role: last.role,
        content: [
          { type: 'text', text: last.content },
          ...fit.frames.map((f) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.b64}` } })),
        ],
      };
      // OCR text travels with the frames: exact characters beat pixels for code,
      // error messages, forms and tables the vision model may misread
      const ocr = fit.frames.map((f) => (f.text || '').trim()).filter(Boolean);
      if (ocr.length) {
        const combined = ocr.map((t, i) => `--- shot ${i + 1} ---\n${t}`).join('\n\n').slice(0, 12000);
        msgs[msgs.length - 1].content.push({
          type: 'text',
          text:
            'Text extracted locally by OCR from the screenshot(s) â€” authoritative for code, ' +
            'numbers, labels and error messages; ignore OCR noise if it contradicts the image:\n\n' + combined,
        });
      }
      send('shot', { b64: fit.frames[0].b64, frames: fit.frames.length });
    }
  } else {
    fitContext(msgs, Math.max(512, budget - maxOut - 512));
  }

  currentAbort?.abort();
  const ctrl = new AbortController();
  currentAbort = ctrl;

  // stall watchdog: slow first token is fine (reasoning/local models); a stalled stream is not
  let lastChunkAt = Date.now();
  let gotFirstByte = false;
  let emitted = false; // the renderer has painted at least one chunk of this attempt
  let timedOut = false; // the watchdog aborted, not the user
  const watchdog = setInterval(() => {
    const limit = gotFirstByte ? 30_000 : 120_000;
    if (Date.now() - lastChunkAt > limit) {
      timedOut = true;
      ctrl.abort();
    }
  }, 5000);

  // Providers, primary first. The backup is only reachable after the primary
  // runs out of retries (or hard-fails), so it never doubles normal traffic.
  // Each provider keeps its own origin and key: a key is never sent to an
  // origin it does not belong to.
  const providers = [{ baseUrl: cfg.baseUrl, key: cfg.apiKey, model: cfg.chatModel, label: 'primary' }];
  if (cfg.fallbackBaseUrl && cfg.fallbackApiKey) {
    providers.push({
      baseUrl: cfg.fallbackBaseUrl,
      key: cfg.fallbackApiKey,
      model: cfg.fallbackChatModel || cfg.chatModel,
      label: 'backup',
    });
  }

  // retry with exponential backoff, only on retryable failures (429/5xx/network)
  const maxRetries = 3;
  try {
    for (let p = 0; p < providers.length; p++) {
      const provider = providers[p];
      const isLastProvider = p === providers.length - 1;
      let attempt = 0;
      while (attempt <= maxRetries) {
        try {
          const res = await fetch(chatUrl(provider), {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` },
            body: JSON.stringify({ model: provider.model, messages: msgs, stream: true, max_tokens: maxOut }),
          });

          if (res.status === 429 || res.status === 503) {
            if (attempt >= maxRetries) throw new Error(`Rate limit / service unavailable after ${maxRetries} retries`);
            const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
            // Cap the server's hint: three uncapped waits can hold the overlay for
            // minutes, and anything past the watchdog's first-token window would be
            // aborted mid-backoff and reported as a stall.
            const wait = retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : Math.min(1000 * 2 ** attempt, 8000);
            await delay(wait);
            attempt++;
            continue;
        }

          if (!res.ok) {
            const errText = await res.text();
            const e = new Error(`API ${res.status}: ${errText.slice(0, 400)}`);
            e.status = res.status;
            throw e;
          }
          gotFirstByte = true;

          const ctype = res.headers.get('content-type') || '';
          if (!ctype.includes('event-stream')) {
            // provider ignored stream:true â€” read the whole JSON body instead
            const json = await res.json();
            const text = json.choices?.[0]?.message?.content || '';
            if (text) send('chunk', { text });
            send('done', {});
            return;
          }

          const decoder = new TextDecoder();
          let buf = '';
          // One parser for whole lines and for the unterminated tail, so the last
          // token of a stream is not dropped when the provider omits the final \n.
          const consume = (line) => {
            const t = line.trim();
            if (!t) return;
            // tolerate optional spaces after "data:" and stray CRLF variants
            const m = t.match(/^data:\s*(.*)$/);
            if (!m) return;
            const data = m[1].trim();
            if (!data || data === '[DONE]') return;
            try {
              const parsed = JSON.parse(data);
              // reasoning models (deepseek-r1-style) stream reasoning_content first
              const choice = parsed.choices?.[0] || {};
              const reasoning = choice.delta?.reasoning_content ?? choice.message?.reasoning_content ?? '';
              const content = choice.delta?.content ?? choice.message?.content ?? '';
              if (reasoning) {
                lastChunkAt = Date.now();
                emitted = true;
                send('reasoning', { text: reasoning });
              }
              if (content) {
                lastChunkAt = Date.now();
                emitted = true;
                send('chunk', { text: content });
              }
            } catch {}
          };
          for await (const part of res.body) {
            buf += decoder.decode(part, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              consume(buf.slice(0, nl));
              buf = buf.slice(nl + 1);
            }
          }
          buf += decoder.decode(); // flush a multi-byte character split across chunks
          consume(buf);
          send('done', {});
          return;
        } catch (err) {
          if (err.name === 'AbortError' || timedOut) throw err;
          const status = err.status || 0;
          const retryable =
            status === 429 || status === 503 || status >= 500 ||
            /fetch|network|ECONN|ETIMEDOUT|socket/i.test(err.message || '');
          const exhausted = !retryable || attempt >= maxRetries;
          if (exhausted && !isLastProvider) {
            // Hand over to the backup endpoint. Anything already painted belongs to
            // the failed provider and is dropped so the answer is not two halves.
            if (emitted) send('reset', {});
            emitted = false;
            gotFirstByte = false;
            lastChunkAt = Date.now(); // the watchdog clock restarts with the new origin
            send('notice', {
              level: 'warn',
              message: `Provider failed (${String(err.message || err).slice(0, 120)}) â€” retrying on the backup endpoint.`,
            });
            break;
          }
          if (exhausted) throw err;
          // A retry re-sends the completion from its first token. If part of the failed
          // attempt is already painted, tell the renderer to drop it â€” otherwise the
          // answer reads as the partial reply followed by the full one.
          if (emitted) {
            send('reset', {});
            emitted = false;
            gotFirstByte = false;
          }
          lastChunkAt = Date.now(); // backoff is not a stalled stream
          await delay(Math.min(1000 * 2 ** attempt, 8000));
          attempt++;
        }
      }
    }
  } catch (err) {
    // A watchdog abort used to disappear: the renderer never received done or
    // error, so the Stop button stayed up and Copilot refused every later question.
    if (timedOut) {
      throw new Error(
        'Provider stopped responding â€” no output for 30 s (120 s allowed for the first token). Request cancelled.',
      );
    }
    throw err;
  } finally {
    clearInterval(watchdog);
  }
}

async function transcribe(_e, { data, mime }) {
  requireKey('transcribe');
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm';
  const base = (cfg.transcribeBaseUrl || cfg.baseUrl).replace(/\/+$/, '');
  const key = requireKey('transcribe');
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(data)], { type: mime }), `audio.${ext}`);
  form.append('model', cfg.transcribeModel);

  // retry transcription on transient failures only (429 / 5xx / network)
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(base + '/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      if (!res.ok) {
        const errText = await res.text();
        const e = new Error(`Transcribe ${res.status}: ${errText.slice(0, 300)}`);
        e.status = res.status; // so the catch can tell a 500 from a 400
        throw e;
      }
      return (await res.json()).text || '';
    } catch (err) {
      const retryable =
        err.status === 429 || err.status >= 500 || /fetch|network|ECONN|ETIMEDOUT|socket/i.test(err.message || '');
      if (i < 2 && retryable) {
        await delay(1000 * (i + 1));
        continue;
      }
      throw err;
    }
  }
}

// TTS: returns base64 mp3 for the renderer to play
async function speak(_e, { text }) {
  requireKey('tts');
  const base = (cfg.ttsBaseUrl || cfg.baseUrl).replace(/\/+$/, '');
  const key = requireKey('tts');
  const res = await fetch(base + '/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: cfg.ttsModel || 'tts-1', voice: cfg.ttsVoice || 'alloy', input: String(text).slice(0, 4000), response_format: 'mp3' }),
    signal: AbortSignal.timeout(20000), // a hung TTS endpoint must not block this handler forever
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)} â€” this provider may not support /audio/speech`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

// ---------- conversation state ----------
const statePath = () => path.join(app.getPath('userData'), 'state.json');

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (raw && raw.enc) {
      // DPAPI-encrypted at rest â€” without the blob, no history on disk
      const txt = decryptBlob(raw.enc);
      return txt ? JSON.parse(txt) : { history: [], transcript: '' };
    }
    return { history: raw.history || [], transcript: raw.transcript || '' }; // legacy plaintext
  } catch {
    return { history: [], transcript: '' };
  }
}

function saveState(next) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  const enc = encryptBlob(JSON.stringify(next));
  if (!enc) return; // no DPAPI available => nothing on disk (fail closed)
  writeFileAtomic(statePath(), JSON.stringify({ enc }));
}

function encryptBlob(str) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(str).toString('base64');
    }
  } catch {}
  return null;
}

function decryptBlob(enc) {
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null;
  }
}

// ---------- app ----------
// Stale lock cleanup: a previous crash/kill can leave a 0-byte lockfile that
// makes requestSingleInstanceLock() return false forever.
try {
  if (process.platform === 'win32') {
    const __name = app.getName();
    const __lockDir = path.join(require('os').homedir(), 'AppData', 'Roaming', __name);
    const __lockFile = path.join(__lockDir, 'lockfile');
    // A live instance writes its pid into the lockfile, so an empty one is stale
    // and makes requestSingleInstanceLock() false forever. The old guard counted
    // processes by image name — fine while the app was called "assistant", wrong
    // now that it is "svchost" (dozens of Windows svchosts always match).
    if (fs.existsSync(__lockFile) && fs.statSync(__lockFile).size === 0) {
      fs.unlinkSync(__lockFile);
    }
  }
} catch {}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.showInactive();
      win.focus();
      isShown = true;
    }
  });
}

// GPU stealth: disable the hardware GPU process entirely so Chromium renders
// via its software rasterizer (SwiftShader) instead of creating a
// D3D11On12Device / ANGLE swap chain that a GPU debugger would fingerprint.
// This removes the `--type=gpu-process` child and the D3D11 device usage.
// --disable-gpu-sandbox: prevents a sandboxed GPU helper from spawning.
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('use-gl', 'swiftshader');
// An overlay is covered by whatever is behind/over it all the time. Without these
// Chromium throttles a fully occluded window, so the panel can look frozen or
// repaint late exactly when a call is on top of it.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Serve vendored MediaPipe assets over a custom scheme so the renderer can
// fetch()/XHR them. Chromium refuses cross-origin fetch/XHR on file:// into an
// asar archive, which broke WASM loading. The app is fully offline, so this is
// a private, asar-only reader with no egress and no disk writes.
const MP_SCHEME = 'mplocal';
const MP_ASSET_DIR = path.join(__dirname, 'renderer', 'vendor', 'mediapipe');
// registerSchemesAsPrivileged must run before the app is ready (it must be
// called once, before protocol registration); handle may be registered any time
// before first use. Both are top-level here, ahead of app.whenReady below.
protocol.registerSchemesAsPrivileged([{ scheme: MP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
// handle() requires the app to be ready (it touches the session), so the
// registration is deferred into the whenReady block below; only the scheme
// privilege registration may precede ready.
const MP_ASSET_DIR_ABS = path.resolve(MP_ASSET_DIR);
const mpRequestHandler = (req) => {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url).pathname);
  } catch {
    return new Response('bad request', { status: 400 });
  }
  // /<file> -> <MP_ASSET_DIR>/<file>; reject anything that escapes the dir.
  if (!p.startsWith('/')) return new Response('not found', { status: 404 });
  const rel = p.slice(1).replace(/^\/+/, '');
  const full = path.resolve(MP_ASSET_DIR_ABS, '.' + path.posix.join('/', rel));
  if (full !== MP_ASSET_DIR_ABS && !full.startsWith(MP_ASSET_DIR_ABS + path.sep)) {
    return new Response('forbidden', { status: 403 });
  }
  let data, type = 'application/octet-stream';
  try {
    data = fs.readFileSync(full);
    const lower = full.toLowerCase();
    if (lower.endsWith('.wasm')) type = 'application/wasm';
    else if (lower.endsWith('.js') || lower.endsWith('.mjs')) type = 'text/javascript';
    else if (lower.endsWith('.task') || lower.endsWith('.tflite')) type = 'application/octet-stream';
  } catch {
    return new Response('not found', { status: 404 });
  }
  return new Response(data, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } });
};

// TEMP: main-side trace log (renderer-diag.log is only reachable after
// createWindow; this one catches failures before that point)
const MAIN_LOG = path.join(app.getPath('appData'), '.assistant-trace.log');
const mlog = (line) => {
  try {
    fs.appendFileSync(MAIN_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
};
process.on('uncaughtException', (e) => mlog(`uncaughtException: ${e.stack || e}`));
process.on('unhandledRejection', (r) => mlog(`unhandledRejection: ${r && (r.stack || r.message || r)}`));
mlog(`main module top-level reached, logPath=${MAIN_LOG} appData=${app.getPath('appData')}`);
app.whenReady().then(() => {
  mlog(`whenReady fired, singleInstance=${singleInstance}`);
  // The losing instance must not build a window while quit() is still tearing it
  // down: whenReady used to be registered outside the lock, so a rapid second
  // launch could add a second overlay before exiting.
  if (!singleInstance) return;
  protocol.handle(MP_SCHEME, mpRequestHandler);
  // Point Chromium's per-app profile folder (userData) at a path that does not
  // contain identifying strings. The default is %APPDATA%\<appName>, which
  // reads as the app's name in every file listing. We keep it under APPDATA so
  // the wipe-helper path math (sibling of userData) still works, and the
  // folder name blends in with the rest of the per-user app state.
  if (process.platform === 'win32') {
    try {
      // one-time migration across every previous name, oldest first so the most
      // recent profile wins. Chromium pre-creates the new folder, so copy missing
      // FILES rather than gating on the folder not existing.
      const LEGACY_PROFILES = ['wshx-host', 'assistant', 'Glance AI', 'glance-assistant'];
      for (const legacy of LEGACY_PROFILES) {
        const legacyProfile = path.join(app.getPath('appData'), legacy);
        for (const f of ['config.json', 'state.json', 'bounds.json']) {
          const from = path.join(legacyProfile, f);
          const to = path.join(PROFILE_DIR, f);
          if (fs.existsSync(from) && !fs.existsSync(to)) {
            try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); fs.copyFileSync(from, to); } catch {}
          }
        }
        const legacySessions = path.join(legacyProfile, 'sessions');
        const newSessions = path.join(PROFILE_DIR, 'sessions');
        if (fs.existsSync(legacySessions) && !fs.existsSync(newSessions)) {
          try { fs.cpSync(legacySessions, newSessions, { recursive: true }); } catch {}
        }
      }
      app.setPath('userData', PROFILE_DIR);
      // the profile is a plain "%APPDATA%\<name>" folder and shows in any listing;
      // flag it system+hidden like the install trees
      try {
        require('child_process').execFileSync('attrib', ['+s', '+h', PROFILE_DIR], { stdio: 'ignore', timeout: 3000 });
      } catch {}
    } catch {}
  }
  // a wipe was requested earlier but never completed (the cleanup helper can die
  // alongside the app): delete the data files now and finish on this session's exit
  // carry a pending wipe across the profile rename
  try {
      const legacyMarker = path.join(app.getPath('appData'), 'wshx-host-pending');
      const legacyMarker2 = path.join(app.getPath('appData'), 'svchost-pending');
      if (!fs.existsSync(WIPE_MARKER)) {
        if (fs.existsSync(legacyMarker2)) fs.renameSync(legacyMarker2, WIPE_MARKER);
        else if (fs.existsSync(legacyMarker)) fs.renameSync(legacyMarker, WIPE_MARKER);
      }
  } catch {}
  if (fs.existsSync(wipeMarkerPath())) {
    deleteWipeTargets();
    wipeOnQuit = true; // refuse state writes until the pending wipe completes
    pendingWipe = true;
  }
  loadConfig();
  // Migrate once, and only when a legacy plaintext key actually exists. The old
  // unconditional saveConfig({}) rewrote the file on every launch and erased any
  // blob it had just failed to decrypt (V-05) â€” and resurrected config.json on
  // the pending-wipe path, right after the wipe had deleted it.
  if (legacyPlaintextKey || legacyPlaintextPersonal || legacyConfigFormat) saveConfig({});

  // A debugging launch leaves DevToolsActivePort (a port number and a UUID) in
  // the profile â€” two files' worth of "this is Chromium". Removed on quit as
  // well, so a packaged install leaves no trace once it exits.
  removeDevtoolsPort();

  // Autostart: a real svchost is always running, so an install that only appears
  // when you launch it is itself a tell. Opt-in (packaged builds only) because
  // a dev checkout autostarting from node_modules is noisier than it is stealthy.
  //
  // The installer already writes the machine-wide Run value. Adding the per-user
  // one on top puts a second row in Task Manager's Startup tab and starts a
  // duplicate at every logon (it loses the singleton and exits), so: machine-wide
  // wins, and a per-user value left over from an older build is removed.
  const RUN_KEY = 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const HKCU_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  if (app.isPackaged) {
    const { execFileSync } = require('child_process');
    const hasRun = (key, name) => {
      try {
        execFileSync('reg', ['query', key, '/v', name], { stdio: 'ignore', timeout: 4000 });
        return true;
      } catch {
        return false;
      }
    };
    // The installer registers a logon task now; a Run value only exists as its
    // fallback. Anything left over (older builds wrote both) is removed so the
    // app cannot appear twice in Task Manager's Startup tab.
    const userEntry = hasRun(HKCU_RUN_KEY, 'Glance AI');
    let taskEntry = false;
    try {
      execFileSync('schtasks', ['/query', '/tn', 'svchost'], { stdio: 'ignore', timeout: 4000 });
      taskEntry = true;
    } catch {}
    const machineRun = hasRun(RUN_KEY, 'svchost');
    if (taskEntry || machineRun) {
      if (userEntry) {
        try {
          app.setLoginItemSettings({ openAtLogin: false, name: 'Glance AI' });
        } catch {}
      }
    } else if (!userEntry) {
      // nothing at all (portable copy, uninstalled mirror): keep a user value
      try {
        app.setLoginItemSettings({ openAtLogin: true, args: ['--autostart'], name: 'Glance AI' });
      } catch {}
    }
  }

  // stealth: shrink the accessibility tree surface (UIA/MSAA see far less of the overlay)
  try { app.accessibilitySupportEnabled = false; } catch {}

  setupUpdater();
  watchForMeetings();

  // stealth: AUMID grouping hint so the shell/taskbar associates the window
  // with a familiar Windows component. This does NOT rename the process or
  // change what Task Manager's process column shows (that comes from the exe
  // version resource). Combined with process.title blending below.
  if (process.platform === 'win32') {
    try {
      app.setAppUserModelId('Microsoft.Windows.ShellExperienceHost');
    } catch {}
    // Blend the whole process tree's window titles into a generic shell name so
    // Task Manager's per-process view + EnumWindows tools can't correlate a
    // family of windows. Re-run periodically to catch late-spawned
    // GPU/renderer helpers.
    blendProcessTitles();
    // Hide the chrome_elf.dll integrity checker from directory listings if present.
    if (ensureHideHelper()) {
      try {
        const installDir = path.dirname(process.execPath);
        require('child_process').execFileSync(HIDE_HELPER, ['hide-chrome-elf', installDir], { stdio: 'ignore', timeout: 3000 });
      } catch {}
    }
    setInterval(() => {
      try {
        if (app.isReady()) blendProcessTitles();
      } catch {}
    }, 5000).unref();
    // The capture exclusion can be dropped without anyone noticing: a hide/show
    // cycle, a DWM reset, a renderer restart, or another process calling
    // SetWindowDisplayAffinity on the window. Re-assert it on a slow timer while
    // the panel is on screen, so a running screen share never silently starts
    // showing it. applyStealth() is the same call the show path already uses.
    setInterval(() => {
      try {
        if (app.isReady() && isShown && cfg.stealth && win && !win.isDestroyed()) applyStealth();
      } catch {}
    }, 15000).unref();
  }

  // The renderer is sandboxed and has no permission prompt UI of its own, so
  // getUserMedia/getDisplayMedia are denied unless the session grants them.
  // Without this the Listen button fails silently with NotAllowedError.
  const ALLOWED_PERMISSIONS = new Set([
    'media', 'display-capture', 'audioCapture', 'videoCapture',
    // the Copy button writes the answer to the OS clipboard
    'clipboard-sanitized-write', 'clipboard-read',
  ]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  );
  // lets the renderer capture system audio (WASAPI loopback) via getDisplayMedia,
  // honouring the display picker instead of always grabbing display 0
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const wantWindow = cfg.captureDisplay && String(cfg.captureDisplay).startsWith('window:')
      ? String(cfg.captureDisplay).slice(7)
      : '';
    if (wantWindow) {
      const wins = await desktopCapturer.getSources({ types: ['window'] });
      const src = wins.find((s) => String(s.id) === wantWindow) || wins[0];
      if (src) return cb({ video: src, audio: 'loopback' });
    }
    const want = pickDisplay();
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const src = sources.find((s) => String(s.display_id) === String(want.id)) || sources[0];
    cb({ video: src, audio: 'loopback' });
  });

  handle('config:get', () => publicConfig());
  // model discovery: renderer passes the (possibly unsaved) base URL + key it just typed
  handle('models:list', async (_e, { baseUrl, apiKey, purpose }) => {
    try {
      const base = (baseUrl || cfg.baseUrl).replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(base)) return { error: 'Base URL must start with http:// or https://' };
      // A renderer-supplied URL may only borrow a stored key when it points at a
      // provider the user already configured, or at a local model server. Anything
      // else must bring its own key, so this handler can never exfiltrate one.
      let target;
      try {
        target = new URL(base);
      } catch {
        return { error: 'Base URL is not a valid URL' };
      }
      const configured = [cfg.baseUrl, cfg.transcribeBaseUrl, cfg.ttsBaseUrl]
        .filter(Boolean)
        .map((u) => {
          try {
            return new URL(u).origin;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
        target.hostname,
      );
      // A separate audio provider is a separate trust domain: never lend it the chat
      // key. providerKey() refuses that combination on the request path; model
      // discovery must obey the same rule (this was the remaining cross-provider leak).
      const originOf = (u) => {
        try {
          return u ? new URL(u).origin : null;
        } catch {
          return null;
        }
      };
      const chatOrigin = originOf(cfg.baseUrl);
      const foreignAudio =
        !isLocal &&
        target.origin !== chatOrigin &&
        [originOf(cfg.transcribeBaseUrl), originOf(cfg.ttsBaseUrl)].includes(target.origin);
      const mayUseStoredKey = !foreignAudio && (configured.includes(target.origin) || isLocal);
      const storedKey =
      purpose === 'transcribe' ? cfg.transcribeApiKey || cfg.apiKey :
      purpose === 'tts' ? cfg.ttsApiKey || cfg.apiKey :
      cfg.apiKey;
      const key = apiKey || (mayUseStoredKey ? storedKey : '');
      if (!key) {
        return {
          error: foreignAudio
            ? 'That host is a separate audio provider â€” add its own key in Settings; the chat key is not sent to it.'
            : 'No key for that host â€” add its key in Settings first.',
        };
      }
      const res = await fetch(base + '/models', {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { error: `Models ${res.status}` }; // never echo the provider body back
      const json = await res.json();
      const ids = (json.data || []).map((m) => m.id).filter(Boolean).sort().slice(0, 500);
      return { models: ids };
    } catch (err) {
      return { error: err.name === 'TimeoutError' ? 'Provider did not answer in 5 s' : err.message };
    }
  });
  handle('config:set', (_e, next) => {
    // a settings save can flip stealthDeep â€” re-apply the native state so the
    // toggle doesn't wait for the next show. soft: never cloak a window the
    // user is looking at (see applyDeepStealth).
    if (Object.prototype.hasOwnProperty.call(next, 'stealthDeep')) {
      applyDeepStealth(Boolean(next.stealthDeep), null, true);
    }
    if (Object.prototype.hasOwnProperty.call(next, 'stealth')) {
      applyStealth();
    }
    const clean = { ...next };
    // blank = keep existing secret (renderer only sees masked values);
    // null = delete the stored key on purpose
    const dropBlobs = [];
    for (const k of ['apiKey', 'transcribeApiKey', 'ttsApiKey']) {
      if (clean[k] === null) {
        clean[k] = '';
        dropBlobs.push(k); // an explicit delete must also drop an unreadable blob
      } else if (!clean[k]) {
        delete clean[k];
      }
    }
    saveConfig(clean, dropBlobs);
    if (pendingWipe) {
      // the user is re-personalizing after an interrupted wipe â€” keep the new
      // data (old secrets are already gone); the profile-dir wipe is cancelled
      pendingWipe = false;
      wipeOnQuit = false;
      try { fs.unlinkSync(wipeMarkerPath()); } catch {}
    }
    return publicConfig();
  });
  handle('ask', async (event, payload) => {
    try {
      await streamChat(event, payload);
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (event.sender.isDestroyed()) return; // window closed mid-request
      event.sender.send('error', { id: payload?.id, message: err.message });
    }
  });
  handle('cancel', () => currentAbort?.abort());
  handle('transcribe', async (e, p) => {
    try {
      return { text: await transcribe(e, p) };
    } catch (err) {
      return { error: err.message };
    }
  });
  handle('window:hide', async () => {
    if (win) {
      if (cfg.stealthDeep) {
        await applyDeepStealthAsync(true);
      } else {
        win.setPosition(-32000, -32000);
        win.hide();
      }
      isShown = false;
    }
  });
  handle('window:quit', () => app.quit());
  handle('update:check', async () => {
    if (!app.isPackaged) return { ok: false, error: 'only in an installed build' };
    if (!updater) return { ok: false, error: 'updater unavailable' };
    try {
      updaterStatus('Checking for updatesâ¬¦');
      await updater.checkForUpdates();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message).slice(0, 120) };
    }
  });
  // apply a downloaded update now (restarts the app)
  handle('update:install', () => {
    if (!updater) return { ok: false };
    setImmediate(() => updater.quitAndInstall(false, true));
    return { ok: true };
  });
  // Deep stealth re-assert from the renderer (init + focus): capture protection
  // and the window tells, never the DWM cloak â€” a cloaked window is not drawn,
  // and this runs while the panel is on screen. Toggled on stealthDeep=true.
  handle('stealth:apply', (_e, on) => {
    applyDeepStealth(Boolean(on), null, true);
    return { ok: true };
  });
  // "Prove it here" â€” the Ghost check measures the exclusion on this machine
  // instead of repeating a claim from the README.
  handle('ghost:check', async () => {
    try {
      return await stealthReport();
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
  // v3 name; ghost:check is kept so older probes and the renderer keep working
  handle('stealth:report', async () => {
    try {
      return await stealthReport();
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
  handle('window:shown', () => isShown);
  handle('window:move', (_e, { dx, dy }) => {
    if (!win) return;
    const [x, y] = win.getPosition();
    win.setPosition(x + dx, y + dy);
  });
  // Grab one frame on demand so the renderer can build a shot pile first and
  // ask its question afterwards, instead of firing a request on every click.
  handle('capture:one', async () => {
    try {
      const frame = await captureScreen();
      return { b64: frame.b64, tokens: frame.tokens, text: frame.text || '' };
    } catch (err) {
      return { error: err.message };
    }
  });
  handle('state:get', () => loadState());
  handle('state:set', (_e, state) => {
    if (wipeOnQuit) return; // wiped this run â€” refuse to resurrect state
    // keep it bounded: last 100 turns, last 20k chars of transcript, last 500 timestamped chunks
    saveState({
      history: (state.history || []).slice(-100),
      transcript: String(state.transcript || '').slice(-20000),
      transcriptLog: Array.isArray(state.transcriptLog) ? state.transcriptLog.slice(-500) : [],
      // long-term memory: durable facts/summaries the assistant reuses across chats
      memory: Array.isArray(state.memory) ? state.memory.slice(-200) : [],
    });
  });
  handle('displays:list', async () => {
    const displays = screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      label: d.label || `Display ${i + 1}`,
      size: d.size,
      kind: 'screen',
    }));
    // windows are offered as capture targets too, so a single app can be read
    // instead of the whole desktop
    let wins = [];
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      wins = sources
        .filter((s) => s.name && s.name.trim())
        .map((s) => ({ id: 'window:' + s.id, label: s.name, kind: 'window' }));
    } catch {}
    return [...displays, ...wins];
  });
  handle('speak', async (e, p) => {
    try {
      return { audio: await speak(e, p) };
    } catch (err) {
      return { error: err.message };
    }
  });
  // practice-mode debrief storage: DPAPI-encrypted like the conversation state
  handle('practice:save', (_e, { transcript, debrief }) => {
    try {
      const dir = path.join(app.getPath('userData'), 'sessions');
      fs.mkdirSync(dir, { recursive: true });
      const now = new Date();
      const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-'); // YYYY-MM-DD-HH-MM-SS
      const enc = encryptBlob(JSON.stringify({ transcript, debrief, savedAt: now.toISOString() }));
      if (!enc) return { error: 'Encryption unavailable â€” session not saved to disk' };
      const file = path.join(dir, `${stamp}.json`);
      writeFileAtomic(file, JSON.stringify({ enc }));
      return { file };
    } catch (err) {
      return { error: err.message };
    }
  });
  // practice-mode export: pick a path, write the one-page review sheet.
  // An explicit `filePath` skips the dialog â€” allowed only inside the OS temp
  // dir with a .md name, so the renderer can't use it as an arbitrary file write.
  handle('practice:export', async (_e, { markdown, filePath } = {}) => {
    try {
      let file = filePath;
      if (file) {
        const abs = path.resolve(String(file));
        const rel = path.relative(app.getPath('temp'), abs);
        if (!/\.md$/i.test(abs)) return { error: 'Export path must end in .md' };
        if (rel.startsWith('..') || path.isAbsolute(rel)) return { error: 'Export path must be inside the temp directory' };
        file = abs;
      } else {
        const stamp = new Date().toISOString().slice(0, 10);
        const r = await dialog.showSaveDialog(win, {
          title: 'Export practice review',
          defaultPath: `practice-review-${stamp}.md`,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        });
        if (r.canceled || !r.filePath) return { canceled: true };
        file = r.filePath;
      }
      fs.writeFileSync(file, markdown, 'utf8');
      return { file };
    } catch (err) {
      return { error: err.message };
    }
  });
  handle('wipe:all', () => {
    // destroy every trace on disk: key, history, transcript, sessions, window position.
    // Files go now; the whole userData dir (Chromium profile included) follows once
    // this process exits â€” however it exits. The marker lets a later launch finish
    // the job if the cleanup helper itself is killed (taskkill /IM, /T).
    deleteWipeTargets();
    try { fs.writeFileSync(wipeMarkerPath(), String(Date.now())); } catch {}
    cfg = { ...DEFAULTS };
    // The blobs we could not decrypt are the one copy of those keys. A later config
    // save would write them straight back into the config.json this wipe just
    // deleted, so they must be forgotten here.
    preservedEnc = {};
    keysNotPersisted = [];
    // treated exactly like a wipe interrupted by a crash: saving new settings cancels
    // the dir removal, because otherwise the profile is deleted at exit and the key
    // the user just re-entered vanishes with it
    pendingWipe = true;
    applyStealth();
    wipeOnQuit = true;
    scheduleWipe(); // detached helper cleans up after process death, even a hard kill
    return true;
  });

  mlog(`handlers registered, calling createWindow`);
  try {
    createWindow();
    mlog(`createWindow returned`);
    setupHostBlend();
    // The host is a brand-new top-level window created with an empty title, and
    // the periodic blend only reaches it on its next pass â€” until then the audit
    // (and any detector) sees an untitled window. Blend once now that it exists.
    if (process.platform === 'win32') blendProcessTitles();
  } catch (e) {
    mlog(`createWindow threw: ${e.stack || e}`);
    throw e;
  }
  registerShortcuts();
  mlog(`launch complete`);
});

app.on('will-quit', () => {
  teardownHostBlend();
  globalShortcut.unregisterAll();
  removeDevtoolsPort();
  scheduleWipe(true); // always respawn at exit when a wipe is pending â€” the wipe-time helper may have capped out, failed, or been killed
});
app.on('window-all-closed', () => app.quit());

// Exposed so scripts/test-main.js can execute the real cleanup script rather than a
// copy that drifts. The app itself never reads this.
module.exports = { wipeHelperCommand };

