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
// %USERPROFILE%\.runtimebroker-signing\, and only the public .cer
// (build/codesign.cer, imported by the installer) is committed.
module.exports = {
  THUMBPRINT: 'DFA561EEFC12632EAACDD0C8CBE20F3B23AC5702',
  SUBJECT: 'CN=Runtime Broker Components, O=Runtime Components, C=US',
  // Deleted from LocalMachine\Root by the installer's customInstall: machines
  // that ran an older build still trust the previous publisher, which is the one
  // name this project is removing.
  RETIRED_THUMBPRINTS: ['E24291F0B8B8BB49B0E9BC169CAE4E32B8E1B09C'],
};
