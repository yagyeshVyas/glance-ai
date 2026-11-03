'use strict';
// External capture test — "can another app's screen grab see the panel?"
//
// The capture runs in a separate PowerShell process over GDI BitBlt, the path
// Snipping Tool, Zoom's zVideoUI and legacy recorders use.
//
// Hashing the region is not a usable oracle here: with the panel excluded you see
// the live desktop *behind* it, which changes between samples. So this compares
// mean luminance over a large area instead, with two references taken under
// software control:
//   background  — panel hidden          (what an excluded capture should show)
//   panel       — panel shown, stealth off (what a captured panel shows)
//   test        — panel shown, stealth on
// PASS needs test to sit with the background, not with the panel, and needs the
// two references to be far enough apart to mean anything.
//
//   node scripts/external-capture-test.js     (app running, --remote-debugging-port=9333)

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.CDP_PORT || 9333);
const ps = (body) => {
  const f = path.join(os.tmpdir(), 'extcap-' + Date.now() + Math.random().toString(16).slice(2) + '.ps1');
  fs.writeFileSync(f, body);
  try { return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8' }).trim(); }
  finally { try { fs.unlinkSync(f); } catch {} }
};

const readRect = () => ps(`
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;
public class W { public delegate bool Proc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Proc p, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC rc);
 [StructLayout(LayoutKind.Sequential)] public struct RC { public int l, t, r, b; } }'
$procs = @(Get-Process assistant,electron -EA SilentlyContinue)
if ($procs.Count -eq 0) { 'none'; exit }
$targets = New-Object 'uint32[]' $procs.Count
for ($i = 0; $i -lt $procs.Count; $i++) { $targets[$i] = [uint32]$procs[$i].Id }
$script:best = $null; $script:area = 0
[W]::EnumWindows({ param($h, $l)
  $wpid = [uint32]0; [void][W]::GetWindowThreadProcessId($h, [ref]$wpid)
  if ($targets -contains $wpid -and [W]::IsWindowVisible($h)) {
    $r = New-Object W+RC; [void][W]::GetWindowRect($h, [ref]$r)
    $a = ($r.r - $r.l) * ($r.b - $r.t)
    if ($a -gt $script:area) { $script:area = $a; $script:best = $r } }
  return $true }, [IntPtr]::Zero) | Out-Null
if (-not $script:best) { 'none'; exit }
"$($script:best.l) $($script:best.t) $($script:best.r - $script:best.l) $($script:best.b - $script:best.t)"`);

// a big area well inside the panel

const luma = () => {
  const out = ps(`
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;
public class B { [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
 [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d,int x,int y,int w,int h,IntPtr s,int sx,int sy,int r);
 [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr d); }'
$bmp = New-Object System.Drawing.Bitmap ${sw}, ${sh}
$g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc(); $src = [B]::GetDC([IntPtr]::Zero)
[void][B]::BitBlt($hdc, 0, 0, ${sw}, ${sh}, $src, ${sx}, ${sy}, 0x00CC0020)
[void][B]::ReleaseDC([IntPtr]::Zero, $src); $g.ReleaseHdc($hdc); $g.Dispose()
$sum = 0.0; $n = 0
for ($y = 0; $y -lt ${sh}; $y += 4) { for ($x = 0; $x -lt ${sw}; $x += 4) {
  $c = $bmp.GetPixel($x, $y); $sum += (0.2126*$c.R + 0.7152*$c.G + 0.0722*$c.B); $n++ } }
$bmp.Dispose()
[math]::Round($sum / $n, 2)`);
  return Number(out);
};

const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let raw = ''; r.on('data', (c) => raw += c); r.on('end', () => { try { res(JSON.parse(raw)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
function cdp(wsUrl) {
  const url = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
    req.on('upgrade', (_r, s) => {
      let id = 0; const pend = new Map(); let buf = Buffer.alloc(0);
      const send = (t) => { const p = Buffer.from(t); const m = crypto.randomBytes(4);
        let h; if (p.length < 126) { h = Buffer.alloc(2); h[1] = 0x80 | p.length; } else { h = Buffer.alloc(4); h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
        h[0] = 0x81; for (let i = 0; i < p.length; i++) p[i] ^= m[i % 4]; s.write(Buffer.concat([h, m, p])); };
      s.on('data', (c) => { buf = Buffer.concat([buf, c]);
        for (;;) { if (buf.length < 2) return; const l0 = buf[1] & 0x7f; let off = 2, len = l0;
          if (l0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          if (buf.length < off + len) return;
          const body = buf.subarray(off, off + len).toString(); buf = buf.subarray(off + len);
          try { const msg = JSON.parse(body); if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); } } catch {} } });
      s.on('error', reject);
      resolve((expr) => new Promise((res) => { const i = ++id; pend.set(i, (m) => res(m.result));
        send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true } })); }));
    });
    req.on('error', reject); req.end();
  });
}

let sx = 0, sy = 0, sw = 0, sh = 0; // region, resolved after the panel is known to be shown
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const avg = async (n = 3) => { const v = []; for (let i = 0; i < n; i++) { v.push(luma()); await sleep(500); } return v.reduce((a, b) => a + b, 0) / v.length; };

(async () => {
  const t = (await getJson('/json/list')).find((k) => k.type === 'page' && k.url.includes('renderer'));
  if (!t) throw new Error('no renderer target — start with --remote-debugging-port=' + PORT);
  const ev = await cdp(t.webSocketDebuggerUrl);



  // the app may be parked off-screen from a previous hide; a hidden panel makes all
  // three references identical and the test meaningless
  if (!(await ev('window.glance.windowShown()'))) {
    await ev('window.glance.hide()');
    await sleep(1200);
  }

  // resolve the region only now: showing the panel can re-centre it
  const RECT = readRect();
  if (!RECT || RECT === 'none') throw new Error('panel window not found');
  const [px, py, pw, ph] = RECT.split(/\s+/).map(Number);
  sx = px + Math.round(pw * 0.2);
  sy = py + Math.round(ph * 0.3);
  sw = Math.min(420, Math.round(pw * 0.6));
  sh = Math.min(260, Math.round(ph * 0.45));
  console.log(`region ${sx},${sy} ${sw}x${sh} inside panel ${px},${py} ${pw}x${ph} (GDI, external process)`);

  await ev('window.glance.setConfig({ stealth: false })');
  await sleep(1200);
  const panel = await avg();
  console.log('shown, protection OFF :', panel.toFixed(2), '(panel palette)');

  await ev('window.glance.hide()');
  await sleep(1400);
  const background = await avg();
  console.log('hidden, background    :', background.toFixed(2));

  await ev('window.glance.hide()');
  await sleep(1200);
  await ev('window.glance.setConfig({ stealth: true })');
  await sleep(1400);
  const test = await avg();
  console.log('shown, protection ON  :', test.toFixed(2));

  await sleep(400);
  const gap = Math.abs(panel - background);
  const toBg = Math.abs(test - background);
  const toPanel = Math.abs(test - panel);

  console.log('');
  console.log(`reference separation  : ${gap.toFixed(2)} (needs > 4)`);
  console.log(`test distance to bg    : ${toBg.toFixed(2)}`);
  console.log(`test distance to panel : ${toPanel.toFixed(2)}`);
  const ok = gap > 4 && toBg < toPanel;
  console.log(ok
    ? 'PASS — an outside process captured the screen and the panel was not in it'
    : 'FAIL — the capture looks like the panel, not the background');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
