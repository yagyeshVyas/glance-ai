'use strict';
// electron-builder custom `sign` hook (win.signtoolOptions.sign).
//
// The built-in store-certificate path disambiguates poorly here: three
// code-signing certs live in CurrentUser\My and signtool's dual-hash pass
// matches more than one, aborting with "Multiple certificates were found".
// Calling signtool ourselves with an explicit /sha1 removes the ambiguity and
// still uses electron-builder's timestamp + hash settings.
//
// Hook contract: (configuration) => Promise, with configuration.path the file
// to sign. Returning without throwing = success.

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

module.exports = async function sign(configuration) {
  const file = configuration && configuration.path;
  if (!file || !fs.existsSync(file)) return;
  const st = signtool();
  if (!st) {
    console.warn('  • sign: signtool not found, skipping ' + path.basename(file));
    return;
  }
  execFileSync(st, [
    'sign',
    '/sha1', CERT_THUMB,
    '/fd', 'sha256',
    '/tr', 'http://timestamp.digicert.com',
    '/td', 'sha256',
    file,
  ], { stdio: 'inherit' });
};
