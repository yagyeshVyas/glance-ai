const { app, BrowserWindow, dialog, globalShortcut, ipcMain, desktopCapturer, screen, session, safeStorage, nativeImage, protocol } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const crypto = require('crypto');
const { estimateTokens, fitContext, visionTokens, fitFrames, updaterNotice } = require('./shared');
const IDENTITY = require('./identity');
const SIGNING = require('./signing');
const updaterVerify = require('./updater-verify');
const broadcast = require('./broadcast');
const providers = require('./providers');
const embeddings = require('./embeddings');
const logging = require('./logging');

// The only page this process will ever load. IPC trust is decided against this
// exact URL, not against "anything that starts with file://".
const APP_INDEX = path.join(__dirname, 'renderer', 'index.html');
const APP_URL = pathToFileURL(APP_INDEX).href;
// Packaged-build smoke test: start, prove the window was created, write a marker
// and quit. Used by scripts/verify-build.js and CI; a normal launch never sets it.
const SMOKE_TEST = process.argv.includes('--smoke-test');

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  chatModel: 'gpt-4o-mini',
  // 'auto' infers the family from the base URL, so profiles created before
  // provider selection existed keep working. Explicit values: openai,
  // anthropic, ollama, lmstudio, custom.
  chatProvider: 'auto',
  transcribeProvider: 'auto',
  ttsProvider: 'auto',
  fallbackProvider: 'auto',
  // Blank means "the same model as chat": a gateway that transcribes with the
  // model it chats with needs no second name, and no second key. Set it only when
  // the audio model is genuinely a different one (a dedicated whisper endpoint).
  transcribeModel: '',
  // Blank lets the provider detect the spoken language (Whisper does this by
  // default). Set an ISO-639-1 code to pin it, which improves accuracy on short
  // chunks and stops a noisy clip from being decoded as the wrong language.
  transcribeLanguage: '',
  // Ask the transcription endpoint for segment metadata and use speaker labels
  // when the provider supplies them. OpenAI Whisper does not diarize, so this is
  // off by default and falls back to the capture-source label ("You"/"Them").
  transcribeDiarize: false,
  stealth: true, // exclude the overlay from screen capture (a privacy setting, not evasion)
  captureDisplay: 'auto', // 'auto' | display id | 'window:<source id>'
  ocr: true, // extract text locally from every captured frame and attach it
  updates: true, // check GitHub Releases for a new version in the background
  // Live-captions mode: start listening on launch and cut audio into 1.5 s
  // chunks. Persisted so a restart resumes without a click. It still requires
  // audioConsent below before a microphone or loopback stream is opened.
  captionMode: false,
  // Explicit, revocable consent before any audio capture. The renderer shows a
  // blocking notice the first time Listen (or captions) would open a stream.
  audioConsent: false,
  audioConsentAt: '',
  // Off by default: the live transcript stays in memory and is gone on quit.
  // Turning this on is the only way transcript text is written to state.json.
  persistTranscript: false,
  // NVIDIA Broadcast ships an eye-contact effect and a loopback MCP gateway.
  // Glance drives that gateway (set_effects -> eye_contact) instead of copying
  // NVIDIA's Maxine model, which is licensed and not redistributable. When the
  // effect is on, any app that selects "Camera (NVIDIA Broadcast)" gets it.
  nvidiaEyeContact: true,
  panelOpacity: 0.78, // 0.3 (ghost) to 0.98 (solid) — Cluely-style see-through glass
  // second provider for audio endpoints (transcription + TTS) — for gateways without /audio/*
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
  // Optional local-first routing: when enabled and localBaseUrl is set, chat
  // tries the local model first and falls back to the primary provider. Audio
  // routing stays separate so a local chat model never receives audio chunks.
  preferLocal: false,
  localBaseUrl: '',
  localChatModel: '',
  contextTokens: 32000, // model context window; the guard trims history to fit
  answerLang: 'English', // 'auto' or any language name — answers always in that language
  answerStyle: 'smart', // smart | brief | star | bullets | code | detail — shape of the answer
  targetRole: '', // e.g. "Senior React engineer at a fintech" — grounds every answer
  resume: '', // pasted CV — answers grounded in real experience, never invented
  knowledge: '', // pasted notes / cheat sheet - local retrieval, injected only when relevant
  // Optional semantic retrieval. Blank model = fully local lexical ranking.
  // Setting a model sends note text to that endpoint; the UI says so plainly.
  embeddingModel: '',
  embeddingBaseUrl: '', // blank = the chat provider's base URL
  pricingOverrides: '', // optional "model = inputUSD, outputUSD" lines, per 1M tokens
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
let preservedEnc = {}; // blobs DPAPI could not decrypt — kept verbatim, never replaced by nothing
let legacyPlaintextKey = false; // a key found in config.json as plaintext (pre-0.2.0 file)
let legacyPlaintextPersonal = false; // plaintext resume/targetRole from before they were encrypted
let legacyConfigFormat = false; // whole config.json still readable (pre-encryption-format)
let envValues = {}; // fields supplied by .env / the environment — re-read every launch, never persisted
// The fields that are credentials (never a plaintext fallback, and reported when
// they cannot be encrypted). resume/targetRole are encrypted too, but they are
// personal content, not keys, so they are not counted as "dropped keys".
const KEY_FIELDS = ['apiKey', 'transcribeApiKey', 'ttsApiKey', 'fallbackApiKey'];
let keysNotPersisted = []; // keys held in memory only: encryption was unavailable when they were saved

// Detached cleanup for `wipe all data`: spawned the moment a wipe is requested,
// not at quit time, so a crash or a PID-targeted kill can't skip it. The
// helper is a detached PowerShell process — it used to re-run this binary as
// plain Node (`ELECTRON_RUN_AS_NODE=1`), which the RunAsNode fuse turns off. It
// watches our PID and removes the whole userData dir once the process tree is
// gone: Chromium's children hold profile locks past will-quit, which is why
// removal must outlive the app.
// A marker file OUTSIDE userData records the pending wipe, so if the helper is
// killed too (a forced kill of the image and its children takes parent and
// helper together: same image, child of the browser process) the NEXT launch
// finishes the job.
// %APPDATA%\Glance AI — the product name, and nothing else, is the only
// string this folder leaks. Earlier builds wrote wshx-host / assistant /
// svchost / glance-assistant / RuntimeBroker profiles; the migration below
// copies from all of them and the folder is flagged system+hidden.
const PROFILE_DIR = path.join(app.getPath('appData'), IDENTITY.PRODUCT);
const WIPE_MARKER = path.join(app.getPath('appData'), '.glance-pending');

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
//      profile alone — the quit-time spawn and the next-launch marker cover it)
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
    // real spawn failures (ENOENT/AV block) arrive async as an 'error' event —
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
      else saved = {}; // undecryptable on this machine — start clean
    } else {
      saved = raw; // legacy readable settings — migrated on settle below
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
  // A profile written by an older build can still carry the removed ghost-mode
  // keys. They are dropped here so Settings cannot present a control that no
  // longer has an implementation behind it.
  delete cfg.stealthProcess;
  delete cfg.stealthDeep;
  delete cfg.stealthMaster;
  delete cfg.blendWindow;
  delete cfg.scramble;
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
  // never write any key as plaintext — DPAPI-encrypted blob or nothing (fail closed)
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
    // An explicit delete must remove the unreadable blob too — otherwise the
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
// Every handler below is reachable from the renderer. Only the app's own page,
// in its own top-level frame, in the app's own webContents, may call them.
//
// The previous check was /^file:\/\//i, which accepts ANY local file — a
// downloaded HTML file, a compromised extension page, a second window. The
// exact-path comparison is what makes the boundary a boundary.
function isAppUrl(raw) {
  try {
    const u = new URL(raw);
    const expected = new URL(APP_URL);
    return u.protocol === 'file:' && u.host === expected.host && u.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function isTrustedSender(event) {
  try {
    const frame = event.senderFrame;
    if (!frame || frame.parent) return false; // main frame only, never an iframe
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
    return isAppUrl(frame.url);
  } catch {
    return false;
  }
}

// A bearer token over plaintext http:// is readable by anything on the path.
// http:// is accepted only for the loopback interface and RFC1918 LANs, which
// is where a local model server lives. Everything public must be https://.
function isLoopbackHost(hostname) {
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
    String(hostname || ''),
  );
}
function providerUrlError(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return 'Base URL is not a valid URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return 'Base URL must start with http:// or https://';
  }
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
    return 'Plain http:// is only allowed for localhost or a private LAN address; use https:// for a public provider.';
  }
  return null;
}
// ---------- IPC payload schemas ----------
// The sender check proves *who* is calling. These validators prove *what*
// arrived: every invoke channel has a shape, unknown channels fail closed, and
// no handler receives an unbounded string, a non-finite number or a payload it
// did not ask for. The renderer is the only intended caller, but a renderer bug
// (or an injected page that somehow cleared the sender check) must not become an
// arbitrary file write, a 1 GB state save, or a provider URL with a key on it.
const INVALID = Symbol('invalid');
const IPC_MAX_ASK = 16 * 1024 * 1024;
const IPC_MAX_AUDIO = 25 * 1024 * 1024;
const IPC_MAX_STATE = 4 * 1024 * 1024;

const isPlainObject = (v) => Object.prototype.toString.call(v) === '[object Object]';
const ipcString = (v, max) => (typeof v === 'string' && v.length <= max ? v : INVALID);
const ipcBool = (v) => (typeof v === 'boolean' ? v : INVALID);
const ipcNumber = (v, min, max) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : INVALID;
const ipcNumeric = (v, min, max) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : INVALID;
};
const ipcOneOf = (v, allowed) => (typeof v === 'string' && allowed.includes(v) ? v : INVALID);

const CONFIG_SCHEMA = {
  baseUrl: (v) => ipcString(v, 2048),
  apiKey: (v) => (v === null ? null : ipcString(v, 8192)),
  chatModel: (v) => ipcString(v, 200),
  chatProvider: (v) => ipcOneOf(v, providers.PROVIDER_CHOICES),
  transcribeProvider: (v) => ipcOneOf(v, providers.PROVIDER_CHOICES),
  ttsProvider: (v) => ipcOneOf(v, providers.PROVIDER_CHOICES),
  fallbackProvider: (v) => ipcOneOf(v, providers.PROVIDER_CHOICES),
  transcribeModel: (v) => ipcString(v, 200),
  transcribeLanguage: (v) => {
    const s = ipcString(v, 12);
    if (s === null || s === '') return s;
    return /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(s) ? s : null;
  },
  transcribeDiarize: ipcBool,
  stealth: ipcBool,
  captureDisplay: (v) => ipcString(v, 100),
  ocr: ipcBool,
  updates: ipcBool,
  captionMode: ipcBool,
  audioConsent: ipcBool,
  audioConsentAt: (v) => ipcString(v, 40),
  persistTranscript: ipcBool,
  nvidiaEyeContact: ipcBool,
  panelOpacity: (v) => ipcNumber(v, 0.3, 0.98),
  transcribeBaseUrl: (v) => ipcString(v, 2048),
  transcribeApiKey: (v) => (v === null ? null : ipcString(v, 8192)),
  ttsBaseUrl: (v) => ipcString(v, 2048),
  ttsApiKey: (v) => (v === null ? null : ipcString(v, 8192)),
  ttsVoice: (v) => ipcString(v, 100),
  ttsModel: (v) => ipcString(v, 200),
  fallbackBaseUrl: (v) => ipcString(v, 2048),
  fallbackApiKey: (v) => (v === null ? null : ipcString(v, 8192)),
  fallbackChatModel: (v) => ipcString(v, 200),
  preferLocal: ipcBool,
  localBaseUrl: (v) => ipcString(v, 2048),
  localChatModel: (v) => ipcString(v, 200),
  contextTokens: (v) => ipcNumeric(v, 4000, 2000000),
  answerLang: (v) => ipcString(v, 40),
  answerStyle: (v) => ipcOneOf(v, ['smart', 'brief', 'star', 'bullets', 'code', 'detail']),
  targetRole: (v) => ipcString(v, 2000),
  resume: (v) => ipcString(v, 200000),
  knowledge: (v) => ipcString(v, 400000),
  embeddingModel: (v) => ipcString(v, 200),
  embeddingBaseUrl: (v) => ipcString(v, 2048),
  pricingOverrides: (v) => ipcString(v, 4000),
  smartMode: ipcBool,
  practiceMode: ipcBool,
  systemPrompt: (v) => ipcString(v, 20000),
};

const noArgs = (args) => (args.length === 0 ? [] : null);
const oneObject = (args) => (args.length === 1 && isPlainObject(args[0]) ? args[0] : null);

const IPC_VALIDATORS = {
  'config:get': noArgs,
  'config:set': (args) => {
    const o = oneObject(args);
    if (!o) return null;
    const out = {};
    for (const [key, value] of Object.entries(o)) {
      const rule = CONFIG_SCHEMA[key];
      if (!rule) return null;
      const clean = rule(value);
      if (clean === INVALID) return null;
      out[key] = clean;
    }
    return [out];
  },
  'models:list': (args) => {
    const o = oneObject(args);
    if (!o) return null;
    const out = {};
    if (o.baseUrl !== undefined) {
      const v = ipcString(o.baseUrl, 2048);
      if (v === INVALID) return null;
      out.baseUrl = v;
    }
    if (o.apiKey !== undefined) {
      const v = ipcString(o.apiKey, 8192);
      if (v === INVALID) return null;
      out.apiKey = v;
    }
    if (o.purpose !== undefined) {
      const v = ipcOneOf(o.purpose, ['chat', 'transcribe', 'tts']);
      if (v === INVALID) return null;
      out.purpose = v;
    }
    if (o.provider !== undefined) {
      const v = ipcOneOf(o.provider, providers.PROVIDER_CHOICES);
      if (v === INVALID) return null;
      out.provider = v;
    }
    return [out];
  },
  ask: (args) => {
    const o = oneObject(args);
    if (!o) return null;
    const id =
      typeof o.id === 'number' && Number.isFinite(o.id)
        ? o.id
        : ipcString(o.id, 64);
    if (id === INVALID) return null;
    if (!Array.isArray(o.messages) || o.messages.length < 1 || o.messages.length > 50) return null;
    const messages = [];
    for (const m of o.messages) {
      if (!isPlainObject(m)) return null;
      const role = ipcOneOf(m.role, ['system', 'user', 'assistant']);
      const content = ipcString(m.content, 200000);
      if (role === INVALID || content === INVALID) return null;
      messages.push({ role, content });
    }
    const withScreen = o.withScreen === undefined ? false : ipcBool(o.withScreen);
    if (withScreen === INVALID) return null;
    const shots = o.shots === undefined ? undefined : ipcNumber(o.shots, 0, 5);
    if (shots === INVALID) return null;
    const clean = { id, messages, withScreen };
    if (shots !== undefined) clean.shots = shots;
    if (o.memory !== undefined) {
      if (!Array.isArray(o.memory) || o.memory.length > 200) return null;
      clean.memory = [];
      for (const m of o.memory) {
        if (!isPlainObject(m)) return null;
        const kind = ipcString(m.kind || 'note', 40);
        const text = ipcString(m.text, 4000);
        const at = m.at === undefined ? '' : ipcString(m.at, 40);
        if (kind === INVALID || text === INVALID || at === INVALID) return null;
        clean.memory.push({ kind, text, at });
      }
    }
    if (o.images !== undefined) {
      if (!Array.isArray(o.images) || o.images.length > 5) return null;
      clean.images = [];
      for (const img of o.images) {
        if (!isPlainObject(img)) return null;
        const b64 = ipcString(img.b64, 8 * 1024 * 1024);
        const tokens = img.tokens === undefined ? 0 : ipcNumber(img.tokens, 0, 1000000);
        if (b64 === INVALID || tokens === INVALID) return null;
        clean.images.push({ b64, tokens });
      }
    }
    try {
      if (JSON.stringify(clean).length > IPC_MAX_ASK) return null;
    } catch {
      return null;
    }
    return [clean];
  },
  cancel: noArgs,
  transcribe: (args) => {
    const o = oneObject(args);
    if (!o) return null;
    const isBytes = o.data instanceof ArrayBuffer || ArrayBuffer.isView(o.data);
    if (!isBytes || o.data.byteLength < 1 || o.data.byteLength > IPC_MAX_AUDIO) return null;
    const mime = ipcString(o.mime, 100);
    const who = o.who === undefined ? undefined : ipcString(o.who, 20);
    if (mime === INVALID || who === INVALID) return null;
    return [{ data: o.data, mime, who }];
  },
  'window:hide': noArgs,
  'window:quit': noArgs,
  'update:check': noArgs,
  'update:install': noArgs,
  'update:download': noArgs,
  'stealth:apply': (args) => {
    if (args.length !== 1) return null;
    const on = ipcBool(args[0]);
    return on === INVALID ? null : [on];
  },
  'broadcast:status': noArgs,
  'broadcast:eye-contact': (args) => {
    if (args.length !== 1) return null;
    const on = ipcBool(args[0]);
    return on === INVALID ? null : [on];
  },
  'window:shown': noArgs,
  'window:move': (args) => {
    const o = oneObject(args);
    if (!o) return null;
    const dx = ipcNumber(o.dx, -10000, 10000);
    const dy = ipcNumber(o.dy, -10000, 10000);
    return dx === INVALID || dy === INVALID ? null : [{ dx, dy }];
  },
  'capture:one': noArgs,
  'state:get': noArgs,
  'state:set': (args) => {
    const o = oneObject(args);
    if (!o) return null;
    try {
      if (JSON.stringify(o).length > IPC_MAX_STATE) return null;
    } catch {
      return null;
    }
    return [o];
  },
  'displays:list': noArgs,
  'knowledge:import': noArgs,
  'providers:health': noArgs,
  'providers:test': noArgs,
  speak: (args) => {
    const o = oneObject(args);
    if (!o) return null;
    const text = ipcString(o.text, 8000);
    return text === INVALID || !text.trim() ? null : [{ text }];
  },
  'practice:save': (args) => {
    const o = oneObject(args);
    if (!o) return null;
    const transcript = ipcString(o.transcript, 500000);
    if (transcript === INVALID) return null;
    const debrief = o.debrief;
    if (typeof debrief !== 'string' && !isPlainObject(debrief)) return null;
    try {
      if (JSON.stringify({ transcript, debrief }).length > 1024 * 1024) return null;
    } catch {
      return null;
    }
    return [{ transcript, debrief }];
  },
  'practice:export': (args) => {
    const o = oneObject(args);
    if (!o) return null;
    const markdown = ipcString(o.markdown, 2 * 1024 * 1024);
    if (markdown === INVALID) return null;
    if (o.filePath === undefined) return [{ markdown }];
    const filePath = ipcString(o.filePath, 500);
    return filePath === INVALID ? null : [{ markdown, filePath }];
  },
  'wipe:all': noArgs,
};

function validateIpc(channel, args) {
  const validator = IPC_VALIDATORS[channel];
  if (!validator) return null;
  try {
    return validator(args);
  } catch {
    return null;
  }
}

const handle = (channel, fn) =>
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      return { error: 'unauthorized: IPC sender is not the app window' };
    }
    const clean = validateIpc(channel, args);
    if (!clean) return { error: `invalid payload for ${channel}` };
    return fn(event, ...clean);
  });

// ---------- removed: anti-inspection layer ----------
// 3.3.7 deletes the native stealth addon and the C# helper's window commands.
// ETW suppression, local and remote PEB rewriting, module unlinking, a process
// DACL that denies PROCESS_VM_READ, process-title blending, DWM cloaking, host
// reparenting and window-class renaming had no product function: they only made
// the process harder to inspect, which is the behaviour a detector is entitled
// to treat as evasive. What remains is documented Electron behaviour:
// setContentProtection() for capture exclusion, and the app's own name and
// window title everywhere the OS shows it.
//
// The one native dependency left is OCR. Electron has no OCR API, so a small
// helper calls the in-box Windows engine. It takes an image path and returns
// recognised lines; it has no window, process or trust-store commands.


// ---------- window ----------
// Chromium writes DevToolsActivePort into the profile; it names a port and a
// UUID and is another "Electron/Chromium" tell. Only meaningful while debugged.
function removeDevtoolsPort() {
  if (process.env.WSHX_KEEP_DEVTOOLS_PORT === '1') return;
  try { fs.unlinkSync(path.join(app.getPath('userData'), 'DevToolsActivePort')); } catch {}
}

// Capture protection is never lifted for our own screenshot. Lifting it — the
// behaviour until 3.3.0 — made the panel capturable by every other capturer for
// the whole grab (90 ms settle plus the source enumeration), which is exactly
// the window a browser screen share samples at 30 fps. `captureScreen()`
// composites the panel back from the renderer instead.

// Detector-aware mode (flaglessMode / text scrambling) was removed in 3.3.7.
// It polled for screen inspectors and dropped the capture exclusion when one was
// found, so the panel became capturable but unreadable. That is proctoring
// evasion: it exists to defeat a monitoring tool the user's other party chose to
// run. Capture exclusion is now a plain privacy setting, not a conditional one.

// NVIDIA Broadcast integration. Eye contact is Broadcast's own feature and its
// model (Maxine AR / NvAR inside NvBroadcastCore.dll) is licensed, not
// redistributable — so Glance drives Broadcast's loopback MCP gateway instead of
// copying it: set_effects with effectId "eye_contact", plus list_devices to know
// which camera is live. Silent when Broadcast is not running.
let nvEyeContactAt = 0;
async function syncNvidiaEyeContact() {
  try {
    if (!cfg.nvidiaEyeContact) {
      const off = await broadcast.setEyeContact(false);
      return off && off.ok ? off : null;
    }
    // The effect only exists while Broadcast runs. Start it hidden if it is not
    // running, then turn eye contact on. No window is opened either way.
    const run = await broadcast.ensureRunning();
    if (!run || !run.ok) {
      mlog('nvidia: ' + ((run && run.reason) || 'unavailable'));
      return run || null;
    }
    const r = await broadcast.ensureEyeContact(true);
    if (r && r.ok) {
      nvEyeContactAt = Date.now();
      mlog('nvidia: eye contact ' + (r.already ? 'already on' : 'enabled') + (run.started ? (run.visible ? ' (Broadcast launched)' : ' (Broadcast started hidden)') : ''));
    }
    return r;
  } catch (e) {
    mlog('nvidia: eye contact failed ' + (e && e.message));
    return null;
  }
}

// One status object for the Settings row: gateway alive, which camera Broadcast
// is feeding (the "which one is open" answer), and the live effect flag.
async function nvidiaStatus() {
  try {
    const [cam, dev] = await Promise.all([broadcast.getCameraState(), broadcast.listDevices()]);
    const devices = (dev && dev.ok && (dev.structured || dev.result)) || {};
    const cameras = Array.isArray(devices.cameras) ? devices.cameras : [];
    const active = cameras.find((c) => c && c.active) || null;
    const eye = cam && cam.ok && cam.state && cam.state.eye_contact;
    return {
      ok: Boolean(cam && cam.ok),
      eyeContact: eye ? Boolean(eye.enabled) : null,
      camera: active ? active.name : null,
      resolution: active && active.currentResolution ? active.currentResolution.label : null,
      reason: cam && cam.ok ? null : (cam && cam.reason) || 'Broadcast is not running',
    };
  } catch (e) {
    return { ok: false, reason: String(e && e.message).slice(0, 120) };
  }
}

// Capture exclusion is the only "stealth" left, and it is a plain privacy
// setting: the overlay is omitted from screen captures and screen shares the
// same way a password field is. There is no second mechanism, no conditional
// drop when an inspector is seen, and no native call behind it.
function applyStealth() {
  if (win && !win.isDestroyed()) {
    win.setContentProtection(Boolean(cfg.stealth));
  }
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
    title: IDENTITY.WINDOW_TITLE,
    icon: iconPath || undefined,
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The page must not rename the window: the OS should show the product's name,
  // not whatever the current answer happens to be.
  win.on('page-title-updated', (e) => e.preventDefault());
  // TEMP: dump renderer console + JS errors to a file for diagnosis. Packaged
  // builds stay silent unless WSHX_DEBUG_LOG=1: this file records page text and
  // error strings, and an always-present trace in the profile is a lead.
  const debugTraces = !app.isPackaged || process.env.WSHX_DEBUG_LOG === '1';
  const diagFile = path.join(app.getPath('userData'), 'renderer.log');
  const diag = debugTraces
    ? (line) => { try { fs.appendFileSync(diagFile, line + '\n'); } catch {} }
    : () => {};
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
  applyStealth();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  isShown = true;

  // save bounds on move/resize — debounced off the main-thread hot path
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
    win.hide();
    isShown = false;
  } else {
    const b = win.getBounds();
    const { workArea } = screen.getPrimaryDisplay();
    if (b.x < workArea.x || b.y < workArea.y || b.x + b.width > workArea.x + workArea.width || b.y + b.height > workArea.y + workArea.height) {
      win.setPosition(Math.round(workArea.x + (workArea.width - b.width) / 2), workArea.y + 24);
    }
    win.showInactive();
    // coming back from minimize: drop the taskbar button again
    try {
      win.setSkipTaskbar(true);
    } catch {}
    win.focus();
    isShown = true;
    // Re-assert capture exclusion after the show: a hide/show cycle builds a new
    // surface, and the flag belongs to the window that was just shown.
    setTimeout(() => { if (win && !win.isDestroyed()) applyStealth(); }, 150);
    // Broadcast can be restarted between shows; re-assert the effect then.
    setTimeout(() => syncNvidiaEyeContact(), 400);
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
  toggleVisible();
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
  reg('CommandOrControl+Shift+Q', () => app.quit()); // matches the —S" close button
  if (failed.length) {
    console.warn('shortcuts unavailable:', failed.join(', '));
    const message = `Hotkey conflict — these are taken by another app: ${failed.join(', ')}`;
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
  // Protection stays on for the entire grab. The panel is therefore missing from
  // this frame and is composited back from the renderer — see
  // withPanelComposited() — instead of being exposed to every other capturer for
  // the length of the screenshot.
  const sources = await desktopCapturer.getSources({
    types: wantWindow ? ['window'] : ['screen'],
    thumbnailSize: { width: thumbW, height: thumbH },
  });
  const src = wantWindow
    ? sources.find((s) => String(s.id) === wantWindow) || sources[0]
    : sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!src) throw new Error(wantWindow ? 'Window is gone' : 'No screen source available');

  const image = wantWindow
    ? (capturesOurWindow(src) ? await compositeOwnWindow(src.thumbnail) : src.thumbnail)
    : await withPanelComposited(src.thumbnail, display);
  const jpeg = image.toJPEG(82);
  return {
    b64: jpeg.toString('base64'),
    tokens: visionTokens(thumbW, thumbH),
    // OCR is extracted locally so the model gets exact text for code, forms
    // and tables instead of having to read glyphs out of the pixels
    text: cfg.ocr ? await ocrBuffer(jpeg) : '',
  };
}

// Put the panel back into a capture that is missing it.
//
// `desktopCapturer` honours WDA_EXCLUDEFROMCAPTURE, so a protected panel is not
// in the frame — which is the point of the flag, and used to be worked around by
// turning the flag off for the screenshot. That workaround exposed the panel to
// every other capturer (a browser screen share included) for the duration of the
// grab. The renderer's compositor is not a screen capture — capturePage()
// renders the page's own surface — so the panel can be painted back in without
// the protection flag ever moving.
//
// Everything in here is user mode: one GetWindowRect on the host (native addon),
// one compositor read, and a bitmap blend. Nothing asks the display pipeline for
// anything, which is why the flag can stay on.
async function withPanelComposited(screenImage, display) {
  try {
    const rect = panelRectOnDisplay(display, screenImage.getSize());
    if (!rect) return screenImage;
    const page = await capturePageOnce();
    if (!page) return screenImage;
    return paintPanel(screenImage, page, rect);
  } catch (e) {
    mlog('composite: ' + (e && e.message));
    return screenImage;
  }
}

// Where the panel sits inside a captured display, in the capture's pixels.
//
// BrowserWindow.getBounds() is DIPs relative to the display; the captured
// thumbnail is physical pixels. Converting through the display's scale factor
// is exact now that nothing reparents the window.
function panelRectOnDisplay(display, img) {
  if (!win || win.isDestroyed() || !win.isVisible()) return null;
  if (!img || !img.width || !img.height) return null;
  const r = win.getBounds();
  if (!r || r.width < 8 || r.height < 8) return null;

  const pxPerDipX = img.width / display.size.width;
  const pxPerDipY = img.height / display.size.height;

  const x = Math.round((r.x - display.bounds.x) * pxPerDipX);
  const y = Math.round((r.y - display.bounds.y) * pxPerDipY);
  const w = Math.round(r.width * pxPerDipX);
  const h = Math.round(r.height * pxPerDipY);
  if (w < 8 || h < 8) return null;
  return { x, y, w, h };
}

// capturePage() can come back as an empty surface — a window whose compositor
// has not produced a frame yet, or right after a GPU process restart. Pasting
// that would paint a transparent hole into the screenshot, so it is retried.
async function capturePageOnce() {
  for (let attempt = 0; attempt < 2; attempt++) {
    let img = null;
    try { img = await win.webContents.capturePage(); } catch {}
    const size = img && img.getSize ? img.getSize() : null;
    if (size && size.width > 0 && size.height > 0) return img;
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
}

function rowOpaque(buf, off, cols) {
  for (let i = 0; i < cols; i++) if (buf[off + i * 4 + 3] !== 255) return false;
  return true;
}

// Skia hands back premultiplied BGRA on Windows, but that is an implementation
// detail of the image decoder, not a contract. A straight-alpha surface blended
// with the premultiplied formula leaves a dark fringe on the panel's rounded
// corners, so the encoding is sniffed rather than assumed: in a premultiplied
// surface no colour channel can exceed its alpha.
function isPremultiplied(buf, w, h) {
  const total = w * h;
  const stride = Math.max(1, Math.floor(total / 4096));
  for (let p = 0; p < total; p += stride) {
    const o = p * 4;
    const a = buf[o + 3];
    if (buf[o] > a + 1 || buf[o + 1] > a + 1 || buf[o + 2] > a + 1) return false;
  }
  return true;
}

// Alpha-composite the page image into the frame at `rect`, clipped to the frame.
// Fully opaque rows are a straight copy — a glass panel is only transparent near
// its rounded edge, so most rows take that path and the per-pixel blend is only
// paid for the few that need it.
function paintPanel(baseImage, pageImage, rect) {
  const img = baseImage.getSize();
  if (!img.width || !img.height) return baseImage;
  const page = pageImage.resize({ width: rect.w, height: rect.h, quality: 'best' });
  const top = page.toBitmap();
  const base = baseImage.toBitmap();
  if (top.length < rect.w * rect.h * 4) return baseImage;
  if (base.length < img.width * img.height * 4) return baseImage;

  const premul = isPremultiplied(top, rect.w, rect.h);
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(img.width, rect.x + rect.w);
  const y1 = Math.min(img.height, rect.y + rect.h);
  if (x1 <= x0 || y1 <= y0) return baseImage;

  const cols = x1 - x0;
  let painted = 0;
  for (let ty = y0; ty < y1; ty++) {
    const row = ty - rect.y;
    const src0 = (row * rect.w + (x0 - rect.x)) * 4;
    const dst0 = (ty * img.width + x0) * 4;
    if (rowOpaque(top, src0, cols)) {
      top.copy(base, dst0, src0, src0 + cols * 4);
      painted += cols;
      continue;
    }
    for (let i = 0; i < cols; i++) {
      const ti = src0 + i * 4;
      const a = top[ti + 3];
      if (!a) continue;
      const si = dst0 + i * 4;
      if (a === 255) {
        base[si] = top[ti];
        base[si + 1] = top[ti + 1];
        base[si + 2] = top[ti + 2];
        base[si + 3] = 255;
      } else {
        const inv = 255 - a;
        if (premul) {
          base[si] = Math.min(255, top[ti] + ((base[si] * inv) / 255 | 0));
          base[si + 1] = Math.min(255, top[ti + 1] + ((base[si + 1] * inv) / 255 | 0));
          base[si + 2] = Math.min(255, top[ti + 2] + ((base[si + 2] * inv) / 255 | 0));
        } else {
          base[si] = Math.min(255, ((top[ti] * a) / 255 | 0) + ((base[si] * inv) / 255 | 0));
          base[si + 1] = Math.min(255, ((top[ti + 1] * a) / 255 | 0) + ((base[si + 1] * inv) / 255 | 0));
          base[si + 2] = Math.min(255, ((top[ti + 2] * a) / 255 | 0) + ((base[si + 2] * inv) / 255 | 0));
        }
        base[si + 3] = 255;
      }
      painted++;
    }
  }
  if (!painted) return baseImage;
  mlog(`composite: ${painted} px at ${x0},${y0} ${cols}x${y1 - y0}${premul ? '' : ' (straight alpha)'}`);
  return nativeImage.createFromBitmap(base, { width: img.width, height: img.height });
}

// A window capture of the panel itself comes back empty for the same reason a
// screen capture does: the flag applies to the window. The page fills that
// window exactly, so the composite is the whole frame.
function capturesOurWindow(src) {
  if (!win || win.isDestroyed()) return false;
  const id = String((src && src.id) || '');
  // getMediaSourceId() is Electron's documented mapping from a window to the
  // desktopCapturer source id; no native handle arithmetic is involved.
  try {
    return id === String(win.getMediaSourceId());
  } catch {
    return false;
  }
}

async function compositeOwnWindow(image) {
  try {
    const page = await capturePageOnce();
    if (!page) return image;
    const size = image.getSize();
    if (!size.width || !size.height) return image;
    return paintPanel(image, page, { x: 0, y: 0, w: size.width, h: size.height });
  } catch (e) {
    mlog('composite: ' + (e && e.message));
    return image;
  }
}

// Run the in-box Windows OCR engine over a captured JPEG. Returns the text, or
// '' when OCR is unavailable — never throws, because a vision model alone is
// still a valid answer path.
//
// The image goes to a temp file rather than a base64 argument: Windows caps a
// command line at 32,767 characters, and a 1080p JPEG exceeds that, which made
// OCR silently return nothing on exactly the frames that needed it most.
const OCR_HELPER = (() => {
  if (process.platform !== 'win32') return '';
  const shipped = process.resourcesPath ? path.join(process.resourcesPath, 'ocr-helper.exe') : '';
  if (shipped && fs.existsSync(shipped)) return shipped;
  const dev = path.join(__dirname, '..', 'build', 'ocr-helper.exe');
  return fs.existsSync(dev) ? dev : '';
})();

function runFile(file, args) {
  return new Promise((resolve, reject) => {
    require('child_process').execFile(
      file,
      args,
      { encoding: 'utf8', timeout: 12000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

async function ocrBuffer(jpegBuf) {
  if (!OCR_HELPER) return '';
  const tmp = path.join(require('os').tmpdir(), 'glance-ocr-' + process.pid + '-' + Date.now() + '.jpg');
  try {
    fs.writeFileSync(tmp, jpegBuf);
    const out = await runFile(OCR_HELPER, ['ocr', tmp]);
    const lines = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /^L\t(.+)$/.exec(line);
      if (m) lines.push(Buffer.from(m[1], 'base64').toString('utf8'));
    }
    return lines.join('\n').trim();
  } catch {
    return '';
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// The in-app "ghost check" report was removed with the native layer. It measured
// DWM affinity, window classes and extended styles, which only existed because
// the app was trying to be unenumerable. Capture exclusion is now verified by
// the same path every capturer uses: npm run capture-probe.

// ---------- meeting detection ----------
// The overlay is most useful at the moment a call starts, and that is exactly the
// moment the user is joining rather than looking at the panel. Watch the process
// list for the usual clients (and browser tabs titled like a meeting) and say so
// once per app per run. Detection only — it never starts the mic behind your back.
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
        message: `${name} is running — Ctrl+Shift+L starts listening (pick "Both" to hear the interviewer too).`,
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
// Checks quietly in the background, then offers an explicit download. Never
// restarts on its own — a restart mid-meeting would be worse than running one
// version behind, so updating is user-driven.
let updater = null;
let updaterState = {};

function updaterStatus(message, level) {
  if (win && !win.isDestroyed()) win.webContents.send('notice', { level: level || 'info', message });
}

// All updater events go through one reducer. In particular, the boot check can
// finish after a fast download, and it must not turn "ready" back into
// "available" or clobber a progress line.
function applyUpdaterEvent(event) {
  const next = updaterNotice(updaterState, event);
  if (next === updaterState) return;
  updaterState = next;
  if (next.message) updaterStatus(next.message, next.level);
}

function setupUpdater() {
  if (!app.isPackaged || cfg.updates === false) return;
  try {
    // required inside try: a dev checkout has no electron-updater in the app dir
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    // Pin the signer by certificate thumbprint. The default verifier needs the
    // self-signed certificate in a trust store before it compares the DN, which
    // a clean machine does not have; this accepts the exact pinned signer while
    // still rejecting a tampered file or any other certificate.
    if (process.platform === 'win32') {
      autoUpdater.verifyUpdateCodeSignature = (_publisherNames, file) =>
        updaterVerify.verifyFile(file, SIGNING.THUMBPRINT);
    }

    autoUpdater.on('checking-for-update', () => applyUpdaterEvent({ type: 'checking' }));
    autoUpdater.on('update-available', (i) => applyUpdaterEvent({ type: 'available', version: i.version }));
    autoUpdater.on('update-not-available', () => applyUpdaterEvent({ type: 'none' }));
    autoUpdater.on('download-progress', (p) => applyUpdaterEvent({ type: 'progress', percent: p.percent }));
    autoUpdater.on('update-downloaded', (i) => applyUpdaterEvent({ type: 'downloaded', version: i.version }));
    autoUpdater.on('error', (e) => applyUpdaterEvent({ type: 'error', error: e.message }));

    // wait a little after boot so an update check never delays the first paint
    setTimeout(() => {
      if (updaterState.downloading || updaterState.downloadedVersion) return;
      autoUpdater.checkForUpdates().catch(() => {});
    }, 8000);
  } catch {}
}

// ---------- LLM ----------
// A key belongs to exactly one provider entry. A separate base URL means a
// separate provider: never send the chat provider's key to it.

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
    'For behavioural questions, answer as STAR in four labelled lines — Situation, Task, Action, Result — kept to one line each. Preference for concrete numbers and outcomes.',
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
  const chain = providers.chatChain(cfg);
  const pricing = providers.parsePricingOverrides(cfg.pricingOverrides);
  // A local provider needs no key. Any remote provider without one is a
  // configuration error, not something to discover as a 401 on the wire.
  if (!chain.some((p) => p.apiKey || providers.isLocalKind(p.kind))) {
    throw new Error('No API key set. Open Settings (gear) and add one, or configure a local model.');
  }
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
    // Lexical ranking is the default. When an embedding model is configured,
    // this adds a semantic boost and falls back silently on any failure.
    const relevant = await embeddings.rankKnowledge(cfg, cfg.knowledge, lastUser ? String(lastUser.content || '') : '', {
      onError: (err) => mlogEvent('warn', 'embeddings.fallback', {
        error: String((err && err.message) || err).slice(0, 160),
      }),
    });
    if (relevant) {
      sys += `\n\nNotes from the user's own knowledge base — authoritative, prefer them over general knowledge. Each note is prefixed with its source heading; mention that heading when a note drives the answer:\n${relevant}`;
    }
  }

  let msgs = [{ role: 'system', content: sys }, ...messages];

  // context guard: budget from settings, minus the vision cost of the frames we are about to attach.
  // supports 1M-class windows; there is no true "unlimited" — set it to your model's real limit.
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
    // Decide what actually fits before trimming: on a 4k—8k window the frames plus
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
            'Text extracted locally by OCR from the screenshot(s) — authoritative for code, ' +
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
  // Each provider keeps its own origin, key and wire format: a key is never
  // sent to an origin it does not belong to.
  // (The chain is built at the top so a missing key fails before capture.)

  // retry with exponential backoff, only on retryable failures (429/5xx/network)
  const maxRetries = 3;
  const requestStartedAt = Date.now();
  let firstTokenMs = null;
  let usage = null;
  const markFirstToken = () => {
    if (firstTokenMs === null) firstTokenMs = Date.now() - requestStartedAt;
  };
  const donePayload = (provider) => ({
    latencyMs: Date.now() - requestStartedAt,
    firstTokenMs,
    usage: providers.normalizeUsage(usage),
    costUsd: providers.estimateCostUsd(provider, usage, pricing),
  });
  try {
    for (let p = 0; p < chain.length; p++) {
      const provider = chain[p];
      const isLastProvider = p === chain.length - 1;
      let attempt = 0;
      while (attempt <= maxRetries) {
        try {
          const req = providers.chatRequest(provider, { messages: msgs, maxTokens: maxOut, stream: true });
          mlogEvent('info', 'provider.request', {
            provider: provider.kind,
            label: provider.label,
            model: provider.model,
            attempt,
          });
          const res = await fetch(req.url, {
            method: 'POST',
            signal: ctrl.signal,
            headers: req.headers,
            body: JSON.stringify(req.body),
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
            // provider ignored stream:true — read the whole JSON body instead
            const json = await res.json();
            const parsed = providers.parseResponse(provider.kind, json);
            usage = parsed.usage || usage;
            if (parsed.reasoning) {
              markFirstToken();
              send('reasoning', { text: parsed.reasoning });
            }
            if (parsed.text) {
              markFirstToken();
              send('chunk', { text: parsed.text });
            }
            const done = donePayload(provider);
            send('done', done);
            mlogEvent('info', 'provider.done', { provider: provider.kind, label: provider.label, ...done });
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
            if (!data) return;
            let events;
            try {
              events = providers.parseStreamData(provider.kind, data);
            } catch (err) {
              // A malformed OpenAI chunk is noise; an Anthropic `error` event is
              // a real provider failure and must reach retry/failover.
              if (err instanceof SyntaxError) return;
              throw err;
            }
            for (const ev of events) {
              if (ev.type === 'text' && ev.text) {
                lastChunkAt = Date.now();
                emitted = true;
                markFirstToken();
                send('chunk', { text: ev.text });
              } else if (ev.type === 'reasoning' && ev.text) {
                lastChunkAt = Date.now();
                emitted = true;
                markFirstToken();
                send('reasoning', { text: ev.text });
              } else if (ev.type === 'usage') {
                usage = providers.mergeUsage(usage, ev.usage);
              }
            }
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
          const done = donePayload(provider);
          send('done', done);
          mlogEvent('info', 'provider.done', { provider: provider.kind, label: provider.label, ...done });
          return;
        } catch (err) {
          if (err.name === 'AbortError' || timedOut) throw err;
          const status = err.status || 0;
          mlogEvent('warn', 'provider.error', {
            provider: provider.kind,
            label: provider.label,
            status,
            message: String(err.message || err).slice(0, 300),
          });
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
            usage = null;
            firstTokenMs = null;
            lastChunkAt = Date.now(); // the watchdog clock restarts with the new origin
            send('notice', {
              level: 'warn',
              message: `Provider failed (${String(err.message || err).slice(0, 120)}) — retrying on the backup endpoint.`,
            });
            mlogEvent('warn', 'provider.failover', { from: provider.label, to: chain[p + 1].label });
            break;
          }
          if (exhausted) throw err;
          // A retry re-sends the completion from its first token. If part of the failed
          // attempt is already painted, tell the renderer to drop it — otherwise the
          // answer reads as the partial reply followed by the full one.
          if (emitted) {
            send('reset', {});
            emitted = false;
            gotFirstByte = false;
            usage = null;
            firstTokenMs = null;
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
        'Provider stopped responding — no output for 30 s (120 s allowed for the first token). Request cancelled.',
      );
    }
    throw err;
  } finally {
    clearInterval(watchdog);
  }
}

// Turn a verbose transcription response into display text. A provider that
// diarizes returns segments with a speaker field; one that does not returns the
// plain text and the caller keeps the capture-source label.
function formatTranscription(json) {
  const raw = Array.isArray(json && json.segments) ? json.segments : [];
  const rows = [];
  for (const seg of raw) {
    const text = String((seg && seg.text) || '').trim();
    if (!text) continue;
    const speaker = seg.speaker ?? seg.speaker_label ?? seg.speaker_id;
    if (speaker === undefined || speaker === null || String(speaker).trim() === '') continue;
    rows.push({ speaker: String(speaker).trim().slice(0, 40), text });
  }
  if (!rows.length) return { text: String((json && json.text) || '').trim() };
  // Consecutive segments from one speaker become one line, not one line each.
  const grouped = [];
  for (const row of rows) {
    const last = grouped[grouped.length - 1];
    if (last && last.speaker === row.speaker) last.text += ' ' + row.text;
    else grouped.push({ ...row });
  }
  const label = (s) => (/^speaker\b/i.test(s) ? s : `Speaker ${s}`);
  return {
    text: grouped.map((g) => `${label(g.speaker)}: ${g.text}`).join('\n'),
    plain: grouped.map((g) => g.text).join(' '),
    diarized: true,
  };
}

async function transcribe(_e, { data, mime, who }) {
  const provider = providers.audioDescriptor(cfg, 'transcribe');
  if (provider.kind === 'anthropic') {
    throw new Error('Anthropic has no audio transcription endpoint — set a separate transcription provider in Settings.');
  }
  if (!provider.apiKey && !providers.isLocalKind(provider.kind)) {
    throw new Error('No transcription key: set one in Settings, or add a main key to fall back to.');
  }
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(data)], { type: mime }), `audio.${ext}`);
  form.append('model', provider.model || 'whisper-1');
  // Blank means "detect it". A code pins the language, which is more accurate on
  // 4-7 s chunks and stops a noisy clip being decoded as another language.
  const language = String(cfg.transcribeLanguage || '').trim();
  if (language) form.append('language', language);
  // Speaker labels are only possible if the endpoint returns segments. Ask for
  // verbose JSON when the user opted in; a 400 falls back to the plain request
  // below instead of breaking transcription on a provider that only supports
  // response_format=json.
  let verbose = Boolean(cfg.transcribeDiarize);
  if (verbose) form.append('response_format', 'verbose_json');
  // Which side of the call this chunk came from. The local server keeps one
  // rolling context per stream so a sentence split across chunks is transcribed
  // with its own beginning, not with the other speaker's words.
  if (who) form.append('stream', String(who).slice(0, 16));

  // retry transcription on transient failures only (429 / 5xx / network)
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(provider.baseUrl + '/audio/transcriptions', {
        method: 'POST',
        headers: providers.authHeaders(provider),
        body: form,
        // A hung STT endpoint must fail visibly instead of stalling the FIFO
        // queue forever. 60 s is generous for a 4–7 s chunk; local whisper on a
        // cold model can take a while on the first call.
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const errText = await res.text();
        const e = new Error(`Transcribe ${res.status}: ${errText.slice(0, 300)}`);
        e.status = res.status; // so the catch can tell a 500 from a 400
        throw e;
      }
      return formatTranscription(await res.json());
    } catch (err) {
      // A provider that rejects verbose_json should still transcribe. Retry
      // once without the optional response format, without spending a retry.
      if (verbose && err.status === 400) {
        verbose = false;
        form.delete('response_format');
        i--;
        continue;
      }
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
  const provider = providers.audioDescriptor(cfg, 'tts');
  if (provider.kind === 'anthropic') {
    throw new Error('Anthropic has no speech endpoint — set a separate TTS provider in Settings.');
  }
  if (!provider.apiKey && !providers.isLocalKind(provider.kind)) {
    throw new Error('No TTS key: set one in Settings, or add a main key to fall back to.');
  }
  const res = await fetch(provider.baseUrl + '/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...providers.authHeaders(provider) },
    body: JSON.stringify({ model: provider.model || 'tts-1', voice: cfg.ttsVoice || 'alloy', input: String(text).slice(0, 4000), response_format: 'mp3' }),
    signal: AbortSignal.timeout(20000), // a hung TTS endpoint must not block this handler forever
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)} — this provider may not support /audio/speech`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

// ---------- conversation state ----------
const statePath = () => path.join(app.getPath('userData'), 'state.json');

const EMPTY_STATE = () => ({ history: [], transcript: '', transcriptLog: [], memory: [] });

function stateString(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// The renderer is allowed to send a transcript only after the user has opted in
// to saving it. This is enforced here as well as in the UI: a renderer bug, a
// stale page or a future feature cannot write meeting audio text to disk by
// calling state:set directly.
function sanitizeState(raw) {
  const out = EMPTY_STATE();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (Array.isArray(raw.history)) {
    out.history = raw.history
      .filter((m) => m && typeof m === 'object' && !Array.isArray(m))
      .map((m) => ({
        role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user',
        content: stateString(m.content, 200000),
        ...(typeof m.at === 'string' ? { at: m.at.slice(0, 40) } : {}),
      }))
      .filter((m) => m.content)
      .slice(-100);
  }
  if (cfg.persistTranscript === true) {
    out.transcript = stateString(raw.transcript, 20000);
    if (Array.isArray(raw.transcriptLog)) {
      out.transcriptLog = raw.transcriptLog
        .filter((e) => e && typeof e === 'object' && !Array.isArray(e))
        .map((e) => ({
          at: stateString(e.at, 40),
          text: stateString(e.text, 4000),
          ...(typeof e.who === 'string' ? { who: e.who.slice(0, 20) } : {}),
        }))
        .filter((e) => e.text)
        .slice(-500);
    }
  }
  if (Array.isArray(raw.memory)) {
    out.memory = raw.memory
      .filter((m) => m && typeof m === 'object' && !Array.isArray(m))
      .map((m) => ({
        at: stateString(m.at, 40),
        kind: stateString(m.kind, 40) || 'note',
        text: stateString(m.text, 4000),
      }))
      .filter((m) => m.text)
      .slice(-200);
  }
  return out;
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (raw && raw.enc) {
      // DPAPI-encrypted at rest — without the blob, no history on disk
      const txt = decryptBlob(raw.enc);
      return txt ? sanitizeState(JSON.parse(txt)) : EMPTY_STATE();
    }
    return sanitizeState(raw); // legacy plaintext, migrated on the next save
  } catch {
    return EMPTY_STATE();
  }
}

function saveState(next) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  const enc = encryptBlob(JSON.stringify(sanitizeState(next)));
  if (!enc) return false; // no DPAPI available => nothing on disk (fail closed)
  writeFileAtomic(statePath(), JSON.stringify({ enc }));
  return true;
}

// A pre-3.3.7 profile stored the full transcript by default. On the first launch
// without the new opt-in, remove it from disk while keeping history and memory.
// If DPAPI is unavailable the plaintext file is deleted rather than left behind.
function scrubStoredTranscript() {
  if (cfg.persistTranscript === true) return;
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    let parsed = raw;
    if (raw && raw.enc) {
      const txt = decryptBlob(raw.enc);
      if (!txt) return; // cannot read it; never rewrite an unreadable blob
      parsed = JSON.parse(txt);
    }
    if (!parsed || typeof parsed !== 'object') return;
    const hasTranscript =
      Boolean(parsed.transcript) ||
      (Array.isArray(parsed.transcriptLog) && parsed.transcriptLog.length > 0);
    if (!hasTranscript) return;
    const clean = sanitizeState(parsed);
    const enc = encryptBlob(JSON.stringify(clean));
    if (enc) writeFileAtomic(statePath(), JSON.stringify({ enc }));
    else fs.unlinkSync(statePath());
  } catch {}
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

// Test hook: a second, isolated instance for the probes. The single-instance
// lock is keyed on userData, and the app later forces userData to its own
// profile folder — so an isolated run has to move it *before* the lock is taken,
// or a probe launched while the user's overlay is running would simply exit.
// Only the probes set it (`scripts/browser-proof.js`, `scripts/cdp-eval.js`
// flows); a normal launch never sees the variable.
if (process.env.RB_PROFILE_DIR) {
  try { app.setPath('userData', process.env.RB_PROFILE_DIR); } catch {}
}

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

// Hardware acceleration stays on. Disabling the GPU process was an attempt to
// erase a GPU-debugger fingerprint, and it made the overlay slower and heavier
// on every machine to hide something that is not a secret.
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
// createWindow; this one catches failures before that point).
// Packaged builds write nothing unless WSHX_DEBUG_LOG=1: a timestamped record of
// every launch and API failure sitting in %APPDATA% is a lead, and earlier
// builds left it there under a product name.
const MAIN_LOG = path.join(app.getPath('appData'), '.glance-trace.log');
const MAIN_LOG_ON = !app.isPackaged || process.env.WSHX_DEBUG_LOG === '1';
const mlog = (line) => {
  if (!MAIN_LOG_ON) return;
  try {
    fs.appendFileSync(MAIN_LOG, `[${new Date().toISOString()}] ${logging.redactSecrets(String(line))}\n`);
  } catch {}
};
const mlogEvent = (level, event, fields) => mlog(logging.formatLogLine(level, event, fields));
if (MAIN_LOG_ON) {
  for (const legacy of ['.assistant-trace.log', '.wshx-trace.log', '.runtimebroker-trace.log']) {
    try { fs.unlinkSync(path.join(app.getPath('appData'), legacy)); } catch {}
  }
}
process.on('uncaughtException', (e) => mlog(`uncaughtException: ${e.stack || e}`));
process.on('unhandledRejection', (r) => mlog(`unhandledRejection: ${r && (r.stack || r.message || r)}`));
mlog(`main module top-level reached, logPath=${MAIN_LOG} appData=${app.getPath('appData')}`);
app.whenReady().then(() => {
  mlog(`whenReady fired, singleInstance=${singleInstance}`);
  // The losing instance must not build a window while quit() is still tearing it
  // down: whenReady used to be registered outside the lock, so a rapid second
  // launch could add a second overlay before exiting.
  if (!singleInstance) return;
  // Navigation and window creation are denied by default. This app loads exactly
  // one local page; any attempt to navigate elsewhere, open a child window, or
  // attach a <webview> is refused. Without this, a link in model output or any
  // future HTML injection turns the renderer into a page of the attacker's
  // choosing while it still holds the preload bridge.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-navigate', (event, url) => {
      if (!isAppUrl(url)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!isAppUrl(url)) event.preventDefault();
    });
  });
  protocol.handle(MP_SCHEME, mpRequestHandler);
  // Keep Chromium's profile under %APPDATA%\Glance AI, the product's own name.
  // Earlier builds renamed it to a Windows-component name and marked it
  // system+hidden; both are retired. The migration below still adopts data from
  // those folders so an upgrade does not lose settings.
  if (process.platform === 'win32' && !process.env.RB_PROFILE_DIR) {
    try {
      // one-time migration across every previous name, oldest first so the most
      // recent profile wins. Chromium pre-creates the new folder, so copy missing
      // FILES rather than gating on the folder not existing.
      // The rename's own predecessor is the newest source and must win on age: a
      // pre-RuntimeBroker "Glance AI" profile can already exist, and the generic
      // copy-missing rule below would let its ancient config survive.
      const previous = path.join(app.getPath('appData'), 'RuntimeBroker');
      if (fs.existsSync(previous)) {
        try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch {}
        for (const f of ['config.json', 'state.json', 'bounds.json']) {
          const from = path.join(previous, f);
          const to = path.join(PROFILE_DIR, f);
          try {
            if (!fs.existsSync(from)) continue;
            if (!fs.existsSync(to) || fs.statSync(from).mtimeMs > fs.statSync(to).mtimeMs) fs.copyFileSync(from, to);
          } catch {}
        }
        const oldSessions = path.join(previous, 'sessions');
        const newSessions = path.join(PROFILE_DIR, 'sessions');
        if (fs.existsSync(oldSessions)) {
          try { fs.cpSync(oldSessions, newSessions, { recursive: true, force: false }); } catch {}
        }
      }
      const LEGACY_PROFILES = IDENTITY.LEGACY_PROFILE_NAMES;
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
    } catch {}
  }
  // a wipe was requested earlier but never completed (the cleanup helper can die
  // alongside the app): delete the data files now and finish on this session's exit
  // carry a pending wipe across the profile rename
  try {
      const legacyMarkers = ['wshx-host-pending', 'svchost-pending', 'assistant-pending', 'glance-assistant-pending', '.runtimebroker-pending'];
      if (!fs.existsSync(WIPE_MARKER)) {
        for (const name of legacyMarkers) {
          const legacyMarker = path.join(app.getPath('appData'), name);
          if (fs.existsSync(legacyMarker)) { fs.renameSync(legacyMarker, WIPE_MARKER); break; }
        }
      }
  } catch {}
  if (fs.existsSync(wipeMarkerPath())) {
    deleteWipeTargets();
    wipeOnQuit = true; // refuse state writes until the pending wipe completes
    pendingWipe = true;
  }
  loadConfig();
  // The transcript is opt-in. Remove any copy an older build wrote before the
  // renderer can read it, while keeping history and long-term memory.
  scrubStoredTranscript();
  // Migrate once, and only when a legacy plaintext key actually exists. The old
  // unconditional saveConfig({}) rewrote the file on every launch and erased any
  // blob it had just failed to decrypt (V-05) — and resurrected config.json on
  // the pending-wipe path, right after the wipe had deleted it.
  if (legacyPlaintextKey || legacyPlaintextPersonal || legacyConfigFormat) saveConfig({});

  // A debugging launch leaves DevToolsActivePort (a port number and a UUID) in
  // the profile — two files' worth of "this is Chromium". Removed on quit as
  // well, so a packaged install leaves no trace once it exits.
  removeDevtoolsPort();

  // Autostart: a component that only appears when you launch it is itself a
  // tell. Opt-in (packaged builds only) because a dev checkout autostarting from
  // node_modules is noisier than it is stealthy.
  //
  // The installer already writes the machine-wide Run value. Adding the per-user
  // one on top puts a second row in Task Manager's Startup tab and starts a
  // duplicate at every logon (it loses the singleton and exits), so: machine-wide
  // wins, and a per-user value left over from an older build is removed.
  const RUN_KEY = 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const HKCU_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  if (app.isPackaged && !process.env.RB_PROFILE_DIR && !SMOKE_TEST) {
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
    const userEntry = hasRun(HKCU_RUN_KEY, IDENTITY.AUTOSTART_NAME);
    let taskEntry = false;
    try {
      execFileSync('schtasks', ['/query', '/tn', IDENTITY.AUTOSTART_NAME], { stdio: 'ignore', timeout: 4000 });
      taskEntry = true;
    } catch {}
    const machineRun = hasRun(RUN_KEY, IDENTITY.AUTOSTART_NAME);
    // every earlier name wrote its own Startup row: remove them on sight, whether
    // or not the current entry exists
    for (const legacy of IDENTITY.LEGACY_RUN_NAMES) {
      for (const key of [HKCU_RUN_KEY, RUN_KEY]) {
        if (!hasRun(key, legacy)) continue;
        try { execFileSync('reg', ['delete', key, '/v', legacy, '/f'], { stdio: 'ignore', timeout: 4000 }); } catch {}
      }
    }
    if (taskEntry || machineRun) {
      if (userEntry) {
        try {
          app.setLoginItemSettings({ openAtLogin: false, name: IDENTITY.AUTOSTART_NAME });
        } catch {}
      }
    } else if (!userEntry) {
      // nothing at all (portable copy, uninstalled mirror): keep a user value
      try {
        app.setLoginItemSettings({ openAtLogin: true, args: ['--autostart'], name: IDENTITY.AUTOSTART_NAME });
      } catch {}
    }
  }

  if (!SMOKE_TEST) {
    setupUpdater();
    watchForMeetings();
    // Broadcast may still be starting; retry once after the app is up. If it is
    // not installed or not running this resolves quietly.
    setTimeout(() => syncNvidiaEyeContact(), 3000);
  }

  // AUMID grouping is a normal Electron setting: it tells the shell which app
  // owns the window for notifications and taskbar grouping. It is not a
  // rename and does not change what Task Manager shows.
  if (process.platform === 'win32') {
    try {
      app.setAppUserModelId(IDENTITY.APP_ID);
    } catch {}
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
  // Every grant is scoped to this app's own webContents and this app's own
  // page: a handler that answers only by permission name grants the microphone
  // to whatever page happens to be loaded.
  const ALLOWED_PERMISSIONS = new Set([
    'media', 'display-capture', 'audioCapture', 'videoCapture',
    // the Copy button writes the answer to the OS clipboard. clipboard-read is
    // deliberately not granted: nothing in the UI reads the clipboard.
    'clipboard-sanitized-write',
  ]);
  const isAppContents = (wc) => Boolean(win && !win.isDestroyed() && wc === win.webContents);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    callback(isAppContents(wc) && isAppUrl(url) && ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    // The check handler does not always receive a full URL; require this app's
    // webContents, a file: origin, and the same allow-list.
    if (!isAppContents(wc)) return false;
    if (!ALLOWED_PERMISSIONS.has(permission)) return false;
    const origin = String(requestingOrigin || (details && details.requestingUrl) || '');
    return origin.startsWith('file://');
  });
  // lets the renderer capture system audio (WASAPI loopback) via getDisplayMedia,
  // honouring the display picker instead of always grabbing display 0
  session.defaultSession.setDisplayMediaRequestHandler(async (request, cb) => {
    // Only this app's own page may ask. A denied request is cancelled with an
    // empty object; it never silently falls back to display 0.
    if (!request || !request.frame || !isAppUrl(request.frame.url)) {
      try { cb({}); } catch {}
      return;
    }
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
  handle('models:list', async (_e, { baseUrl, apiKey, purpose, provider }) => {
    try {
      const base = (baseUrl || cfg.baseUrl).replace(/\/+$/, '');
      const urlError = providerUrlError(base);
      if (urlError) return { error: urlError };
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
      const isLocal = isLoopbackHost(target.hostname);
      // A separate audio provider is a separate trust domain: never lend it the chat
      // key. The audio descriptor refuses that combination on the request path; model
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
      // A cloud key is not a local server credential. Only lend a stored key to
      // localhost when the main provider itself is local (the user configured it
      // that way); otherwise the request goes out with no Authorization header.
      const localIsConfigured = isLocal && providers.isLocalKind(providers.normalizeKind(cfg.chatProvider, cfg.baseUrl));
      const key = apiKey || (mayUseStoredKey && (!isLocal || localIsConfigured) ? storedKey : '');
      if (!key && !isLocal) {
        return {
          error: foreignAudio
            ? 'That host is a separate audio provider — add its own key in Settings; the chat key is not sent to it.'
            : 'No key for that host — add its key in Settings first.',
        };
      }
      const desc = providers.descriptor({
        kind: provider || 'auto',
        baseUrl: base,
        apiKey: key,
        model: '',
      });
      const req = providers.modelsRequest(desc);
      const started = Date.now();
      const res = await fetch(req.url, {
        headers: req.headers,
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) return { error: `Models ${res.status}`, latencyMs }; // never echo the provider body back
      const json = await res.json();
      const ids = providers.parseModels(desc.kind, json).slice(0, 500);
      mlogEvent('info', 'provider.models', { provider: desc.kind, latencyMs, count: ids.length });
      return { models: ids, latencyMs, provider: desc.kind };
    } catch (err) {
      return { error: err.name === 'TimeoutError' ? 'Provider did not answer in 5 s' : err.message };
    }
  });
  // Health check for every configured provider. Keys never leave this process:
  // the response reports reachability, latency and model count, not credentials.
  handle('providers:health', async () => {
    const rows = [
      ...providers.chatChain(cfg).map((p) => ({ ...p, role: p.label })),
      { ...providers.audioDescriptor(cfg, 'transcribe'), role: 'transcribe' },
      { ...providers.audioDescriptor(cfg, 'tts'), role: 'tts' },
    ];
    const seen = new Set();
    const unique = rows.filter((p) => {
      const key = p.role + '|' + p.kind + '|' + p.baseUrl;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const check = async (p) => {
      const host = (() => {
        try {
          return new URL(p.baseUrl).host;
        } catch {
          return p.baseUrl;
        }
      })();
      const base = { role: p.role, kind: p.kind, host, model: p.model || '' };
      if (!p.apiKey && !providers.isLocalKind(p.kind)) {
        return { ...base, ok: false, error: 'no key configured' };
      }
      try {
        const req = providers.modelsRequest(p);
        const started = Date.now();
        const res = await fetch(req.url, { headers: req.headers, signal: AbortSignal.timeout(5000) });
        const latencyMs = Date.now() - started;
        if (!res.ok) return { ...base, ok: false, latencyMs, error: `models ${res.status}` };
        const json = await res.json();
        const models = providers.parseModels(p.kind, json);
        return { ...base, ok: true, latencyMs, models: models.length };
      } catch (err) {
        return {
          ...base,
          ok: false,
          error: err.name === 'TimeoutError' ? 'no answer in 5 s' : String(err.message || err).slice(0, 160),
        };
      }
    };
    return { providers: await Promise.all(unique.map(check)) };
  });
  // Deep check: one tiny real completion through the same request builder the
  // chat path uses. /models can answer while chat is broken (wrong model name,
  // a gateway that only proxies metadata); this proves the route end to end.
  handle('providers:test', async () => {
    const provider = providers.chatChain(cfg)[0];
    if (!provider) return { error: 'No chat provider configured' };
    if (!provider.apiKey && !providers.isLocalKind(provider.kind)) return { error: 'No key configured' };
    if (!provider.model) return { error: 'No chat model configured' };
    const req = providers.chatRequest(provider, {
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      maxTokens: 8,
      stream: false,
    });
    const started = Date.now();
    try {
      const res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(20000),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          ok: false,
          latencyMs,
          model: provider.model,
          error: `chat ${res.status}${body ? ': ' + body.slice(0, 120) : ''}`,
        };
      }
      const parsed = providers.parseResponse(provider.kind, await res.json());
      return {
        ok: true,
        latencyMs,
        model: provider.model,
        kind: provider.kind,
        text: String((parsed && parsed.text) || '').trim().slice(0, 80),
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        model: provider.model,
        error: err.name === 'TimeoutError' ? 'no answer in 20 s' : String(err.message || err).slice(0, 160),
      };
    }
  });
  handle('config:set', (_e, next) => {
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      return { error: 'config:set expects an object' };
    }
    const clean = { ...next };
    // Provider URLs are validated before anything is written. A public http://
    // endpoint would put the bearer token on the wire in clear text.
    for (const urlKey of ['baseUrl', 'transcribeBaseUrl', 'ttsBaseUrl', 'fallbackBaseUrl', 'localBaseUrl', 'embeddingBaseUrl']) {
      if (!Object.prototype.hasOwnProperty.call(clean, urlKey)) continue;
      if (!clean[urlKey]) { delete clean[urlKey]; continue; } // blank = default
      const urlError = providerUrlError(clean[urlKey]);
      if (urlError) return { error: urlError };
    }
    // A key belongs to the origin it was entered for. Changing a provider URL
    // without re-entering the key clears it, so a renderer cannot repoint the
    // stored credential at a host of its choosing.
    const originOf = (u) => {
      try { return u ? new URL(String(u)).origin : null; } catch { return null; }
    };
    const rebind = new Set();
    for (const [keyField, urlField] of [
      ['apiKey', 'baseUrl'],
      ['transcribeApiKey', 'transcribeBaseUrl'],
      ['ttsApiKey', 'ttsBaseUrl'],
      ['fallbackApiKey', 'fallbackBaseUrl'],
    ]) {
      if (!Object.prototype.hasOwnProperty.call(clean, urlField)) continue;
      const before = originOf(cfg[urlField] || DEFAULTS[urlField]);
      const after = originOf(clean[urlField] || DEFAULTS[urlField]);
      if (before !== after) rebind.add(keyField);
    }
    // blank = keep existing secret (renderer only sees masked values);
    // null = delete the stored key on purpose
    const dropBlobs = [];
    for (const k of KEY_FIELDS) {
      const mustDrop = clean[k] === null || (rebind.has(k) && !clean[k]);
      if (mustDrop) {
        clean[k] = '';
        dropBlobs.push(k); // an explicit delete must also drop an unreadable blob
      } else if (!clean[k]) {
        delete clean[k];
      }
    }
    saveConfig(clean, dropBlobs);
    // Apply window-level settings after the new config is in memory. Applying
    // before saveConfig read the previous value, so the toggle looked inert
    // until the next launch.
    if (Object.prototype.hasOwnProperty.call(next, 'stealth')) applyStealth();
    if (Object.prototype.hasOwnProperty.call(next, 'nvidiaEyeContact')) syncNvidiaEyeContact();
    // Turning transcript persistence off must delete the existing copy now, not
    // wait for the next state save. Turning it on leaves whatever is already
    // there alone.
    if (cfg.persistTranscript !== true) scrubStoredTranscript();
    if (pendingWipe) {
      // the user is re-personalizing after an interrupted wipe — keep the new
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
      return await transcribe(e, p);
    } catch (err) {
      return { error: err.message };
    }
  });
  handle('window:hide', async () => {
    if (win) {
      win.hide();
      isShown = false;
    }
  });
  handle('window:quit', () => app.quit());
  handle('update:check', async () => {
    if (!app.isPackaged) return { ok: false, error: 'only in an installed build' };
    if (!updater) return { ok: false, error: 'updater unavailable' };
    if (updaterState.downloading) return { ok: false, error: 'download in progress' };
    if (updaterState.downloadedVersion) {
      applyUpdaterEvent({ type: 'downloaded', version: updaterState.downloadedVersion });
      return { ok: true, ready: true };
    }
    try {
      applyUpdaterEvent({ type: 'checking' });
      await updater.checkForUpdates();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message).slice(0, 120) };
    }
  });
  // apply a downloaded update now (restarts the app)
  handle('update:install', () => {
    if (!updater) return { ok: false };
    if (!updaterState.downloadedVersion) return { ok: false, error: 'no update downloaded' };
    setImmediate(() => updater.quitAndInstall(false, true));
    return { ok: true };
  });
  // Download only after the user clicks the "update available" notice. The
  // installer's signature is checked by electron-updater against the
  // publisherName in app-update.yml before it is allowed to run.
  handle('update:download', async () => {
    if (!updater) return { ok: false };
    if (updaterState.downloadedVersion) {
      applyUpdaterEvent({ type: 'downloaded', version: updaterState.downloadedVersion });
      return { ok: true, already: true };
    }
    if (updaterState.downloading) return { ok: true, already: true };
    applyUpdaterEvent({ type: 'downloading' });
    try {
      await updater.downloadUpdate();
      return { ok: true };
    } catch (e) {
      // electron-updater usually emits its own error first; only add one when
      // that did not happen, so the status is never left on "Downloading".
      if (updaterState.downloading) applyUpdaterEvent({ type: 'error', error: e.message });
      return { ok: false, error: String(e.message).slice(0, 120) };
    }
  });
  // The renderer re-asserts capture exclusion on init and focus. This is the
  // same documented Electron call the settings toggle uses; there is no native
  // deep-stealth state to restore.
  handle('stealth:apply', (_e, on) => {
    if (win && !win.isDestroyed()) win.setContentProtection(Boolean(on));
    return { ok: true };
  });
  // NVIDIA Broadcast: which camera it is feeding, and the live eye-contact
  // flag. Broadcast owns the effect; this drives its loopback gateway.
  handle('broadcast:status', () => nvidiaStatus());
  handle('broadcast:eye-contact', async (_e, on) => {
    const r = await broadcast.setEyeContact(Boolean(on));
    if (r && r.ok) nvEyeContactAt = Date.now();
    return r;
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
    if (wipeOnQuit) return; // wiped this run — refuse to resurrect state
    // sanitizeState drops transcript/transcriptLog unless persistTranscript is
    // on, and bounds every array and string. Slicing array lengths alone is not
    // a size bound: 100 turns of 10 MB each is still a 1 GB write.
    const next = sanitizeState(state);
    let serialized;
    try { serialized = JSON.stringify(next); } catch { return; }
    if (serialized.length > IPC_MAX_STATE) return;
    saveState(next);
  });
  // Document ingestion: import a local text/markdown file into the knowledge
  // box. The renderer never gets a path and main never writes; this only reads
  // one file the user explicitly picked, with a hard size cap.
  handle('knowledge:import', async () => {
    try {
      const picked = await dialog.showOpenDialog(win, {
        title: 'Import notes into the knowledge base',
        properties: ['openFile'],
        filters: [{ name: 'Text notes', extensions: ['txt', 'md', 'markdown', 'csv', 'json', 'log'] }],
      });
      if (picked.canceled || !picked.filePaths.length) return { canceled: true };
      const file = picked.filePaths[0];
      const stat = fs.statSync(file);
      if (stat.size > 2 * 1024 * 1024) return { error: 'File is larger than 2 MB — paste the relevant part instead.' };
      let text = fs.readFileSync(file, 'utf8');
      if (text.includes('\u0000')) return { error: 'That looks like a binary file, not text.' };
      text = text.replace(/^\uFEFF/, '').trim();
      if (!text) return { error: 'The file is empty.' };
      return { name: path.basename(file), text: text.slice(0, 400000) };
    } catch (err) {
      return { error: err.message };
    }
  });
  handle('displays:list', async () => {    const displays = screen.getAllDisplays().map((d, i) => ({
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
      if (!enc) return { error: 'Encryption unavailable — session not saved to disk' };
      const file = path.join(dir, `${stamp}.json`);
      writeFileAtomic(file, JSON.stringify({ enc }));
      return { file };
    } catch (err) {
      return { error: err.message };
    }
  });
  // practice-mode export: pick a path, write the one-page review sheet.
  // An explicit `filePath` skips the dialog — allowed only inside the OS temp
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
    // this process exits — however it exits. The marker lets a later launch finish
    // the job if the cleanup helper itself is killed with the image.
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
  } catch (e) {
    mlog(`createWindow threw: ${e.stack || e}`);
    throw e;
  }
  if (!SMOKE_TEST) registerShortcuts();
  mlog(`launch complete`);

  if (SMOKE_TEST) {
    // The window is created above. Before writing the marker the verifier
    // checks, drive the real settings UI: open it, confirm the privacy board
    // and embedding controls rendered, then close with Escape and confirm focus
    // returned to the gear. This is a packaged-build regression test for the
    // keyboard and screen-reader behaviour that unit tests cannot see.
    // No shortcuts, updater, autostart or meeting watcher run in this mode.
    const smokeFile = process.env.RB_SMOKE_FILE;
    let finished = false;
    const finishSmoke = (payload) => {
      if (finished) return;
      finished = true;
      try {
        if (smokeFile) fs.writeFileSync(smokeFile, JSON.stringify(payload));
      } catch {}
      app.quit();
    };
    const giveUp = setTimeout(() => finishSmoke({ pass: false, error: 'ui check timed out' }), 20000);
    win.webContents.once('did-finish-load', async () => {
      try {
        const ui = await win.webContents.executeJavaScript(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const errors = [];
          window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
          window.addEventListener('unhandledrejection', (e) => errors.push(String((e.reason && e.reason.message) || e.reason)));
          const gear = document.getElementById('gear');
          const settings = document.getElementById('settings');
          gear.click();
          for (let i = 0; i < 50 && settings.hidden; i++) await sleep(100);
          const opened = !settings.hidden;
          const focusInside = settings.contains(document.activeElement);
          const status = document.getElementById('status');
          const live = status ? status.getAttribute('aria-live') : null;
          const privacy = (document.getElementById('privacyKeys') || {}).textContent || '';
          const embeds = Boolean(document.getElementById('s_embeddingModel'));
          const pricing = Boolean(document.getElementById('s_pricingOverrides'));
          const noMin = !document.getElementById('min');
          const hasClose = Boolean(document.getElementById('close'));
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(80);
          const closed = settings.hidden;
          const focusRestored = document.activeElement === gear;
          return { opened, focusInside, closed, focusRestored, live, privacy, embeds, pricing, noMin, hasClose, errors };
        })()`, true);
        clearTimeout(giveUp);
        const pass = Boolean(
          ui.opened && ui.focusInside && ui.closed && ui.focusRestored &&
          ui.live === 'polite' && ui.privacy && ui.embeds && ui.pricing &&
          ui.noMin && ui.hasClose &&
          Array.isArray(ui.errors) && ui.errors.length === 0,
        );
        finishSmoke({ pass, ...ui });
      } catch (err) {
        clearTimeout(giveUp);
        finishSmoke({ pass: false, error: String((err && err.message) || err).slice(0, 300) });
      }
    });
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  removeDevtoolsPort();
  scheduleWipe(true); // always respawn at exit when a wipe is pending — the wipe-time helper may have capped out, failed, or been killed
});
app.on('window-all-closed', () => app.quit());

// Exposed so scripts/test-main.js can execute the real cleanup script rather than a
// copy that drifts. The app itself never reads this.
module.exports = { wipeHelperCommand, styleInstruction };






