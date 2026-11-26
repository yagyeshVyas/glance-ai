'use strict';
// Rename Chromium's Aura window classes inside the packaged executable.
//
// The class names are wide-string literals compiled into the browser binary.
// Electron registers them during startup, before main.js runs, so patching them
// from JS is too late â€” the class atom already holds "Chrome_WidgetWin_1" and
// EnumChildWindows reports it forever. Rewriting the literals in the file, at
// the same byte length, means the class registers under an innocuous name from
// the very first window.
//
// Runs in afterSign before resedit + re-sign, because editing the PE invalidates
// the signature electron-builder just wrote. Same length in, same length out:
// nothing else in the image moves.
//
//   node scripts/patch-class-names.js [exe] [--check]
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IDENTITY = require('../src/identity');
const args = process.argv.slice(2);
const check = args.includes('--check');
const EXE = args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'dist', 'win-unpacked', IDENTITY.EXE);

const PAIRS = [
  // 17 chars -> 17 chars
  ['Chrome_WidgetWin_', 'Windows.UI.Core.W'],
  // 27 chars -> 27 chars
  ['Chrome_RenderWidgetHostHWND', 'Windows.UI.Core.RenderHostX'],
];

if (!fs.existsSync(EXE)) {
  console.log('patch-class-names: no build at ' + EXE + ' â€” skipped');
  process.exit(0);
}

const original = fs.readFileSync(EXE);
const out = Buffer.from(original);
let changed = 0;
let remaining = 0;
for (const [from, to] of PAIRS) {
  if (from.length !== to.length) throw new Error('replacement length differs: ' + from);
  const needle = Buffer.from(from, 'utf16le');
  const repl = Buffer.from(to, 'utf16le');
  // count first, so --check reports what a detector could read before any write
  let at = 0;
  let n = 0;
  while ((at = out.indexOf(needle, at)) !== -1) { n++; at += needle.length; }
  if (check) {
    remaining += n;
  } else if (n) {
    at = 0;
    while ((at = out.indexOf(needle, at)) !== -1) {
      repl.copy(out, at);
      at += needle.length;
    }
    changed += n;
  }
  console.log(`${from} -> ${to}: ${check ? n + ' present' : n + ' replaced'}`);
}

if (check) {
  console.log('patch-class-names: check â€” ' + (remaining ? 'FAIL' : 'pass'));
  process.exit(remaining ? 1 : 0);
}

if (changed) {
  fs.writeFileSync(EXE, out);
  console.log('patch-class-names: wrote ' + changed + ' replacement(s) to ' + path.basename(EXE));
} else {
  console.log('patch-class-names: no class literals found â€” nothing to do');
}

