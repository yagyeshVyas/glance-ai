'use strict';
// Regression probe for the self-capture compositor.
//
//   node scripts/composite-probe.js [--port 9333]
//
// It asserts the two properties that make the compositing safe together:
//
//   1. the display-affinity flag never moves during a capture (0x11 in every
//      sample, not "was 0x11 before and after"), and
//   2. the frame the app produces still contains the panel — a `composite:` line
//      with a non-zero rectangle per capture.
//
// Either alone is a trap: dropping the flag also satisfies 2, and never
// compositing satisfies 1. Run it against a dev instance started with
//
//   RB_PROFILE_DIR=%TEMP%\rb-dev-profile <electron> . --remote-debugging-port=9333
//
// so the probe does not collide with an installed copy's single-instance lock.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { list, evaluate } = require('./cdp-eval');

const POLLS = 300;
const INTERVAL_MS = 8;

const SAMPLER = `
param([int]$Polls = ${POLLS}, [int]$IntervalMs = ${INTERVAL_MS})
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public class RBProbe {
 public delegate bool P(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint f);
 [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 public static List<IntPtr> Hosts(uint[] pids) {
  var o = new List<IntPtr>();
  EnumWindows((h, l) => {
    uint p; GetWindowThreadProcessId(h, out p);
    if (Array.IndexOf(pids, p) < 0) return true;
    var c = new StringBuilder(256); GetClassName(h, c, 256);
    if (c.ToString().StartsWith("Windows.UI.Core")) o.Add(h);
    return true; }, IntPtr.Zero);
  return o; } }
'@
$procs = @(Get-Process electron -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { "no-electron"; exit 2 }
$ids = [uint32[]]@($procs | Select-Object -ExpandProperty Id)
$hosts = [RBProbe]::Hosts($ids)
if (-not $hosts.Count) { "no-host"; exit 2 }
$seen = [ordered]@{}
for ($i = 0; $i -lt $Polls; $i++) {
  foreach ($h in $hosts) {
    $f = [uint32]0
    $ok = [RBProbe]::GetWindowDisplayAffinity($h, [ref]$f)
    $key = if ($ok) { "0x{0:x}" -f $f } else { 'unreadable' }
    if (-not $seen.Contains($key)) { $seen[$key] = $i }
  }
  Start-Sleep -Milliseconds $IntervalMs
}
"hosts=$($hosts.Count)"
foreach ($k in $seen.Keys) { "value=$k" }
`;

function traceLog() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, '.glance-trace.log');
}

function readTrace() {
  try { return fs.readFileSync(traceLog(), 'utf8'); } catch { return ''; }
}

function compositesIn(text) {
  return text.split(/\r?\n/).filter((l) => l.includes('composite:'));
}

async function main() {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf('--port');
  const port = Number(pi >= 0 ? argv[pi + 1] : (process.env.CDP_PORT || 9333));

  const targets = await list(port);
  const page = targets.find((t) => t.type === 'page' && /index\.html|renderer/i.test(t.url || '')) ||
    targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target on port ' + port + ' — start the app with --remote-debugging-port');

  const evalIn = (expr) => evaluate(page.webSocketDebuggerUrl, expr);
  const shown = await evalIn('window.glance.windowShown()');
  if (!shown || shown.value !== true) {
    throw new Error('the panel is hidden — show it (Ctrl+Shift+H) and run again; a hidden panel has nothing to composite');
  }

  const before = compositesIn(readTrace()).length;

  const ps1 = path.join(os.tmpdir(), 'rb-composite-probe-' + process.pid + '.ps1');
  fs.writeFileSync(ps1, SAMPLER);
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true });
  let sampled = '';
  child.stdout.on('data', (d) => { sampled += d; });
  child.stderr.on('data', (d) => { sampled += d; });

  // Two captures inside the sampling window: one is enough to prove the flag
  // stays put, two prove it is not a one-off.
  await new Promise((r) => setTimeout(r, 300));
  const shot = await evalIn("(async()=>{const a=await window.glance.captureOne();const b=await window.glance.captureOne();return [!!(a&&a.b64),!!(b&&b.b64)].join(',');})()");
  const bothCaptured = String(shot && shot.value) === 'true,true';

  await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, (POLLS * INTERVAL_MS) + 4000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
  try { fs.unlinkSync(ps1); } catch {}

  const after = compositesIn(readTrace());
  const fresh = after.slice(before);
  const rects = fresh
    .map((l) => /composite: (\d+) px at (-?\d+),(-?\d+) (\d+)x(\d+)/.exec(l))
    .filter(Boolean)
    .map((m) => ({ px: Number(m[1]), x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]) }));

  const values = [...sampled.matchAll(/value=(0x[0-9a-f]+|unreadable)/g)].map((m) => m[1]);
  const hosts = /hosts=(\d+)/.exec(sampled);

  const problems = [];
  if (!hosts) problems.push('the affinity sampler did not find the host window');
  if (!values.length) problems.push('no affinity samples were taken');
  if (values.some((v) => v !== '0x11')) problems.push('display affinity left 0x11 during the capture: ' + values.join(', '));
  if (!bothCaptured) problems.push('captureOne() did not return both frames');
  if (rects.length < 2) problems.push('expected 2 composite runs, saw ' + rects.length);
  if (rects.some((r) => r.w < 8 || r.h < 8)) problems.push('a composite rectangle was degenerate');

  console.log(`host windows : ${hosts ? hosts[1] : '?'}`);
  console.log(`affinity     : ${values.length ? [...new Set(values)].join(', ') : 'none'} over ${POLLS} samples (${INTERVAL_MS} ms apart)`);
  console.log(`composites   : ${rects.length} — ${rects.map((r) => `${r.w}x${r.h} at ${r.x},${r.y} (${r.px} px)`).join('; ') || 'none'}`);

  if (problems.length) {
    console.error('\nFAIL');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('\nPASS — the flag stayed 0x11 and every capture still contains the panel');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
