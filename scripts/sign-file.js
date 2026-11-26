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
//
// Fail-closed: with REQUIRE_SIGNING=1 a release build aborts if signtool is
// missing or if the signature does not verify. Without it, a dev checkout
// warns and continues (the app is still installable, just unsigned).

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { THUMBPRINT } = require('../src/signing');
const CERT_THUMB = process.env.WSHX_CERT_THUMB || THUMBPRINT;
const REQUIRE_SIGNING = process.env.REQUIRE_SIGNING === '1';
// CI and dev machines have no release key. Skipping is explicit and can never
// override a release build: REQUIRE_SIGNING=1 wins.
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

module.exports = async function sign(configuration) {
  const file = configuration && configuration.path;
  if (!file || !fs.existsSync(file)) return;
  if (SKIP_SIGNING) {
    console.warn('  • sign: SKIP_SIGNING=1, leaving ' + path.basename(file) + ' unsigned');
    return;
  }
  const st = signtool();
  if (!st) {
    if (REQUIRE_SIGNING) throw new Error('sign: signtool not found and REQUIRE_SIGNING=1');
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
  if (REQUIRE_SIGNING) {
    // A successful `sign` exit code is not proof the file carries our chain;
    // verify every PE we claim to have signed.
    execFileSync(st, ['verify', '/pa', '/all', file], { stdio: 'inherit' });
  }
};
