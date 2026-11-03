'use strict';
// Experiment: does DWMWA_EXCLUDED_FROM_CAPTURE (16) exclude a window from
// capture while leaving GetWindowDisplayAffinity at 0?
//
//   npx electron scripts/dwm-exclude-ab.js
//
// A/B against the honest baseline: the same panel is hashed (1) visible and
// capturable, (2) excluded via the DWM attribute, (3) hidden entirely. If the
// DWM hash equals the hidden hash but differs from the visible hash, the
// attribute excludes pixels without touching the affinity flag.

const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const crypto = require('crypto');
const path = require('path');

const nat = require(path.join(__dirname, '..', 'src', 'native', process.arch, 'cloak.node'));

function hwndOf(w) { return w.getNativeWindowHandle().readUInt32LE(0); }

async function hashRegion(rect) {
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
  const bmp = img.toBitmap();
  const fullW = img.getSize().width;
  const px = (v) => Math.round(v * scale);
  const x0 = Math.max(0, px(rect.x + 40));
  const y0 = Math.max(0, px(rect.y + 40));
  const w = Math.min(px(180), fullW - x0);
  const h = Math.min(px(120), img.getSize().height - y0);
  const hash = crypto.createHash('sha256');
  for (let row = 0; row < h; row++) {
    const start = ((y0 + row) * fullW + x0) * 4;
    hash.update(bmp.subarray(start, start + w * 4));
  }
  return hash.digest('hex').slice(0, 16);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    x: 120, y: 120, width: 700, height: 500,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    backgroundColor: '#ff000000',
  });
  await win.loadURL('data:text/html,' + encodeURIComponent(
    '<body style="margin:0;background:#0b1020"><div style="height:150px;background:#e8453c"></div>' +
    '<div style="height:350px;background:#2f6fed"></div></body>'));
  win.showInactive();
  await new Promise((r) => setTimeout(r, 900));

  const child = hwndOf(win);
  const host = nat.attachHost(child).host;
  if (!host) { console.log('attach failed'); app.exit(1); return; }
  await new Promise((r) => setTimeout(r, 700));
  const rect = win.getBounds();

  const readAffinity = () => {
    const r = nat.setAffinity(host, 0x11) ? 'set-ok' : 'set-fail';
    // read back through the probe-free path: setAffinity returns a bool only,
    // so this is measured by the detect-audit tool separately
    return r;
  };

  const visible = await hashRegion(rect);
  console.log('visible          :', visible, 'affinity', readAffinity());

  // baseline: the shipped mechanism
  nat.setAffinity(host, 0x11);
  await new Promise((r) => setTimeout(r, 600));
  const wda = await hashRegion(rect);
  console.log('affinity 0x11    :', wda);

  // candidate: DWM attribute only
  nat.setAffinity(host, 0);
  const dwm = nat.dwmExclude(host, 1);
  await new Promise((r) => setTimeout(r, 600));
  const dwmHash = await hashRegion(rect);
  console.log('dwmExclude(1)->', dwm, ':', dwmHash);

  // hidden baseline
  nat.dwmExclude(host, 0);
  win.hide();
  await new Promise((r) => setTimeout(r, 900));
  const hidden = await hashRegion(rect);
  console.log('hidden           :', hidden);

  console.log('');
  console.log('visible !== hidden  (panel is drawn)    :', visible !== hidden);
  console.log('wda     === hidden (affinity excludes)  :', wda === hidden);
  console.log('dwm     === hidden (dwm excludes)       :', dwmHash === hidden);
  console.log('');
  console.log(dwmHash === hidden && visible !== hidden
    ? 'RESULT: DWMWA_EXCLUDED_FROM_CAPTURE excludes and needs no affinity flag'
    : 'RESULT: DWM attribute does NOT exclude on this build');
  app.exit(0);
});
