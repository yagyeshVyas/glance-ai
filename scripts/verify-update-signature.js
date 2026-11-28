'use strict';
// Verify a packaged installer with the same thumbprint-pinned check the app
// uses at update time. This is meaningful on a clean machine where the
// self-signed certificate is not in any trust store, which is exactly the case
// the default electron-updater verifier rejects.
//
// Run: node scripts/verify-update-signature.js dist/GlanceAI-3.4.1-x64.exe
const path = require('path');
const { verifyFile } = require('../src/updater-verify');
const { THUMBPRINT } = require('../src/signing');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/verify-update-signature.js <installer.exe>');
  process.exit(2);
}
verifyFile(path.resolve(file), THUMBPRINT).then((problem) => {
  if (problem) {
    console.error(`FAIL update signature: ${problem}`);
    process.exit(1);
  }
  console.log('ok   update signature matches the pinned certificate');
});
