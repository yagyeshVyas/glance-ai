// Does the capture-exclusion flag survive the hop into the blend host?
//
// The flag is documented as top-level-only, and the app sets it AFTER the child
// is reparented — where the call is accepted and ignored. This probe measures the
// other order: set WDA_EXCLUDEFROMCAPTURE while the window is still top-level,
// then reparent it into the host, then ask the OS two questions per step:
//
//   1. GetWindowDisplayAffinity(child)  — did the flag survive?
//   2. desktopCapturer screen grab      — are the pixels still excluded?
//
// desktopCapturer is the same Windows.Graphics.Capture / DXGI family that Chrome
// getDisplayMedia, Meet and Teams use, so (2) is "does a screen-share client
// receive the panel".
//
// Run: npx electron scripts/affinity-reparent-probe.js
'use strict';

const electronModule = require('electron');
if (typeof electronModule === 'string') {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  process.exit(spawnSync(electronModule, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env }).status ?? 1);
}

const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const path = require('path');

function loadNative() {
  const candidates = [
    path.join(__dirname, '..', 'src', 'native', process.arch, 'cloak.node'),
    path.join(__dirname, '..', 'src', 'native', 'build', 'Release', 'cloak.node'),
  ];
  for (const p of candidates) {
    try {
      const m = require(p);
      if (typeof m.setAffinity === 'function' && typeof m.attachHost === 'function') return { mod: m, file: p };
    } catch {}
  }
  return null;
}

function low32(buf) {
  return buf.readUInt32LE(0);
}

// Count the window's magenta paint inside its DIP rectangle in a screen grab.
async function screenGrab(win, label) {
  const disp = screen.getPrimaryDisplay();
  const b = win.getBounds();
  const dw = disp.bounds.width;
  const dh = disp.bounds.height;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(dw), height: Math.round(dh) },
    fetchWindowIcons: false,
  });
  const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
  if (!src) return { label, error: 'no screen source' };
  const img = src.thumbnail;
  const size = img.getSize();
  const bmp = img.toBitmap();
  const sx = size.width / dw;
  const sy = size.height / dh;
  const x0 = Math.max(0, Math.round((b.x - disp.bounds.x) * sx));
  const y0 = Math.max(0, Math.round((b.y - disp.bounds.y) * sy));
  const x1 = Math.min(size.width, Math.round((b.x - disp.bounds.x + b.width) * sx));
  const y1 = Math.min(size.height, Math.round((b.y - disp.bounds.y + b.height) * sy));
  let inRect = 0;
  let magenta = 0;
  let magentaAll = 0;
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const i = (y * size.width + x) * 4;
      const bl = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
      const hit = r > 180 && g < 90 && bl > 180;
      if (hit) magentaAll++;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) {
        inRect++;
        if (hit) magenta++;
      }
    }
  }
  return {
    label,
    windowRectDips: { x: b.x, y: b.y, w: b.width, h: b.height },
    grab: { w: size.width, h: size.height },
    rectPixels: inRect,
    magentaInRect: magenta,
    magentaFractionInRect: inRect ? +(magenta / inRect).toFixed(4) : null,
    magentaFractionWholeScreen: +(magentaAll / (size.width * size.height)).toFixed(4),
  };
}

async function windowSource(win, label) {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 420, height: 300 },
    fetchWindowIcons: false,
  });
  const mine = sources.filter((s) => /affinity-probe|electron/i.test(s.name));
  return {
    label,
    listedWindowSources: mine.map((s) => ({ name: s.name, empty: s.thumbnail.isEmpty() })),
  };
}

app.whenReady().then(async () => {
  const loaded = loadNative();
  if (!loaded) {
    console.log(JSON.stringify({ error: 'cloak addon not loadable' }));
    app.quit();
    return;
  }
  const nat = loaded.mod;
  const out = { addon: loaded.file, steps: [] };

  const win = new BrowserWindow({
    x: 240,
    y: 180,
    width: 420,
    height: 300,
    frame: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    transparent: false,
    backgroundColor: '#ff00ff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL('data:text/html,<body style="margin:0;background:%23ff00ff"></body>');
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  win.showInactive();
  await new Promise((r) => setTimeout(r, 700));

  const child = low32(win.getNativeWindowHandle());
  out.childHwnd = child;

  // 0: baseline — capturable, no flag
  out.steps.push({ step: 0, affinity: nat.getAffinity(child), capture: await screenGrab(win, 'baseline-no-flag') });

  // 1: flag while top-level
  nat.setAffinity(child, 0x11);
  await new Promise((r) => setTimeout(r, 400));
  out.steps.push({ step: 1, affinity: nat.getAffinity(child), capture: await screenGrab(win, 'top-level-flag-0x11') });

  // 2: reparent into the host, flag set BEFORE the hop
  const hostR = nat.attachHost(child);
  const host = hostR && hostR.host ? hostR.host : 0;
  await new Promise((r) => setTimeout(r, 700));
  out.hostHwnd = host;
  out.steps.push({
    step: 2,
    hostAttached: Boolean(hostR && hostR.ok),
    affinityChild: nat.getAffinity(child),
    affinityHost: nat.getAffinity(host),
    capture: await screenGrab(win, 'reparented-flag-before'),
    windows: await windowSource(win, 'reparented-flag-before'),
  });

  // 3: the app's current order — call the flag on the child AFTER reparent
  nat.setAffinity(child, 0);
  nat.setAffinity(child, 0x11);
  await new Promise((r) => setTimeout(r, 400));
  out.steps.push({
    step: 3,
    note: 'flag re-issued on the child after reparenting (the app current path)',
    affinityChild: nat.getAffinity(child),
    affinityHost: nat.getAffinity(host),
    capture: await screenGrab(win, 'reparented-flag-after'),
  });

  // 4: control — flag on the host (what the app does today)
  nat.setAffinity(host, 0x11);
  await new Promise((r) => setTimeout(r, 400));
  out.steps.push({
    step: 4,
    note: 'flag on the host (control)',
    affinityHost: nat.getAffinity(host),
    capture: await screenGrab(win, 'host-flag'),
    windows: await windowSource(win, 'host-flag'),
  });

  console.log(JSON.stringify(out, null, 1));
  nat.detachHost();
  win.destroy();
  app.quit();
});
