'use strict';
// electron-builder afterSign hook — the only point where a version-resource
// edit survives.
//
// Ordering reasons (measured, each attempt failed a different way):
//   afterPack     → electron-builder's own resource/fuses pass runs after it,
//                   so the strings are overwritten and "Parsing signed
//                   executable binary is not allowed" if signed there
//   win.signtoolOptions.sign → only applied to secondary files; the main exe
//                   goes through signAndEditResources instead
//   afterSign     → runs after signing, nothing rewrites the PE afterwards ✅
//
// So: edit the resource here, then re-sign, because editing invalidates the
// signature electron-builder just wrote. Installing to %ProgramFiles% needs the
// payload signed, not just the installer.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CERT_THUMB = process.env.WSHX_CERT_THUMB || 'E24291F0B8B8BB49B0E9BC169CAE4E32B8E1B09C';

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

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'win32') return;
  // the executable is named after the product; fall back to the old name for
  // an upgrade over a stale directory
  let exe = path.join(context.appOutDir, 'assistant.exe');
  if (!fs.existsSync(exe)) exe = path.join(context.appOutDir, 'Glance AI.exe');
  if (!fs.existsSync(exe)) return;

  console.log('  ✅ afterSign: version resource for ' + path.basename(exe));
  execFileSync(process.execPath, [path.join(__dirname, 'resedit.js'), exe], { stdio: 'inherit' });

  const st = signtool();
  if (!st) {
    console.warn('  • afterSign: signtool missing, payload unsigned');
    return;
  }
  console.log('  • afterSign: re-signing payload');
  execFileSync(st, [
    'sign', '/sha1', CERT_THUMB, '/fd', 'sha256',
    '/tr', 'http://timestamp.digicert.com', '/td', 'sha256', exe,
  ], { stdio: 'inherit' });
};
