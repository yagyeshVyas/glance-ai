'use strict';
// Proves sanitizeRemotePeb(): spawn a real child, rewrite its PEB, read the
// command line back three ways — the addon, WMI, and PowerShell's CIM provider.
// Same code path the browser process uses on every Chromium helper PID.
//
//   node scripts/remote-peb-probe.js
//
// Exit 0 = all reads agree on the replacement. Exit 1 = any read still shows the
// original argv (the write did not land, or the guard refused the process).

const { spawn, spawnSync } = require('child_process');
const path = require('path');

const addon = require(path.join(__dirname, '..', 'src', 'native', process.arch, 'cloak.node'));
const FAKE = '"C:\\Program Files\\Glance AI\\GlanceAI.exe"';
const FAKE_IMAGE = 'C:\\Program Files\\Glance AI\\GlanceAI.exe';

if (typeof addon.sanitizeRemotePeb !== 'function' || typeof addon.remotePebInfo !== 'function') {
  console.error('FAIL addon has no sanitizeRemotePeb/remotePebInfo — rebuild: node scripts/build-native.js x64');
  process.exit(1);
}

const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
  stdio: 'ignore',
  windowsHide: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cimCommandLine(pid) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 },
  );
  return (r.stdout || '').trim();
}

(async () => {
  try {
    await sleep(400);
    if (child.exitCode !== null) throw new Error('probe child exited early');

    const before = addon.remotePebInfo(child.pid);
    const beforeCim = cimCommandLine(child.pid);
    if (!before.ok) throw new Error('pre-write remote read failed: ' + before.error);
    if (!/--eval|setTimeout/.test(before.commandLine) && !/node/i.test(beforeCim)) {
      throw new Error('pre-write read did not see the real command line: ' + JSON.stringify(before));
    }

    const wrote = addon.sanitizeRemotePeb(child.pid, {
      commandLine: FAKE,
      imagePath: FAKE_IMAGE,
      currentDirectory: 'C:\\Windows\\System32',
    });
    if (!wrote.ok) throw new Error('sanitizeRemotePeb failed: ' + JSON.stringify(wrote));

    await sleep(200);
    const after = addon.remotePebInfo(child.pid);
    const cim = cimCommandLine(child.pid);

    const rows = [
      ['addon commandLine', after.commandLine, FAKE],
      ['addon imagePath', after.imagePath, FAKE_IMAGE],
      ['addon cwd', after.currentDirectory, 'C:\\Windows\\System32'],
      ['WMI commandLine', cim, FAKE],
    ];
    let bad = 0;
    for (const [label, got, want] of rows) {
      const pass = got === want;
      if (!pass) bad++;
      console.log((pass ? 'ok   ' : 'FAIL ') + label + ': ' + JSON.stringify(got));
    }
    if (/--eval|setTimeout/.test(cim)) {
      bad++;
      console.log('FAIL WMI still reads the original argv');
    }
    console.log(bad ? `FAIL ${bad} read(s) disagree` : 'PASS every read returns the replacement');
    process.exitCode = bad ? 1 : 0;
  } catch (e) {
    console.error('FAIL ' + (e && e.message));
    process.exitCode = 1;
  } finally {
    child.kill();
  }
})();
