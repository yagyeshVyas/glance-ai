#!/usr/bin/env node
// Hotkey audit — prove the global-shortcut path works while wshx-host is already
// running. Read-only by design: RegisterHotKey() with hWnd=NULL only *asks*
// whether an accelerator is free, and it is released immediately on success.
// Nothing is sent unless --toggle is passed.
//
// Why this exists: the hotkey path could not be checked from a second process,
// because the running instance already owns all eleven accelerators — a test
// app registering them gets ERROR_HOTKEY_ALREADY_REGISTERED (1409).
//
// What 1409 does and does not prove: it says *some* process owns that accelerator
// system-wide. It does not name the owner. Only --toggle proves it: the accelerator
// bound to toggleVisible has to flip that window's visibility, and exit 0 is
// reserved for that proof (exit 3 = held but unproven).
//
// Run: node scripts/hotkey-audit.js [--pid <pid>] [--toggle] [--json]
//   --pid <pid>  the process expected to own the accelerators (default: the
//                Electron/wshx-host process with a Chrome_WidgetWin_1 window)
//   --toggle     end-to-end: send the accelerator bound to toggleVisible and
//                assert the window hides, then send it again and assert it comes
//                back. Uses the parsed modifier/VK, not a hardcoded Ctrl+Shift+H.
//   --json       machine-readable output
//
// Exit: 0 ownership PROVEN (every accelerator is held and the toggle flipped the
//       window); 1 an accelerator is free (registerShortcuts lost that binding);
//       3 everything is held but ownership is unproven (no toggle ran, or the
//       window never flipped) — held is not owned; 2 bad arguments, no target
//       process, or the probe failed.
//
// Nothing here claims a 1409 is wshx-host's: `held` means occupied by *some*
// process. Only a visible state change proves the owner.
//
// The accelerator list is parsed out of src/main.js — one source of truth, so
// adding a `reg('CommandOrControl+…')` there shows up here automatically.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argVal = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (has('--help') || has('-h')) {
  console.log('node scripts/hotkey-audit.js [--pid <pid>] [--toggle] [--json]');
  process.exit(0);
}
if (process.platform !== 'win32') {
  console.error('hotkey-audit: Windows only (globalShortcut → RegisterHotKey)');
  process.exit(2);
}

const asJson = has('--json');
const doToggle = has('--toggle');
// `--pid` present with no value used to fall through to "no filter" — a typo
// silently audited everything. Presence and value are now checked separately.
const pidFlag = has('--pid');
const rawPid = argVal('--pid');
if (pidFlag && (rawPid === undefined || !/^\d+$/.test(rawPid) || Number(rawPid) <= 0)) {
  console.error(`hotkey-audit: --pid needs a positive integer, got ${JSON.stringify(rawPid)}`);
  process.exit(2);
}

// ---------- accelerators, straight from the registration site ----------
const MOD = { CommandOrControl: 0x0002, Control: 0x0002, Ctrl: 0x0002, Alt: 0x0001, Shift: 0x0004, Super: 0x0008, Meta: 0x0008 };
const NAMED = {
  space: 0x20, enter: 0x0d, return: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, insert: 0x2d, delete: 0x2e,
  backspace: 0x08, '+' : 0xbb, '-' : 0xbd,
};

function toVk(key) {
  const k = key.trim();
  if (/^[a-z]$/i.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(k)) return 0x70 + Number(k.slice(1)) - 1;
  const n = NAMED[k.toLowerCase()];
  if (n !== undefined) return n;
  throw new Error(`hotkey-audit: unknown key ${JSON.stringify(k)} (add it to NAMED)`);
}

function parseAccelerators() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const out = [];
  // Both quote styles: a double-quoted binding must not slip past the audit.
  for (const m of src.matchAll(/\breg\(\s*(['"])((?:CommandOrControl|Control|Ctrl)\+[^'"]+)\1\s*,/g)) {
    const acc = m[2];
    const parts = acc.split('+').map((s) => s.trim());
    const key = parts.pop();
    let mod = 0;
    for (const p of parts) {
      if (MOD[p] === undefined) throw new Error(`hotkey-audit: unknown modifier ${JSON.stringify(p)} in ${acc}`);
      mod |= MOD[p];
    }
    out.push({ name: acc.replace(/CommandOrControl/g, 'Ctrl'), mod, vk: toVk(key) });
  }
  if (!out.length) throw new Error('hotkey-audit: no reg(\'CommandOrControl+…\') accelerators found in src/main.js');
  // A binding added without reg(), or with a non-literal accelerator, would be
  // silently untested while the run still passed. Refuse to report on a list the
  // audit may not have seen in full.
  const callSites = (src.match(/\breg\(/g) || []).length;
  if (callSites !== out.length) {
    throw new Error(`hotkey-audit: ${callSites} reg() call sites but ${out.length} literal accelerators — one binding is not a plain string`);
  }
  const direct = (src.match(/globalShortcut\.register\(/g) || []).length;
  if (direct !== 1) {
    throw new Error(`hotkey-audit: ${direct - 1} globalShortcut.register call(s) bypass reg() — the audit cannot see them`);
  }
  // The accelerator the app itself binds to toggleVisible — the only one whose
  // effect is observable. Hardcoding Ctrl+Shift+H drifts the moment it is remapped.
  const toggleMatch = src.match(/reg\(\s*(['"])((?:CommandOrControl|Control|Ctrl)\+[^'"]+)\1\s*,\s*toggleVisible\b/);
  const toggleAcc = toggleMatch ? toggleMatch[2] : null;
  const toggleTarget = toggleAcc ? out.find((a) => a.name === toggleAcc.replace(/CommandOrControl/g, 'Ctrl')) : null;
  return { list: out, toggleTarget };
}

// ---------- probe ----------
let parsed;
try {
  parsed = parseAccelerators();
} catch (err) {
  // A parse failure is not "a binding is free" (exit 1): the audit could not read the
  // registration site at all, which is a different, louder failure.
  console.error(err.message);
  process.exit(2);
}
const { list: tests, toggleTarget } = parsed;

if (doToggle && !toggleTarget) {
  console.error("hotkey-audit: no reg('CommandOrControl+…', toggleVisible) found in src/main.js — nothing to send");
  process.exit(2);
}

const ps = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # CLIXML progress on stderr pollutes the run on a cold profile
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class HA {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool RegisterHotKey(IntPtr h, int id, uint m, uint vk);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
$tests = @'
${JSON.stringify(tests)}
'@ | ConvertFrom-Json

$id = 9000
$rows = foreach ($t in $tests) {
  $id++
  $ok = [HA]::RegisterHotKey([IntPtr]::Zero, $id, [uint32]$t.mod, [uint32]$t.vk)
  if ($ok) { [void][HA]::UnregisterHotKey([IntPtr]::Zero, $id); $err = 0 }
  else { $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
  [pscustomobject]@{ name = $t.name; state = $(if ($ok) { 'free' } else { 'held' }); error = $err }
}

# find the window that belongs to the app: class Chrome_WidgetWin_1, owned by a
# process whose name is wshx-host.exe or electron.exe
$script:hits = @()
$cb = [HA+EnumProc]{
  param($h, $p)
  $wpid = 0
  [void][HA]::GetWindowThreadProcessId($h, [ref]$wpid)
  if ($wpid -eq 0) { return $true }
  try { $pn = (Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch { return $true }
  if ($pn -notin @('wshx-host', 'electron')) { return $true }
  $cls = New-Object System.Text.StringBuilder 256
  [void][HA]::GetClassNameW($h, $cls, 256)
  if ($cls.ToString() -ne 'Chrome_WidgetWin_1') { return $true }
  $txt = New-Object System.Text.StringBuilder 256
  [void][HA]::GetWindowTextW($h, $txt, 256)
  $script:hits += [pscustomobject]@{ hwnd = [int64]$h; pid = $wpid; proc = $pn; title = $txt.ToString(); visible = [HA]::IsWindowVisible($h) }
  return $true
}
[void][HA]::EnumWindows($cb, [IntPtr]::Zero)

$toggle = $null
$wantPid = [int]${rawPid || 0}
$w = $null
if ($script:hits.Count) {
  # --pid must pick the window the toggle actually drives, not just the one we report
  $w = if ($wantPid) { $script:hits | Where-Object { [int]$_.pid -eq $wantPid } | Select-Object -First 1 } else { $script:hits[0] }
}
if ($${doToggle ? 'true' : 'false'} -and -not $w) {
    $toggle = [pscustomobject]@{ error = $(if ($wantPid) { "no wshx-host window for pid $wantPid" } else { 'no wshx-host window found' }) }
}
if ($${doToggle ? 'true' : 'false'} -and $w) {
  $h = [IntPtr]$w.hwnd
  $vk = [int]${toggleTarget ? toggleTarget.vk : 0}
  $modsMask = [int]${toggleTarget ? toggleTarget.mod : 0}
  $toggleName = ${JSON.stringify(toggleTarget ? toggleTarget.name : '')}
  $initial = [HA]::IsWindowVisible($h)
  function Tap {
    # Build the chord from the parsed accelerator, not from hardcoded keys
    $down = @()
    if ($modsMask -band 0x0002) { $down += 0x11 }  # Ctrl
    if ($modsMask -band 0x0001) { $down += 0x12 }  # Alt
    if ($modsMask -band 0x0004) { $down += 0x10 }  # Shift
    foreach ($m in $down) { [HA]::keybd_event([byte]$m, 0, 0, [UIntPtr]::Zero) }
    [HA]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
    [HA]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
    for ($i = $down.Count - 1; $i -ge 0; $i--) { [HA]::keybd_event([byte]$down[$i], 0, 2, [UIntPtr]::Zero) }
  }
  # A synthesised key event can be swallowed while the app is busy, so tap until
  # the state actually flips (max 4) rather than assuming the first one lands.
  $taps = 0
  while ($taps -lt 4 -and [HA]::IsWindowVisible($h) -eq $initial) { Tap; $taps++; Start-Sleep -Milliseconds 600 }
  $flipped = [HA]::IsWindowVisible($h)
  # restore: keep tapping until it is back in the initial state
  $flips = 0
  while ($flips -lt 4 -and [HA]::IsWindowVisible($h) -ne $initial) { Tap; $flips++; Start-Sleep -Milliseconds 600 }
  $final = [HA]::IsWindowVisible($h)
  $toggled = ($flipped -ne $initial)
  # "restored" only means something if something moved: with no flip the window is
  # trivially in its initial state, and reporting that as restored is vacuous
  $restored = $toggled -and ($final -eq $initial)
  $toggle = [pscustomobject]@{ name = $toggleName; initial = $initial; flipped = $flipped; final = $final; taps = $taps; flips = $flips; toggled = $toggled; restored = $restored }
}

[pscustomobject]@{ engine = 'powershell'; hwnds = $script:hits; toggles = $toggle; tests = $rows } | ConvertTo-Json -Depth 5 -Compress
`;

// Absolute paths only: `powershell.exe` / `pwsh` on PATH can be shadowed by
// node_modules/.bin, which npm puts first during `npm run`. Same rule as
// detect-audit.js — this file had regressed to a bare PATH lookup.
function powershellPath() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(p) ? p : null;
}
function pwshPath() {
  const p = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return fs.existsSync(p) ? p : null;
}

let probe;
try {
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64];
  const opts = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  const errors = [];
  let out = null;
  // Windows PowerShell first, then pwsh: existence does not prove it can run
  // (AppLocker, Constrained Language Mode, a broken install).
  for (const exe of [powershellPath(), pwshPath()].filter(Boolean)) {
    try {
      out = execFileSync(exe, args, opts);
      break;
    } catch (err) {
      errors.push(`${path.basename(exe)}: ${err.message}`);
    }
  }
  if (out === null) throw new Error(errors.join('; ') || 'no PowerShell found (System32 or Program Files\\PowerShell\\7)');
  probe = JSON.parse(out.trim().split(/\r?\n/).pop());
} catch (err) {
  console.error('hotkey-audit: probe failed —', (err.stderr || err.message || '').toString().trim().slice(0, 400));
  process.exit(2);
}

const rows = probe.tests || [];
const targets = probe.hwnds || [];
const target = rawPid ? targets.find((t) => String(t.pid) === String(rawPid)) : targets[0];
const owner = target ? `${target.proc}.exe (pid ${target.pid})` : null;

const held = rows.filter((r) => r.error === 1409).length;
const free = rows.filter((r) => r.error === 0).length;
const other = rows.filter((r) => r.error !== 0 && r.error !== 1409);

const proven = Boolean(probe.toggles && probe.toggles.toggled && probe.toggles.restored);
const attribution = proven ? 'proven' : held === rows.length && target ? 'inferred' : 'none';

// One exit code, computed once, and the closing line is derived from it. The old
// message asserted "every binding is occupied" even on a run where all eleven were
// free, and disagreed with the code a CI job actually reads.
const exit = other.length
  ? 2
  : probe.toggles && probe.toggles.error
    ? 2
    : // no target first: with the app stopped every binding reads "free", which
      // must not be reported as "registerShortcuts lost a binding" (exit 1)
      !target
      ? 2
      : free > 0
        ? 1
        : proven
          ? 0
          : 3;

const summary =
  exit === 0
    ? `attribution proven: ${probe.toggles.name} flipped this window — wshx-host owns that binding`
    : exit === 1
      ? `binding lost (exit 1): ${free} accelerator(s) are free — registerShortcuts did not take them`
      : probe.toggles && probe.toggles.error
        ? `attribution unproven (exit 2): ${probe.toggles.error}`
        : !target
          ? 'no target (exit 2): no wshx-host/electron window to attribute the bindings to'
          : other.length
            ? `error (exit 2): ${other.length} binding(s) failed with a Windows error other than 1409`
            : 'attribution unproven (exit 3): every binding is occupied, but 1409 cannot say by whom — run --toggle to prove ownership';

if (asJson) {
  console.log(JSON.stringify({ running: targets.length > 0, owner, target: target || null, held, free, other, attribution, proven, tests: rows, toggle: probe.toggles || null }, null, 2));
} else {
  if (target) console.log(`target   ${owner}  hwnd=0x${target.hwnd.toString(16)}  title='${target.title}'  visible=${target.visible}`);
    else if (targets.length) console.log(`target   pid ${rawPid} owns no wshx-host window; owner is ${targets.map((t) => `${t.proc}.exe (pid ${t.pid})`).join(', ')} — not attributable`);
    else console.log('target   (no Chrome_WidgetWin_1 window owned by wshx-host/electron — app not running)');
  for (const r of rows) {
    const verdict = r.error === 1409 ? 'held  (a process owns it — owner not identified)' : r.error === 0 ? 'FREE  (nobody owns it)' : `error (win32 ${r.error})`;
    console.log(`  ${r.name.padEnd(18)} ${verdict}`);
  }
  console.log(`held=${held} free=${free} other=${other.length} total=${rows.length}`);
  if (probe.toggles) {
    const t = probe.toggles;
    if (t.error) console.log(`toggle   failed: ${t.error}`);
    else console.log(`toggle   ${t.name}: ${t.initial} → ${t.flipped} → ${t.final}  toggled=${t.toggled} restored=${t.restored} (taps=${t.taps}, restore taps=${t.flips})`);
  }
  console.log(summary);
}

process.exit(exit);
