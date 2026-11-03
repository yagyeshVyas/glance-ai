'use strict';
// Diagnostic 2: is DWMWA_EXCLUDED_FROM_CAPTURE honored at all on this build?
// Checks the readback, GetWindowDisplayAffinity, and two capture engines
// (Electron/WGC and GDI BitBlt). Also tries the child window and pre-show ordering.
//
//   npx electron scripts/dwm-exclude-probe.js

// plain `node` cannot use the Electron API: re-exec under the bundled binary
const electronModule = require('electron');
if (typeof electronModule === 'string') {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  process.exit(spawnSync(electronModule, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env }).status ?? 1);
}

const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');

const nat = require(path.join(__dirname, '..', 'src', 'native', process.arch, 'cloak.node'));
const hwndOf = (w) => w.getNativeWindowHandle().readUInt32LE(0);

function ps(script) {
  const f = path.join(require('os').tmpdir(), 'dwm-probe-' + Date.now() + '.ps1');
  require('fs').writeFileSync(f, script);
  try { return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8' }).trim(); }
  finally { try { require('fs').unlinkSync(f); } catch {} }
}

const AFFINITY_PS = (h) => `
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;
public class A { [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a); }'
$f = 0; [void][A]::GetWindowDisplayAffinity([IntPtr]${h}, [ref]$f); $f`;

const BITBLT_PS = (x, y, w, h) => `
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;
public class B { [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
 [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d,int x,int y,int w,int h,IntPtr s,int sx,int sy,int r);
 [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr d); }'
$bmp = New-Object System.Drawing.Bitmap ${w}, ${h}
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc(); $src = [B]::GetDC([IntPtr]::Zero)
[void][B]::BitBlt($hdc, 0, 0, ${w}, ${h}, $src, ${x}, ${y}, 0x00CC0020)
[void][B]::ReleaseDC([IntPtr]::Zero, $src); $g.ReleaseHdc($hdc); $g.Dispose()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp)
$sha = [System.Security.Cryptography.SHA256]::Create()
-join ($sha.ComputeHash($ms.ToArray())[0..7] | ForEach-Object { $_.ToString('x2') })`;

async function electronHash(rect) {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
  });
  const img = sources[0].thumbnail;
  const bmp = img.toBitmap();
  const fullW = img.getSize().width;
  const px = (v) => Math.round(v * scale);
  const x0 = Math.max(0, px(rect.x + 40)), y0 = Math.max(0, px(rect.y + 40));
  const w = Math.min(px(180), fullW - x0), h = Math.min(px(120), img.getSize().height - y0);
  const hash = crypto.createHash('sha256');
  for (let row = 0; row < h; row++) { const s = ((y0 + row) * fullW + x0) * 4; hash.update(bmp.subarray(s, s + w * 4)); }
  return hash.digest('hex').slice(0, 16);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    x: 140, y: 140, width: 700, height: 500, frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, backgroundColor: '#ff000000',
  });
  await win.loadURL('data:text/html,' + encodeURIComponent(
    '<body style="margin:0;background:#0b1020"><div style="height:150px;background:#e8453c"></div>' +
    '<div style="height:350px;background:#2f6fed"></div></body>'));
  win.showInactive();
  await new Promise((r) => setTimeout(r, 1000));

  const child = hwndOf(win);
  const host = nat.attachHost(child).host;
  await new Promise((r) => setTimeout(r, 700));
  const rect = win.getBounds();
  const { x, y, width, height } = rect;

  const snap = async (label) => {
    const gdi = ps(BITBLT_PS(x + 40, y + 40, 180, 120));
    const wgc = await electronHash(rect);
    console.log(`${label.padEnd(26)} gdi=${gdi}  wgc=${wgc}`);
    return { gdi, wgc };
  };

  const visible = await snap('visible');

  nat.setAffinity(host, 0x11);
  await new Promise((r) => setTimeout(r, 600));
  const wda = await snap('affinity 0x11 (baseline)');
  console.log('   readback affinity =', ps(AFFINITY_PS(host)));

  nat.setAffinity(host, 0);
  console.log('dwmExclude(host,1) ->', nat.dwmExclude(host, 1));
  await new Promise((r) => setTimeout(r, 600));
  const dwmHost = await snap('dwmExclude on host');
  console.log('   readback affinity =', ps(AFFINITY_PS(host)));

  nat.dwmExclude(host, 0);
  console.log('dwmExclude(child,1) ->', nat.dwmExclude(child, 1));
  await new Promise((r) => setTimeout(r, 600));
  const dwmChild = await snap('dwmExclude on child');

  nat.dwmExclude(host, 1);
  nat.dwmExclude(child, 1);
  await new Promise((r) => setTimeout(r, 600));
  const dwmBoth = await snap('dwmExclude host+child');

  nat.dwmExclude(host, 0); nat.dwmExclude(child, 0);
  win.hide();
  await new Promise((r) => setTimeout(r, 900));
  const hidden = await snap('hidden');

  const eq = (a, b) => a === b;
  const verdict = (r, name) => {
    const gdiOk = eq(r.gdi, hidden.gdi) && !eq(visible.gdi, hidden.gdi);
    const wgcOk = eq(r.wgc, hidden.wgc) && !eq(visible.wgc, hidden.wgc);
    console.log(`${name.padEnd(26)} gdi-excludes=${gdiOk}  wgc-excludes=${wgcOk}`);
  };
  console.log('');
  verdict(wda, 'affinity 0x11');
  verdict(dwmHost, 'dwmExclude host');
  verdict(dwmChild, 'dwmExclude child');
  verdict(dwmBoth, 'dwmExclude host+child');
  app.exit(0);
});
