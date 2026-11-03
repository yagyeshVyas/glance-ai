'use strict';
// Does WDA_EXCLUDEFROMCAPTURE actually work on this machine right now, and does
// the app's own call reach the right window? Sets the flag from OUTSIDE the app
// and hashes the same region at each state, against a panel-hidden baseline.
//
//   node scripts/affinity-probe.js

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.CDP_PORT || 9333);
const run = (body) => {
  const f = path.join(os.tmpdir(), 'aff-' + Date.now() + Math.random().toString(16).slice(2) + '.ps1');
  fs.writeFileSync(f, body);
  try { return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8' }).trim(); }
  finally { try { fs.unlinkSync(f); } catch {} }
};

const HOST = run(`
Add-Type -TypeDefinition 'using System;using System.Collections.Generic;using System.Runtime.InteropServices;
public class E { public delegate bool P(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 public static List<IntPtr> V(uint[] t) { var o = new List<IntPtr>();
  EnumWindows((h,l) => { uint p; GetWindowThreadProcessId(h, out p); if (Array.IndexOf(t, p) >= 0 && IsWindowVisible(h)) o.Add(h); return true; }, IntPtr.Zero); return o; } }'
$ps = @(Get-Process assistant,electron -EA SilentlyContinue)
if ($ps.Count -eq 0) { 'none'; exit }
$ids = New-Object 'uint32[]' $ps.Count
for ($i=0; $i -lt $ps.Count; $i++) { $ids[$i] = [uint32]$ps[$i].Id }
$w = [E]::V($ids)
if ($w.Count -eq 0) { 'none'; exit }
$w[0]`);
if (!HOST || HOST === 'none') { console.error('no visible app window'); process.exit(2); }

const setFlag = (f) => run(`
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;
public class A { [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint f);
 [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint f); }'
$ok = [A]::SetWindowDisplayAffinity([IntPtr]${HOST}, ${f})
$now = 0; [void][A]::GetWindowDisplayAffinity([IntPtr]${HOST}, [ref]$now)
"set=$ok now=0x{0:x}" -f $now`);

const hash = () => crypto.createHash('sha256').update(Buffer.from(run(`
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;
public class B { [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
 [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d,int x,int y,int w,int h,IntPtr s,int sx,int sy,int r);
 [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr d); }'
$bmp = New-Object System.Drawing.Bitmap 160, 100
$g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc(); $src = [B]::GetDC([IntPtr]::Zero)
[void][B]::BitBlt($hdc, 0, 0, 160, 100, $src, 820, 400, 0x00CC0020)
[void][B]::ReleaseDC([IntPtr]::Zero, $src); $g.ReleaseHdc($hdc); $g.Dispose()
$ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp)
-join ([System.Security.Cryptography.SHA256]::Create().ComputeHash($ms.ToArray()) | ForEach-Object { $_.ToString('x2') })`))).digest('hex').slice(0, 16);

// minimal CDP: hide/show only
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const t = (await getJson('/json/list')).find((k) => k.type === 'page' && k.url.includes('renderer'));
  if (!t) throw new Error('no renderer target (start with --remote-debugging-port=' + PORT + ')');
  const ev = await cdp(t.webSocketDebuggerUrl);

  console.log('host hwnd:', HOST);
  console.log('app-set flag  :', setFlag(17), '→', hash());

  await ev('window.glance.hide()');
  await sleep(1400);
  const hidden = hash();
  console.log('panel hidden  :', hidden);
  await ev('window.glance.hide()');
  await sleep(1200);

  console.log('flag 17 again :', setFlag(17), '→', hash());
  console.log('flag 0        :', setFlag(0), '→', hash());
  console.log('hidden baseline:', hidden);
  setFlag(17);
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
