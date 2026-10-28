// Renders the real renderer at representative overlay sizes and measures the changed
// Settings row. Run with the repo's Electron:
//   npx electron scripts/ui-probe.js
//
// It exists because a label change is only "verified" once the text has been laid out
// at the sizes the window actually allows (420x360 minimum, 760x600 default) and the
// checkbox has been clicked. Prints JSON metrics and writes PNGs to $TMPDIR.
'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const outDir = process.env.TMPDIR || os.tmpdir();
const cfg = {
  baseUrl: 'https://api.openai.com/v1',
  chatModel: 'gpt-4o-mini',
  transcribeModel: 'whisper-1',
  transcribeBaseUrl: '',
  ttsBaseUrl: '',
  ttsVoice: 'alloy',
  ttsModel: 'tts-1',
  contextTokens: 32000,
  answerLang: 'auto',
  targetRole: '',
  resume: '',
  systemPrompt: 'You are a real-time assistant shown in a small overlay.',
  smartMode: true,
  practiceMode: false,
  stealth: true,
  stealthProcess: true,
  captureDisplay: 'auto',
  panelOpacity: 0.78,
  hasKey: true,
  hasTranscribeKey: false,
  hasTtsKey: false,
  encryptionAvailable: true,
  keysNotPersisted: [],
};
let saveCalls = 0;

for (const ch of ['ask', 'cancel', 'transcribe', 'speak', 'window:hide', 'window:quit', 'window:move', 'practice:save', 'practice:export', 'wipe:all', 'state:set']) {
  ipcMain.handle(ch, () => ({ error: 'stub' }));
}
ipcMain.handle('config:get', () => cfg);
ipcMain.handle('config:set', (_e, next) => {
  Object.assign(cfg, next || {});
  saveCalls++;
  return cfg;
});
ipcMain.handle('models:list', () => ({ models: ['gpt-4o-mini', 'gpt-4o'] }));
ipcMain.handle('state:get', () => ({ history: [], transcript: '' }));
ipcMain.handle('displays:list', () => [{ id: '1', label: 'Display 1', size: { width: 1920, height: 1080 } }]);

const measure = `(async () => {
  document.getElementById('gear').click();
  await new Promise((r) => setTimeout(r, 300));
  const s = document.getElementById('settings');
  const lab = [...s.querySelectorAll('label')].find((l) => l.textContent.includes('AppUserModelID'));
  if (!lab) return { error: 'changed label not found' };
  const cs = getComputedStyle(lab);
  const cb = lab.querySelector('input');
  const sr = s.getBoundingClientRect();
  const cbr = cb.getBoundingClientRect();
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
  const out = {
    labelText: lab.textContent.trim(),
    labelWidth: Math.round(lab.getBoundingClientRect().width),
    labelClientW: lab.clientWidth,
    labelScrollW: lab.scrollWidth,
    labelHeight: lab.offsetHeight,
    lineHeight: Math.round(lh),
    lines: Math.round(lab.offsetHeight / lh),
    fontSize: cs.fontSize,
    display: cs.display,
    flexDirection: cs.flexDirection,
    checkboxRight: Math.round(cbr.right),
    panelRight: Math.round(sr.right),
    clippedHorizontally: lab.scrollWidth > lab.clientWidth + 1,
    settingsOverflowX: s.scrollWidth > s.clientWidth + 1,
    settingsClientW: s.clientWidth,
    settingsScrollW: s.scrollWidth,
    settingsScrollH: s.scrollHeight,
    settingsClientH: s.clientHeight,
  };
  const before = lab.getBoundingClientRect();
  cb.click();
  const after = lab.getBoundingClientRect();
  out.checkboxCheckedAfterClick = cb.checked;
  out.widthShiftPx = Math.round((after.width - before.width) * 100) / 100;
  out.heightShiftPx = Math.round((after.height - before.height) * 100) / 100;
  // the row is far below the fold (the panel is ~1.5k tall); bring it into view so the
  // screenshot actually shows what changed
  lab.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, 150));
  const rr = lab.getBoundingClientRect();
  out.rect = { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) };
  return out;
})()`;

app.whenReady().then(async () => {
  const results = [];
  const win = new BrowserWindow({
    width: 760,
    height: 600,
    x: 80,
    y: 80,
    show: true,
    backgroundColor: '#101218',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  for (const [name, w, h] of [
    ['desktop-760x600', 760, 600],
    ['min-420x360', 420, 360],
  ]) {
    win.setContentSize(w, h);
    await new Promise((r) => setTimeout(r, 400));
    const m = await win.webContents.executeJavaScript(measure);
    // the save path must still work with the row visible
    await win.webContents.executeJavaScript("document.getElementById('s_save').click()");
    await new Promise((r) => setTimeout(r, 250));
    const file = path.join(outDir, `glance-settings-${name}.png`);
    const img = await win.capturePage();
    fs.writeFileSync(file, img.toPNG());
    // tight crop of the changed row, so the text can be read without the whole panel
    const r = m.rect || { x: 0, y: 0, w: 300, h: 40 };
    const crop = await win.capturePage({
      x: Math.max(0, r.x - 12),
      y: Math.max(0, r.y - 10),
      width: Math.min(w - Math.max(0, r.x - 12), r.w + 24),
      height: r.h + 20,
    });
    const rowFile = path.join(outDir, `glance-settings-${name}-row.png`);
    fs.writeFileSync(rowFile, crop.toPNG());
    results.push({ size: `${w}x${h}`, file, rowFile, ...m });
  }
  results.push({ saveCalls });
  console.log(JSON.stringify(results, null, 1));
  win.destroy();
  app.quit();
});
