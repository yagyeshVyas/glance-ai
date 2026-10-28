#!/usr/bin/env node
// Detection audit — enumerate what a proctoring / monitoring / forensic tool can
// see on this machine while wshx-host is running. Read-only: it queries window and
// process state through Win32 and changes nothing. The point is to validate a
// detector (prove wshx-host is visible to it), not to hide wshx-host from one.
//
// Run: node scripts/detect-audit.js [--all] [--pid <pid>] [--json] [--fail-on-detect] [--ps]
//   --all             list every visible top-level window, not just flagged ones
//   --pid <pid>       restrict the window table to one process
//   --json            machine-readable output (for a detector test harness)
//   --fail-on-detect  exit 1 when anything is flagged (use as a CI gate)
//   --ps              force the PowerShell probe (debug / no C# compiler)
//   --all-procs       list every process with a readable path, not just suspects
//
// Two engines, same output:
//   native      scripts/detect-audit-probe.cs, compiled once with the in-box
//               .NET Framework csc.exe and cached in %TEMP%\wshx-audit. ~120 ms.
//   powershell  fallback when csc.exe is missing or compilation fails. ~0.9 s,
//               because powershell.exe startup alone is ~0.35 s.
//
// Signals collected, i.e. what a detector can read:
//   GetWindowDisplayAffinity      0x11 = WDA_EXCLUDEFROMCAPTURE, 0x1 = WDA_MONITOR
//   GetWindowLongPtr(GWL_EXSTYLE) WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TOOLWINDOW | ...
//   GetWindowLongPtr(GWL_STYLE)   no WS_CAPTION / WS_THICKFRAME / WS_CHILD = frameless
//   GetWindowRect + GetSystemMetrics  how much of the screen the window covers
//   EnumWindows + GetClassNameW/GetWindowTextW  class + title of every top-level window
//   CreateToolhelp32Snapshot + QueryFullProcessImageNameW  process tree with full paths
//   FileVersionInfo               the description/company Task Manager shows
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureProbe } = require('./build-probe');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argVal = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (has('--help') || has('-h')) {
  console.log('node scripts/detect-audit.js [--all] [--pid <pid>] [--json] [--fail-on-detect] [--ps] [--all-procs]');
  process.exit(0);
}
if (process.platform !== 'win32') {
  console.error('detect-audit: Windows only (uses user32/dwmapi/kernel32)');
  process.exit(2);
}

// Strict parse: a wrong PID used to be swallowed (NaN/0 mean "no filter"), so a
// CI harness could audit everything or nothing and still get a clean exit.
let onlyPid = null;
if (has('--pid')) {
  const value = argVal('--pid');
  if (value === undefined || !/^\d+$/.test(value) || Number(value) <= 0) {
    console.error(`detect-audit: --pid needs a positive integer, got ${JSON.stringify(value)}`);
    process.exit(2);
  }
  onlyPid = Number(value);
}
const showAll = has('--all');
const asJson = has('--json');
const forcePs = has('--ps');

// ---------- native engine ----------
function decodeB64(s) {
  return s ? Buffer.from(s, 'base64').toString('utf8') : '';
}

function probeNative() {
  // compile/validate + cache lives in one place: scripts/build-probe.js
  const built = ensureProbe();
  if (!built.ok) throw new Error(built.reason);
  const exe = built.exe;

  const runOpts = {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
    windowsHide: true,
  };
  let out;
  try {
    out = execFileSync(exe, [], runOpts);
  } catch (err) {
    // A cached file that will not run (AV stub, truncation) must not pin every
    // later run to the fallback: drop it, rebuild once, retry once.
    try {
      fs.unlinkSync(exe);
    } catch {}
    try {
      fs.unlinkSync(exe + '.verified');
    } catch {}
    const rebuilt = ensureProbe();
    if (!rebuilt.ok) throw err;
    out = execFileSync(rebuilt.exe, [], runOpts);
  }

  const data = { screen: { w: 0, h: 0 }, probeMs: 0, windows: [], processes: [] };
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const f = line.split('\t');
    if (f[0] === 'M') {
      data.screen = { w: Number(f[1]), h: Number(f[2]) };
      data.probeMs = Number(f[3]);
    } else if (f[0] === 'W') {
      data.windows.push({
        hwnd: Number(f[1]),
        pid: Number(f[2]),
        ex: Number(f[3]),
        style: Number(f[4]),
        w: Number(f[5]),
        h: Number(f[6]),
        affinity: Number(f[7]),
        title: decodeB64(f[8]),
        cls: decodeB64(f[9]),
      });
    } else if (f[0] === 'P') {
      data.processes.push({
        pid: Number(f[1]),
        ppid: Number(f[2]),
        name: decodeB64(f[3]),
        path: decodeB64(f[4]),
        desc: decodeB64(f[5]),
        company: decodeB64(f[6]),
      });
    }
  }
  if (data.windows.length === 0 && data.processes.length === 0) {
    throw new Error('native probe returned no records');
  }
  return data;
}

// ---------- PowerShell fallback ----------
// Same data, one process. Kept for machines without the in-box C# compiler.
const PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int left; public int top; public int right; public int bottom; }

[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct PROCESSENTRY32W {
  public uint dwSize;
  public uint cntUsage;
  public uint th32ProcessID;
  public IntPtr th32DefaultHeapID;
  public uint th32ModuleID;
  public uint cntThreads;
  public uint th32ParentProcessID;
  public int pcPriClassBase;
  public uint dwFlags;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szExeFile;
}

public static class W {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong32(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W pe);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W pe);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder sb, ref uint size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$sw = [System.Diagnostics.Stopwatch]::StartNew()

$screenW = [W]::GetSystemMetrics(0)
$screenH = [W]::GetSystemMetrics(1)

$rows = New-Object System.Collections.Generic.List[object]
$cb = [W+EnumWindowsProc]{
  param([IntPtr]$h, [IntPtr]$l)
  try {
    if ([W]::IsWindowVisible($h)) {
      $cloaked = [int]0
      [void][W]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4)
      if ($cloaked -eq 0) {
        $t = New-Object System.Text.StringBuilder 512
        [void][W]::GetWindowTextW($h, $t, 512)
        $c = New-Object System.Text.StringBuilder 256
        [void][W]::GetClassNameW($h, $c, 256)
        $procId = [uint32]0
        [void][W]::GetWindowThreadProcessId($h, [ref]$procId)
        $ex = [int64]0
        $style = [int64]0
        if ([Environment]::Is64BitProcess) {
          $ex = [W]::GetWindowLongPtr($h, -20).ToInt64()
          $style = [W]::GetWindowLongPtr($h, -16).ToInt64()
        } else {
          $ex = [int64][W]::GetWindowLong32($h, -20)
          $style = [int64][W]::GetWindowLong32($h, -16)
        }
        $aff = [uint32]0
        $ok = [W]::GetWindowDisplayAffinity($h, [ref]$aff)
        $affinity = [int]-1
        if ($ok) { $affinity = [int]$aff }
        $r = New-Object RECT
        $w = [int]0
        $hh = [int]0
        if ([W]::GetWindowRect($h, [ref]$r)) {
          $w = $r.right - $r.left
          $hh = $r.bottom - $r.top
        }
        $rows.Add([pscustomobject]@{
          hwnd = $h.ToInt64()
          pid = [int]$procId
          title = $t.ToString()
          cls = $c.ToString()
          ex = $ex
          style = $style
          w = $w
          h = $hh
          affinity = $affinity
        })
      }
    }
  } catch { }
  return $true
}
[void][W]::EnumWindows($cb, [IntPtr]::Zero)

$winPids = New-Object System.Collections.Generic.HashSet[int]
foreach ($r in $rows) { [void]$winPids.Add([int]$r.pid) }

$procs = New-Object System.Collections.Generic.List[object]
$snap = [W]::CreateToolhelp32Snapshot(2, 0)
if ($snap -ne [IntPtr]::Zero -and $snap.ToInt64() -ne -1) {
  try {
    $pe = New-Object PROCESSENTRY32W
    $pe.dwSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type][PROCESSENTRY32W])
    $more = [W]::Process32FirstW($snap, [ref]$pe)
    while ($more) {
      $procId = [int]$pe.th32ProcessID
      $name = $pe.szExeFile
      $path = ''
      $desc = ''
      $company = ''
      $h = [W]::OpenProcess(0x1000, $false, [uint32]$procId)
      if ($h -ne [IntPtr]::Zero) {
        try {
          $sb = New-Object System.Text.StringBuilder 1024
          $len = [uint32]1024
          if ([W]::QueryFullProcessImageNameW($h, 0, $sb, [ref]$len)) { $path = $sb.ToString() }
        } catch { }
        [void][W]::CloseHandle($h)
      }
      # UNC paths would make FileVersionInfo do outbound SMB; never read their version resource
      if ($path -and -not $path.StartsWith('\\\\') -and ($winPids.Contains($procId) -or $name -match 'wshx-host|electron|node')) {
        try {
          $vi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path)
          $desc = $vi.FileDescription
          $company = $vi.CompanyName
        } catch { }
      }
      $procs.Add([pscustomobject]@{
        pid = $procId
        ppid = [int]$pe.th32ParentProcessID
        name = $name
        path = $path
        desc = $desc
        company = $company
      })
      $more = [W]::Process32NextW($snap, [ref]$pe)
    }
  } finally { [void][W]::CloseHandle($snap) }
}

[pscustomobject]@{
  screen = [pscustomobject]@{ w = $screenW; h = $screenH }
  windows = $rows
  processes = $procs
  probeMs = [int]$sw.ElapsedMilliseconds
} | ConvertTo-Json -Depth 6 -Compress
`;

// Absolute paths only: `powershell.exe` / `pwsh` on PATH can be shadowed by
// node_modules/.bin, which npm puts first during `npm run`.
function powershellPath() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(p) ? p : null;
}

function pwshPath() {
  const p = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return fs.existsSync(p) ? p : null;
}

function probePowerShell() {
  const b64 = Buffer.from(PS, 'utf16le').toString('base64');
  const opts = {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60000,
    windowsHide: true,
  };
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64];
  // Try Windows PowerShell, then pwsh: existence of the first does not prove it
  // can run (AppLocker/WDAC, Constrained Language Mode, corrupted install).
  const errors = [];
  let out = null;
  for (const exe of [powershellPath(), pwshPath()].filter(Boolean)) {
    try {
      out = execFileSync(exe, args, opts);
      break;
    } catch (err) {
      errors.push(`${path.basename(exe)}: ${err.message}`);
    }
  }
  if (out === null) throw new Error(errors.join('; ') || 'no PowerShell found (System32 or Program Files\\PowerShell\\7)');
  const data = JSON.parse(out);
  data.windows = [].concat(data.windows || []).map((w) => ({
    hwnd: w.hwnd,
    pid: Number(w.pid),
    title: String(w.title || ''),
    cls: String(w.cls || ''),
    // >>> 0 keeps the two engines identical: the PowerShell copy sign-extends
    // style values, the C# probe zero-extends them
    ex: Number(w.ex) >>> 0,
    style: Number(w.style) >>> 0,
    w: Number(w.w) || 0,
    h: Number(w.h) || 0,
    affinity: Number(w.affinity),
  }));
  data.processes = [].concat(data.processes || []).map((p) => ({
    pid: Number(p.pid),
    ppid: Number(p.ppid),
    name: String(p.name || ''),
    path: String(p.path || ''),
    desc: String(p.desc || ''),
    company: String(p.company || ''),
  }));
  return data;
}

// ---------- classification ----------
const EX = {
  TOPMOST: 0x8,
  TRANSPARENT: 0x20,
  TOOLWINDOW: 0x80,
  LAYERED: 0x80000,
  NOACTIVATE: 0x08000000,
};
const STYLE = {
  CHILD: 0x40000000,
  THICKFRAME: 0x00040000,
  CAPTION: 0x00c00000,
};
const AFFINITY_NAME = { '-1': 'unknown', 0: 'none', 1: 'WDA_MONITOR', 17: 'WDA_EXCLUDEFROMCAPTURE' };

// Desktop/shell windows share the overlay shape (topmost, frameless, no caption)
// but are not overlays. Excluding them by class keeps the signal clean.
const SHELL_CLASSES = new Set([
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'Progman',
  'WorkerW',
  'NotifyIconOverflowWindow',
  'tooltips_class32',
  'MSCTFIME UI',
  'IME',
  'Base_PowerMessageWindow',
]);

function exFlags(ex) {
  const out = [];
  if (ex & EX.TOPMOST) out.push('TOPMOST');
  if (ex & EX.TOOLWINDOW) out.push('TOOLWINDOW');
  if (ex & EX.LAYERED) out.push('LAYERED');
  if (ex & EX.TRANSPARENT) out.push('CLICKTHRU');
  if (ex & EX.NOACTIVATE) out.push('NOACTIVATE');
  return out;
}

// Frameless = no title bar, no resize border, not a child control. This does not
// require WS_POPUP: Electron uses WS_OVERLAPPED (0) plus frame:false, measured
// as style 0x14030000 — visible, no caption, no thick frame.
function isFrameless(style) {
  return !(style & STYLE.CAPTION) && !(style & STYLE.THICKFRAME) && !(style & STYLE.CHILD);
}

// A window is "flagged" when a detector has a concrete signal, not a guess.
function verdict(w, screenArea) {
  const v = [];
  if (w.affinity === 17) v.push('capture-excluded');
  if (w.affinity === 1) v.push('capture-monitored');
  const area = Math.max(0, w.w) * Math.max(0, w.h);
  const big = screenArea > 0 && area / screenArea >= 0.05;
  const shaped = isFrameless(w.style) && (w.ex & EX.TOPMOST) && (w.ex & (EX.LAYERED | EX.TRANSPARENT)) && big;
  if (shaped && !SHELL_CLASSES.has(w.cls)) v.push('overlay-shaped');
  return v;
}

function clean(s, n) {
  return String(s || '')
    // C0, DEL and C1 (0x80–0x9f) — C1 includes the 8-bit CSI, ESC is in C0
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim()
    .slice(0, n);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

// ---------- main ----------
let data = null;
let engine = 'native';
let fallbackReason = '';

if (!forcePs) {
  try {
    data = probeNative();
  } catch (err) {
    fallbackReason = err.message;
    if (/csc\.exe not found/.test(err.message)) fallbackReason = 'no C# compiler';
  }
}
if (!data) {
  engine = 'powershell';
  try {
    data = probePowerShell();
  } catch (err) {
    console.error(`detect-audit: probe failed (native: ${fallbackReason || 'forced --ps'}; powershell: ${err.message})`);
    if (err.stderr) console.error(String(err.stderr).slice(0, 600));
    process.exit(2);
  }
}
if (fallbackReason && engine === 'powershell' && !asJson) {
  console.error(`detect-audit: native probe unavailable (${fallbackReason}) — using PowerShell, ~0.9 s instead of ~0.2 s`);
}

const screen = data.screen || { w: 0, h: 0 };
const screenArea = Number(screen.w) * Number(screen.h);
const probeMs = Number(data.probeMs) || 0;

const windows = [].concat(data.windows || []).map((w) => {
  const base = {
    hwnd: w.hwnd,
    pid: Number(w.pid),
    title: String(w.title || ''),
    cls: String(w.cls || ''),
    // >>> 0 keeps the two engines identical: the PowerShell copy sign-extends
    // style values, the C# probe zero-extends them
    ex: Number(w.ex) >>> 0,
    style: Number(w.style) >>> 0,
    w: Number(w.w) || 0,
    h: Number(w.h) || 0,
    affinity: Number(w.affinity),
  };
  return {
    ...base,
    flags: exFlags(base.ex),
    frameless: isFrameless(base.style),
    verdict: verdict(base, screenArea),
  };
});
// Free text from other processes is attacker-controlled (version resources are
// arbitrary strings). Strip control characters and cap length before printing.
const processes = [].concat(data.processes || []).map((p) => ({
  pid: Number(p.pid),
  ppid: Number(p.ppid),
  name: clean(p.name, 120),
  path: clean(p.path, 400),
  desc: clean(p.desc, 200),
  company: clean(p.company, 120),
}));
const byPid = new Map(processes.map((p) => [p.pid, p]));

const scoped = onlyPid ? windows.filter((w) => w.pid === onlyPid) : windows;
if (onlyPid && scoped.length === 0) {
  // a wrong PID must not look like a clean audit
  console.error(`detect-audit: pid ${onlyPid} has no visible top-level windows`);
  process.exit(2);
}
const flagged = scoped.filter((w) => w.verdict.length > 0);
const shown = (showAll ? scoped : flagged)
  .slice()
  .sort((a, b) => b.verdict.length - a.verdict.length || a.pid - b.pid);

// --all-procs closes the "renamed app, no window" gap: every process whose image
// path is readable is listed, not only name matches and window owners.
const suspects = has('--all-procs')
  ? processes.filter((p) => p.path)
   : processes.filter((p) => /wshx-host|electron/i.test(p.name) || flagged.some((w) => w.pid === p.pid));

// The CI gate covers both signals: a window verdict and the process identity a
// detector would scrape. Previously a process-only match (no flagged window)
// exited 0 while printing wshx-host.exe.
const processHits = processes.filter((p) => /wshx-host|electron/i.test(p.name) && (!onlyPid || p.pid === onlyPid));
const degraded = !(Number(screen.w) > 0) || processes.length === 0;

if (degraded && !asJson) {
  console.error(
    'detect-audit: degraded — no screen metrics or no process list; this usually means a non-interactive session (service, CI agent), so the result is not what a detector in the user session sees'
  );
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        engine,
        fallbackReason: engine === 'powershell' ? fallbackReason || 'forced --ps' : null,
        degraded,
        screen,
        probeMs,
        scanned: scoped.length,
        flagged: flagged.length,
        processHits: processHits.length,
        windows: shown,
        processes: suspects,
      },
      null,
      2
    )
  );
} else {
  console.log(
    `scanned ${scoped.length} visible top-level windows, flagged ${flagged.length} (${engine} probe ${probeMs} ms)\n`
  );
  if (shown.length) {
    console.log(
      pad('PID', 8) + pad('PROCESS', 20) + pad('AFFINITY', 23) + pad('EX-STYLE', 26) + pad('TITLE', 26) + 'VERDICT'
    );
    console.log('-'.repeat(126));
    for (const w of shown) {
      const proc = byPid.get(w.pid);
      console.log(
        pad(w.pid, 8) +
          pad(clean(proc ? proc.name : '?', 19), 20) +
          pad(AFFINITY_NAME[String(w.affinity)] || `0x${w.affinity.toString(16)}`, 23) +
          pad(w.flags.join('|') || '-', 26) +
          pad(clean(w.title, 25) || '(no title)', 26) +
          (w.verdict.join(', ') || 'clean')
      );
    }
  } else {
    console.log('no detector-relevant windows found');
  }

  if (suspects.length) {
    console.log('\nprocess identity (what a process-scraping detector sees):');
    for (const p of suspects) {
      const indent = p.ppid ? `  parent pid ${p.ppid}` : '';
      console.log(`  ${p.pid}  ${p.name}${indent}`);
      if (p.path) console.log(`        ${p.path}`);
      if (p.desc || p.company) console.log(`        ${p.desc || '(no description)'} / ${p.company || '(no company)'}`);
    }
  }

  if (!showAll) console.log('\n(--all lists every visible window; --json for machine output)');
}

if (degraded) process.exit(2); // never report a clean result from a blind session
if (has('--fail-on-detect') && (flagged.length > 0 || processHits.length > 0)) {
  // Say why: a log that prints "flagged 0" and exits 1 is not actionable.
  console.error(`detect-audit: fail-on-detect — ${flagged.length} flagged window(s), ${processHits.length} process hit(s)`);
  process.exit(1);
}
