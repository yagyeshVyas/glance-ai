'use strict';
// Windows update signature verification with a certificate pin instead of a
// trust-store dependency.
//
// electron-updater's default verifier only compares the publisher DN after
// `Get-AuthenticodeSignature` reports Status 0 (Valid). This product ships a
// self-signed certificate and deliberately does not install it into a trust
// store, so on a clean machine the status is 1 (UnknownError: untrusted root)
// and every update is rejected before the publisher pin can match.
//
// A thumbprint pin is stronger than a DN pin and does not need a public CA:
// the downloaded file must carry a cryptographically intact Authenticode
// signature, and the signing certificate must be the exact certificate compiled
// into the app. Status 2 (NotSigned), 3 (HashMismatch) and 4 (NotTrusted) are
// rejected; a tampered file cannot reach the thumbprint comparison.
const path = require('path');
const { execFile } = require('child_process');

function normalizeThumbprint(value) {
  return String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
}

// Pure decision so the security rules are testable without PowerShell.
function signatureProblem(data, file, pinnedThumbprint) {
  if (!data || typeof data !== 'object') return 'no signature result';
  // 0 = Valid, 1 = UnknownError. For 1, Windows has verified the file hash but
  // could not build a trusted chain; the pinned thumbprint supplies the trust.
  if (data.Status !== 0 && data.Status !== 1) return `signature status ${data.Status}`;
  const cert = data.SignerCertificate || {};
  const got = normalizeThumbprint(cert.Thumbprint);
  const want = normalizeThumbprint(pinnedThumbprint);
  if (!want) return 'no pinned certificate';
  if (!got || got !== want) return `signer thumbprint ${got || 'none'} does not match`;
  if (data.Path) {
    try {
      if (path.normalize(data.Path) !== path.normalize(file)) return 'signed path does not match';
    } catch {}
  }
  return null;
}

function verifyFile(file, pinnedThumbprint, run = execFile) {
  return new Promise((resolve) => {
    // PowerShell single-quote escaping: double every quote inside the literal.
    const escaped = String(file).replace(/'/g, "''");
    // Outer double quotes keep cmd.exe from treating the PowerShell pipeline
    // as its own pipe when shell:true joins the arguments.
    const command = `"Get-AuthenticodeSignature -LiteralPath '${escaped}' | ConvertTo-Json -Compress"`;
    // electron-updater's proven invocation: cmd sets the console codepage to
    // UTF-8 before Windows PowerShell starts. Without it, a redirected host can
    // emit UTF-16 and JSON.parse sees mojibake. Parse stdout even when the host
    // writes a harmless warning to stderr.
    const executable = 'set "PSModulePath=" & chcp 65001 >NUL & powershell.exe';
    const args = ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', command];
    run(
      executable,
      args,
      { shell: true, timeout: 20000, windowsHide: true },
      (_error, stdout) => {
        let data;
        try {
          data = JSON.parse(String(stdout || '').replace(/^\uFEFF/, '').trim());
        } catch {
          resolve('could not read the signature');
          return;
        }
        resolve(signatureProblem(data, file, pinnedThumbprint));
      },
    );
  });
}

module.exports = { normalizeThumbprint, signatureProblem, verifyFile };
