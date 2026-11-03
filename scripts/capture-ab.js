'use strict';
// Capture A/B: prove the panel is excluded from screen capture.
//
// Fetches Chrome DevTools targets and drives them with the WebSocket
// implementation Chromium provides (Electron's bundled Node has no global
// WebSocket, and the npx launcher strips the runtime flags, so this is done
// through the page itself rather than a raw socket).
//
//   npx electron . --remote-debugging-port=9333     (in one shell)
//   node scripts/capture-ab.js                     (in another)
//
// Plain `node` works: the script needs the Electron runtime, so when it is not
// already running under Electron it re-executes itself with the bundled binary.

const electronModule = require('electron');
if (typeof electronModule === 'string') {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // otherwise the binary behaves as plain node
  delete env.NODE_OPTIONS;
  const r = spawnSync(electronModule, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exit(r.status ?? 1);
}

const { app, desktopCapturer, screen } = require('electron');
const http = require('http');

const PORT = Number(process.env.CDP_PORT || 9333);

const getJson = (path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

// Minimal CDP over the page's own WebSocket, evaluated from a hidden window is
// overkill; instead talk to the target with the ws implementation that Chromium
// exposes as globalThis.WebSocket inside a renderer. So: open our own window,
// then use node's built-in 'http' upgrade to speak CDP framing by hand.
const crypto = require('crypto');

function cdp(wsUrl) {
  const url = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: url.hostname, port: url.port, path: url.pathname,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
      },
    });
    req.on('upgrade', (res, socket) => {
      let id = 0;
      const pending = new Map();
      let buf = Buffer.alloc(0);

      const sendFrame = (text) => {
        const payload = Buffer.from(text);
        const mask = crypto.randomBytes(4);
        let header;
        if (payload.length < 126) {
          header = Buffer.alloc(2);
          header[1] = 0x80 | payload.length;
        } else {
          header = Buffer.alloc(4);
          header[1] = 0x80 | 126;
          header.writeUInt16BE(payload.length, 2);
        }
        header[0] = 0x81;
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        socket.write(Buffer.concat([header, mask, payload]));
      };

      const feed = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const len0 = buf[1] & 0x7f;
          let off = 2, len = len0;
          if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const body = buf.subarray(off, off + len).toString();
          buf = buf.subarray(off + len);
          try {
            const msg = JSON.parse(body);
            if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
          } catch {}
        }
      };

      socket.on('data', feed);
      socket.on('error', reject);

      resolve((expr) => new Promise((res) => {
        const i = ++id;
        pending.set(i, (msg) => res(msg.result));
        sendFrame(JSON.stringify({
          id: i, method: 'Runtime.evaluate',
          params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true },
        }));
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function hostRect() {
  const { execFileSync } = require('child_process');
  // MainWindowHandle is 0 for a tool window with no title (the whole point of the
  // shim), and a dev run is electron.exe rather than the packaged assistant.exe —
  // so enumerate the app's top-level windows and take the largest.
  const ps = `
Add-Type -TypeDefinition 'using System;using System.Collections.Generic;using System.Runtime.InteropServices;
public class W {
 public delegate bool Proc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Proc p, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC rc);
 [StructLayout(LayoutKind.Sequential)] public struct RC { public int l, t, r, b; }
 public static List<IntPtr> Find(uint[] pids) {
  var outp = new List<IntPtr>();
  EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid);
   foreach (var p in pids) if (p == pid && IsWindowVisible(h)) { RC rc; if (GetWindowRect(h, out rc) && rc.r - rc.l > 100) outp.Add(h); }
   return true; }, IntPtr.Zero);
  return outp; } }'
$procs = @(Get-Process electron,assistant -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { 'none'; exit }
$pids = New-Object 'uint32[]' $procs.Count
for ($i = 0; $i -lt $procs.Count; $i++) { $pids[$i] = [uint32]$procs[$i].Id }
$best = $null; $bestArea = 0
foreach ($h in [W]::Find($pids)) {
  $rc = New-Object W+RC
  [void][W]::GetWindowRect($h, [ref]$rc)
  $area = ($rc.r - $rc.l) * ($rc.b - $rc.t)
  if ($area -gt $bestArea) { $bestArea = $area; $best = $rc }
}
if (-not $best) { 'none'; exit }
"$($best.l) $($best.t) $($best.r - $best.l) $($best.b - $best.t)"
`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
  if (!out || out === 'none') return null;
  const [x, y, w, h] = out.split(/\s+/).map(Number);
  return { x, y, w, h };
}

async function regionHash(rect) {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  const img = sources[0] && sources[0].thumbnail;
  if (!img) throw new Error('no screen source');

  const bmp = img.toBitmap();
  const fullW = img.getSize().width;
  const px = (v) => Math.round(v * scale);
  const x0 = Math.max(0, px(rect.x + 60)), y0 = Math.max(0, px(rect.y + 200));
  const w = Math.min(px(200), fullW - x0);
  const h = Math.min(px(100), img.getSize().height - y0);
  if (w < 8 || h < 8) throw new Error('panel too small to sample');

  const hash = crypto.createHash('sha256');
  for (let row = 0; row < h; row++) {
    const start = ((y0 + row) * fullW + x0) * 4;
    hash.update(bmp.subarray(start, start + w * 4));
  }
  return hash.digest('hex').slice(0, 16);
}

app.whenReady().then(async () => {
  try {

    const targets = await getJson('/json/list');
    const t = targets.find((k) => k.type === 'page' && k.url.includes('renderer'));
    if (!t) throw new Error('run the app with --remote-debugging-port=' + PORT);
    const ev = await cdp(t.webSocketDebuggerUrl);

    // the app parks itself off-screen when hidden; a parked panel makes "shown" and
    // "hidden" both the desktop and the A/B meaningless
    if (!(await ev('window.glance.windowShown()'))) {
      await ev('window.glance.hide()');
      await new Promise((r) => setTimeout(r, 1200));
    }
    // resolve the region only now: showing can re-centre the window, and a stale
    // rect would make both captures sample empty desktop and "pass" for nothing
    const rect = hostRect();
    if (!rect) throw new Error('panel window not found');
    console.log('panel rect:', JSON.stringify(rect));

    const shown = await regionHash(rect);
    console.log('shown :', shown);
    await ev(`window.glance.hide()`);
    await new Promise((r) => setTimeout(r, 1500));
    const hidden = await regionHash(rect);
    console.log('hidden:', hidden);
    await ev(`window.glance.hide()`);
    await new Promise((r) => setTimeout(r, 1200));

    // Hash equality alone is noisy: an excluded capture shows the live desktop,
    // which changes between samples. The window-source frame does not have that
    // problem — a protected window returns 0x0 — so it decides the verdict and the
    // hashes are printed for context.
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 800, height: 600 } });
    const me = sources.find((s) => /assistant|wshx-host/i.test(s.name || ''));
    const size = me ? me.thumbnail.getSize() : null;
    const windowEmpty = size ? size.width < 8 || size.height < 8 : null;
    if (windowEmpty !== null) {
      console.log(`window source frame: ${size.width}x${size.height}${windowEmpty ? ' (empty)' : ''}`);
      console.log(windowEmpty
        ? '\nPASS — the window itself captures as an empty frame; a screen share receives no pixels'
        : '\nFAIL — the window still captures real pixels, a screen share can see it');
      app.exit(windowEmpty ? 0 : 1);
      return;
    }

    const same = shown === hidden;
    console.log('window source not listed — falling back to the pixel comparison');
    console.log(same ? '\nPASS (weak)' : '\nFAIL (weak)');
    app.exit(same ? 0 : 1);
  } catch (e) {
    console.error('ERR:', e.message);
    app.exit(1);
  }
});
