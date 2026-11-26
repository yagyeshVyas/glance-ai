'use strict';
// End-to-end proof against a real Electron process tree: patch every helper's
// remote PEB from the browser process, then read it back through the addon.
// The Node probe (scripts/remote-peb-probe.js) proves the mechanism on a
// medium-IL child; this one proves it on Chromium's sandboxed renderers, which
// is the case that ships.
//
//   node_modules/electron/dist/electron.exe scripts/child-peb-probe.js
//
// Exit code 0 = every helper PID read back the replacement command line.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const FAKE = '"C:\\Program Files\\Glance AI\\GlanceAI.exe"';
const FAKE_IMAGE = 'C:\\Program Files\\Glance AI\\GlanceAI.exe';

app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'child-peb-probe-')));
app.commandLine.appendSwitch('no-first-run');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  await win.loadURL('data:text/html,<title>probe</title><p>probe</p>');
  await new Promise((r) => setTimeout(r, 1200));

  const addon = require(path.join(__dirname, '..', 'src', 'native', process.arch, 'cloak.node'));
  const metrics = app.getAppMetrics();
  const rows = [];
  let bad = 0;
  for (const m of metrics) {
    const pid = m.pid;
    if (!pid || pid === process.pid) continue;
    const type = (m.type || 'unknown').toLowerCase();
    const before = addon.remotePebInfo(pid);
    const w = addon.sanitizeRemotePeb(pid, {
      commandLine: FAKE,
      imagePath: FAKE_IMAGE,
      currentDirectory: 'C:\\Windows\\System32',
    });
    const after = addon.remotePebInfo(pid);
    const pass = Boolean(w.ok && after.ok && after.commandLine === FAKE && after.imagePath === FAKE_IMAGE);
    if (!pass) bad++;
    rows.push({
      pid,
      type,
      wrote: w,
      pass,
      before: before.ok ? before.commandLine : 'read-failed:' + before.error,
      after: after.ok ? after.commandLine : 'read-failed:' + after.error,
      image: after.ok ? after.imagePath : '',
    });
  }
  console.log(JSON.stringify(rows, null, 2));
  console.log(bad ? `FAIL ${bad} helper(s) did not take the write` : 'PASS every helper PEB rewritten');
  app.exit(bad ? 1 : 0);
}).catch((e) => {
  console.error('FAIL ' + (e && e.stack || e));
  app.exit(1);
});
