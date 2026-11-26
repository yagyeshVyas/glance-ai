'use strict';
// Build the OCR helper at package time.
//
// Electron has no OCR API, so the app calls the in-box Windows OCR engine
// through this small executable. Building it at package time means the shipped
// app never spawns a compiler and never leaves an executable in %TEMP%.
//
//   node scripts/build-ocr-helper.js [--force]
//
// Prints the path. Exits non-zero when the source exists and compilation is
// impossible; a signing failure degrades to an unsigned helper with a warning.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, 'ocr-helper.cs');
const OUT_DIR = path.join(ROOT, 'build');
const OUT = path.join(OUT_DIR, 'ocr-helper.exe');

function csc() {
  const win = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  for (const rel of [
    ['Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'],
    ['Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'],
  ]) {
    const p = path.join(win, ...rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function references(win) {
  const refs = ['/reference:System.dll'];
  // WinRT contracts are compiled against the System.Runtime facade; without it
  // csc rejects every WinMD with CS0012.
  for (const rel of [['Microsoft.NET', 'Framework64', 'v4.0.30319', 'System.Runtime.dll'],
                     ['Microsoft.NET', 'Framework', 'v4.0.30319', 'System.Runtime.dll']]) {
    const p = path.join(win, ...rel);
    if (fs.existsSync(p)) { refs.push('/reference:' + p); break; }
  }
  const winmd = path.join(win, 'System32', 'WinMetadata');
  for (const md of ['Windows.Foundation', 'Windows.Storage', 'Windows.Graphics', 'Windows.Media', 'Windows.Globalization']) {
    const p = path.join(winmd, md + '.winmd');
    if (fs.existsSync(p)) refs.push('/reference:' + p);
  }
  const wrr = path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'System.Runtime.WindowsRuntime.dll');
  if (fs.existsSync(wrr)) refs.push('/reference:' + wrr);
  return refs;
}

function signtool() {
  const kits = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const base = path.join(kits, 'Windows Kits', '10', 'bin');
  if (!fs.existsSync(base)) return null;
  for (const v of fs.readdirSync(base)) {
    const p = path.join(base, v, 'x64', 'signtool.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function sign(file) {
  let thumbprint = '';
  try { thumbprint = require('../src/signing').THUMBPRINT; } catch { return false; }
  const st = signtool();
  if (!st || !thumbprint) return false;
  try {
    execFileSync(st, ['sign', '/sha1', thumbprint, '/fd', 'sha256', file], { stdio: 'ignore', timeout: 60000 });
    return true;
  } catch {
    return false;
  }
}

function build({ force = false } = {}) {
  if (!fs.existsSync(SRC)) throw new Error('helper source missing: ' + SRC);
  const fresh = fs.existsSync(OUT) && fs.statSync(OUT).mtimeMs >= fs.statSync(SRC).mtimeMs;
  if (fresh && !force) return OUT;

  const compiler = csc();
  if (!compiler) throw new Error('csc.exe not found - cannot build the OCR helper');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const win = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  execFileSync(compiler, [
    '/nologo', '/target:exe', '/optimize+', '/out:' + OUT, SRC, ...references(win),
  ], { stdio: 'inherit', timeout: 120000 });
  if (!fs.existsSync(OUT)) throw new Error('csc did not produce ' + OUT);
  if (!sign(OUT)) console.warn('  • ocr-helper: not signed (cert/signtool unavailable) — helper is still shipped');
  return OUT;
}

module.exports = { build, OUT };

if (require.main === module) {
  try {
    const out = build({ force: process.argv.includes('--force') });
    console.log(out);
  } catch (e) {
    console.error('ocr-helper build failed: ' + e.message);
    process.exit(1);
  }
}
