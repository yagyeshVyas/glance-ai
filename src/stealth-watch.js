'use strict';
// Detector watch: is a window inspector running?
//
// The one signal user mode cannot erase is the capture-exclusion flag: while
// the panel is excluded from capture, GetWindowDisplayAffinity returns 0x11 and
// any same-user process can read it. The probe in scripts/affinity-reparent-probe.js
// measured that the flag cannot be moved onto a child window, so the only
// user-mode trade is: drop the flag while something is inspecting windows, and
// make the content unreadable instead (scramble, STEALTH.md §7).
//
// Only processes that actually look at window state are listed. A broad
// /guardian/ or /exam/ pattern would match unrelated software and flip the
// panel capturable for no reason, which is worse than the flag.
//
// Deliberately not listed: browsers (they cannot enumerate native windows),
// OBS/Zoom/Teams (they capture pixels, and capture exclusion already hides
// those pixels), Task Manager (does not read display affinity).
const { execFile } = require('child_process');

const WATCHED = [
  /^procexp(64)?\.exe$/i, // Sysinternals Process Explorer
  /^processhacker(64)?\.exe$/i,
  /^systeminformer\.exe$/i, // Process Hacker's current name
  /^lockdownbrowser\.exe$/i, // Respondus LockDown Browser
  /^rpnow\.exe$/i,
  /^psisecurebrowser\.exe$/i,
  /^safebrowserexam\.exe$/i, // Safe Exam Browser
  /^proctoru/i,
  /^proctorio/i,
  /^honorlock/i,
  /^respondus/i,
  /^examity/i,
  /^mettl/i,
  /^talview/i,
];

function isWatched(name) {
  return WATCHED.some((re) => re.test(name || ''));
}

function scan(cb) {
  execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
    if (err || !stdout) return cb(null);
    for (const line of String(stdout).split(/\r?\n/)) {
      // tasklist CSV: "Image Name","PID","Session Name","Session#","Mem Usage"
      const m = /^"([^"]+)"/.exec(line);
      if (m && isWatched(m[1])) return cb(m[1]);
    }
    cb(null);
  });
}

// onChange(name | null) fires only on a change, never on every poll. The timer
// is unref'd so an idle watcher cannot hold the process open at quit.
let timer = null;
function startDetectorWatch({ onChange, everyMs = 4000 } = {}) {
  if (process.platform !== 'win32' || timer) return;
  let last = '';
  const tick = () => {
    scan((hit) => {
      const key = hit || '';
      if (key === last) return;
      last = key;
      try { onChange(hit); } catch {}
    });
  };
  tick();
  timer = setInterval(tick, everyMs);
  if (timer.unref) timer.unref();
}

function stopDetectorWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startDetectorWatch, stopDetectorWatch, scan, isWatched };
