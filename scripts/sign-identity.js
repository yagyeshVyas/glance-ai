'use strict';
// One place that decides how signtool selects the signing identity.
//
// Default: the certificate in CurrentUser\My named by src/signing.js (the
// project's own certificate). A publicly trusted certificate is usually a .pfx
// file instead, so a release build can point at one without editing code:
//
//   GLANCE_SIGN_PFX=C:\path\to\codesign.pfx
//   GLANCE_SIGN_PASSWORD=...
//
// The publisher pin in package.json still has to match the certificate's
// Authenticode subject; scripts/check.js keeps the shipped .cer and the pin in
// sync for the default identity.

const fs = require('fs');
const { execFileSync } = require('child_process');
const { THUMBPRINT, PUBLISHER_NAME } = require('../src/signing');

const PFX = process.env.GLANCE_SIGN_PFX || '';
const PASSWORD = process.env.GLANCE_SIGN_PASSWORD || '';
const THUMB = process.env.WSHX_CERT_THUMB || THUMBPRINT;

function usingPfx() {
  return Boolean(PFX);
}

function identityAvailable() {
  if (usingPfx()) return fs.existsSync(PFX);
  return true; // the store check is done by sign-build.js, which can query it
}

function identityLabel() {
  return usingPfx() ? 'PFX ' + PFX : 'store certificate ' + THUMB;
}

// signtool arguments for one file, with the same digest/timestamp policy for
// both identities.
function signArgs(file) {
  const selector = usingPfx()
    ? ['/f', PFX, '/p', PASSWORD]
    : ['/sha1', THUMB];
  return ['sign', ...selector, '/fd', 'sha256', '/tr', 'http://timestamp.digicert.com', '/td', 'sha256', file];
}

// Split an X.500 subject into normalized key=value pairs. Commas can be escaped
// inside a value, so a plain split(',') is not enough for every certificate.
function subjectParts(subject) {
  const text = String(subject || '');
  const raw = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      current += ch + text[++i];
    } else if (ch === ',') {
      raw.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) raw.push(current);
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const out = new Set();
  for (const part of raw) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out.add(norm(part.slice(0, eq)) + '=' + norm(part.slice(eq + 1)));
  }
  return out;
}

// Compare an Authenticode subject to the pinned publisher without depending on
// RDN order. Every key=value pair in the pin must appear in the signature, and
// no extra pair is treated as a match by substring (CN=Glance AI Extra fails).
function subjectMatches(actual, expected = PUBLISHER_NAME) {
  const have = subjectParts(actual);
  const want = subjectParts(expected);
  return want.size > 0 && [...want].every((pair) => have.has(pair));
}

function signedSubject(file) {
  const escaped = String(file).replace(/'/g, "''");
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `$s=(Get-AuthenticodeSignature -LiteralPath '${escaped}').SignerCertificate; if ($s) { $s.Subject } else { '' }`,
  ], { encoding: 'utf8' });
  return out.trim();
}

// Fail the build when the file was signed by a certificate that does not match
// the publisher pin electron-updater will enforce. Without this, a CA-issued
// PFX with a different subject produces installers that update from nowhere.
function assertPublisher(file) {
  const subject = signedSubject(file);
  if (!subject) throw new Error('no Authenticode signer on ' + file);
  if (!subjectMatches(subject)) {
    throw new Error('signer subject does not match publisher pin: ' + subject);
  }
  return subject;
}

module.exports = {
  PFX, PASSWORD, THUMB, PUBLISHER_NAME,
  usingPfx, identityAvailable, identityLabel, signArgs,
  subjectMatches, signedSubject, assertPublisher,
};
