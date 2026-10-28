// Measures what the OS capture path actually returns for the wshx-host window.
// `desktopCapturer` is the same Windows capture family (Windows.Graphics.Capture /
// DXGI) that Chrome getDisplayMedia, Meet, Teams web and Zoom's newer share path use,
// so this is a direct measurement of "does a screen-share client receive the pixels".
//
// Run with the app already running:
//   npx electron scripts/capture-probe.js            # JSON + PNG of the wshx-host source
'use strict';

const { app, desktopCapturer } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

function stats(img) {
  const bmp = img.toBitmap(); // BGRA
  let sum = 0;
  let lit = 0;
  let n = 0;
  for (let i = 0; i + 3 < bmp.length; i += 4) {
    const b = bmp[i];
    const g = bmp[i + 1];
    const r = bmp[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += l;
    if (l > 16) lit++;
    n++;
  }
  return {
    pixels: n,
    meanLuma: n ? +(sum / n).toFixed(2) : null,
    litFraction: n ? +(lit / n).toFixed(4) : null,
    size: img.getSize(),
    empty: img.isEmpty(),
  };
}

app.whenReady().then(async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 800, height: 600 },
    fetchWindowIcons: false,
  });
  const windows = sources.filter((s) => s.id.startsWith('window:'));
  const named = windows.filter((s) => /wshx-host|electron/i.test(s.name));
  const outDir = process.env.TMPDIR || os.tmpdir();
  const files = [];
  const matches = [];
  for (const s of named) {
      const file = path.join(outDir, `wshx-window-capture-${matches.length}.png`);
    fs.writeFileSync(file, s.thumbnail.toPNG());
    files.push(file);
    matches.push({ id: s.id, name: s.name, file, ...stats(s.thumbnail) });
  }
  console.log(
    JSON.stringify(
      {
        windowSources: windows.length,
        screenSources: sources.length - windows.length,
        wshxListed: named.length > 0,
        matches,
        // proof the list is not empty overall: the first few window names
        sampleWindowNames: windows.slice(0, 8).map((s) => s.name),
        files,
      },
      null,
      1,
    ),
  );
  app.quit();
});
