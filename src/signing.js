'use strict';
// One signing identity for every place that needs it: the installer sign hook,
// the packaged-payload re-sign in afterSign, the post-build installer pass in
// sign-build.js and the pinned pin the audit probe verifies against.
//
// The thumbprint used to be copied into three scripts and a fourth copy lived in
// the `dist:signed` command line, which is how a build can end up signed by a
// certificate nobody meant. A certificate is a file plus a private key, so the
// thumbprint here is only a selector: if the key is not in CurrentUser\My, the
// build stays unsigned and says so instead of signing with the wrong pair.
//
// Private key material never enters the repo. `scripts/make-cert.ps1` creates a
// fresh pair and writes the exportable .pfx to
// %USERPROFILE%\.glance-signing\, and only the public .cer
// (build/codesign.cer) is committed. The installer no longer imports that .cer
// into any trust store; it exists so `npm run check` can prove the thumbprint
// selector still names the certificate the build signs with.
module.exports = {
  THUMBPRINT: '06468B493CB0318832E9894CA756E064DB06AACC',
  SUBJECT: 'CN=Glance AI, O=Glance AI, C=US',
  // The exact string electron-updater compares against the downloaded
  // installer's Authenticode subject. Keep it identical to `SUBJECT`.
  PUBLISHER_NAME: 'CN=Glance AI, O=Glance AI, C=US',
  // Deleted from LocalMachine\Root by the installer's customInstall: machines
  // that ran an older build still trust the previous publishers, including the
  // RuntimeBroker-era product cert this one replaces.
  RETIRED_THUMBPRINTS: ['E24291F0B8B8BB49B0E9BC169CAE4E32B8E1B09C', 'DFA561EEFC12632EAACDD0C8CBE20F3B23AC5702'],
};
