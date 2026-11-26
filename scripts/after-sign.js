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
//
// The window-class literal patch that used to run here was removed: renaming
// Chromium's Aura classes in the shipped binary exists only to defeat window
// inspection, and it made the payload a different file from the one the
// compiler produced.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { THUMBPRINT } = require('../src/signing');
const CERT_THUMB = process.env.WSHX_CERT_THUMB || THUMBPRINT;
const REQUIRE_SIGNING = process.env.REQUIRE_SIGNING === '1';
const SKIP_SIGNING = process.env.SKIP_SIGNING === '1' && !REQUIRE_SIGNING;

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
  // the executable is named after the product; fall back to a legacy name for
  // an upgrade over a stale build directory
  const IDENTITY = require('../src/identity');
  let exe = path.join(context.appOutDir, IDENTITY.EXE);
  for (const legacy of IDENTITY.LEGACY_EXES) {
    if (fs.existsSync(exe)) break;
    exe = path.join(context.appOutDir, legacy);
  }
  if (!fs.existsSync(exe)) return;

  console.log('  ✅ afterSign: version resource for ' + path.basename(exe));
  execFileSync(process.execPath, [path.join(__dirname, 'resedit.js'), exe], { stdio: 'inherit' });

  if (SKIP_SIGNING) {
    console.warn('  • afterSign: SKIP_SIGNING=1, payload stays unsigned');
    return;
  }
  const st = signtool();
  if (!st) {
    if (REQUIRE_SIGNING) throw new Error('afterSign: signtool missing and REQUIRE_SIGNING=1');
    console.warn('  • afterSign: signtool missing, payload unsigned');
    return;
  }
  console.log('  • afterSign: re-signing payload');
  execFileSync(st, [
    'sign', '/sha1', CERT_THUMB, '/fd', 'sha256',
    '/tr', 'http://timestamp.digicert.com', '/td', 'sha256', exe,
  ], { stdio: 'inherit' });

  // The resource edit invalidated the earlier signature; prove the new one
  // exists and chains to our certificate before this artifact is packaged.
  console.log('  • afterSign: verifying payload signature');
  execFileSync(st, ['verify', '/pa', '/all', exe], { stdio: 'inherit' });
};
