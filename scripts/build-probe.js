// Compile the native detection-audit probe (scripts/detect-audit-probe.cs) once
// with the in-box .NET Framework compiler, cache it, and sign it when the local
// code-signing certificate is available.
//
// Used three ways:
//   node scripts/build-probe.js   `npm run probe` and `npm run check`
//   require(...).ensureProbe()    from detect-audit.js, which needs the exe path
//   require(...).ensureProbe()    from check.js, so `npm run check` type-checks
//                                 the C# as part of the normal gate
//
// Design points that matter:
//   cache key     sha256 of the .cs source — editing it recompiles, nothing else does
//   atomic        compiles to a unique temp name, then renames; two concurrent
//                 first-runs cannot produce a half-written exe, the loser reuses
//                 the winner's file
//   signing       best-effort with the subject from package.json
//                 (build.win.signtoolOptions.certificateSubjectName); unsigned if
//                 the cert or signtool is absent — the audit falls back to
//                 PowerShell if security software blocks an unsigned exe
//   non-fatal     a missing compiler is not an error: detect-audit.js has a
//                 PowerShell engine and says so
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE = path.join(__dirname, 'detect-audit-probe.cs');
const SIGTOOL = 'signtool.exe';

// %SystemRoot% comes from the process env and is attacker-controllable, so the
// compiler must resolve inside the real Windows directory or it is not used.
function windowsRoot() {
  // Prefer the canonical install path and validate the candidate independently of
  // the env value that supplied it (kernel32 must be there). An attacker who can
  // rewrite SystemRoot can still plant a fake tree — env control is game over —
  // but a wrong or relative SystemRoot no longer hides the real compiler.
  const canonical = 'C:\\Windows';
  for (const candidate of [canonical, process.env.SystemRoot, process.env.WINDIR]) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    try {
      if (fs.existsSync(path.join(candidate, 'System32', 'kernel32.dll'))) return candidate.replace(/[\\/]+$/, '');
    } catch {}
  }
  return canonical;
}

function isUnder(p, root) {
  return String(p).toLowerCase().startsWith(String(root).replace(/[\\/]+$/, '').toLowerCase() + path.sep.toLowerCase());
}

function isTrustedDir(p) {
  const roots = [windowsRoot(), process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  return roots.some((r) => isUnder(p, r));
}

function findCsc() {
  const root = windowsRoot();
  for (const rel of [
    ['Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'],
    ['Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'],
  ]) {
    const p = path.join(root, ...rel);
    if (isUnder(p, root) && fs.existsSync(p)) return p;
  }
  return null;
}

function cacheDir() {
  return process.env.WSHX_AUDIT_CACHE || path.join(os.tmpdir(), 'wshx-audit');
}

function sourceHash() {
  const src = fs.readFileSync(SOURCE, 'utf8');
  return crypto.createHash('sha256').update(src).digest('hex').slice(0, 12);
}

function probeExe() {
  return path.join(cacheDir(), `probe-${sourceHash()}.exe`);
}

// The repo already pins the local signing certificate twice — as a subject in
// build.win.signtoolOptions and as a thumbprint in the `dist:signed` script.
// Subject-only selection is ambiguous (signtool finds several certs by name), so
// prefer the pinned thumbprint and fall back to the subject.
function certIdentity() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const opts = (pkg.build && pkg.build.win && pkg.build.win.signtoolOptions) || {};
    const script = (pkg.scripts && pkg.scripts['dist:signed']) || '';
    const m = script.match(/certificateSha1=([0-9A-Fa-f]+)/);
    return { thumbprint: m ? m[1] : '', subject: opts.certificateSubjectName || '' };
  } catch {
    return { thumbprint: '', subject: '' };
  }
}

function versionParts(v) {
  return v.split('.').map((n) => parseInt(n, 10) || 0);
}

function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function findSigntool() {
  // Windows Kits first: a bare `signtool.exe` on PATH is trivially shadowed by
  // node_modules/.bin, which npm puts ahead of everything during `npm run`.
  const kits = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  let versions = [];
  try {
    versions = fs.readdirSync(kits).filter((v) => /^\d+\./.test(v));
  } catch {
    versions = [];
  }
  versions.sort(compareVersions).reverse();
  for (const v of versions) {
    for (const arch of ['x64', 'x86']) {
      const p = path.join(kits, v, arch, SIGTOOL);
      if (fs.existsSync(p)) return p;
    }
  }
  // PATH is only consulted for paths under Program Files / Windows
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, SIGTOOL);
    try {
      if (fs.existsSync(p) && isTrustedDir(p)) return p;
    } catch {}
  }
  return null;
}

function verifySignature(exe) {
  // /pa alone accepts any trusted chain — including a rogue root added to the
  // per-user store. /sha1 pins the signer to the certificate this repo builds with.
  const { thumbprint } = certIdentity();
  if (!thumbprint) return false;
  const signtool = findSigntool();
  if (!signtool) return false;
  try {
    execFileSync(signtool, ['verify', '/pa', '/q', '/sha1', thumbprint, exe], {
      stdio: 'pipe',
      timeout: 30000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function trySign(exe) {
  if (process.env.WSHX_AUDIT_NO_SIGN === '1') return false;
  const { thumbprint, subject } = certIdentity();
  const selector = thumbprint ? ['/sha1', thumbprint] : subject ? ['/n', subject] : null;
  if (!selector) return false;
  const signtool = findSigntool();
  if (!signtool) return false;
  try {
    execFileSync(signtool, ['sign', '/fd', 'SHA256', ...selector, '/q', exe], {
      stdio: 'pipe',
      timeout: 60000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false; // cert not in this user's store — unsigned is fine, fallback covers blocking
  }
}

// Signature verification costs ~60–200 ms (signtool + chain build). The result is
// cached next to the exe, keyed by the exe's own sha256 — not size/mtime, which a
// replaced binary can preserve. Hashing 4.6 KB costs ~1 ms.
function verifiedMarker(exe) {
  return exe + '.verified';
}

function exeSha256(exe) {
  return crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
}

function isVerifiedCached(exe) {
  try {
    const m = JSON.parse(fs.readFileSync(verifiedMarker(exe), 'utf8'));
    const { thumbprint } = certIdentity();
    return (
      m.signed === true && Boolean(thumbprint) && String(m.thumbprint || '').toUpperCase() === thumbprint.toUpperCase() && m.sha256 === exeSha256(exe)
    );
  } catch {
    return false;
  }
}

function markVerified(exe, signed) {
  try {
    const { thumbprint } = certIdentity();
    fs.writeFileSync(verifiedMarker(exe), JSON.stringify({ signed, sha256: exeSha256(exe), thumbprint }));
  } catch {}
}

// A cached file is executed, so at minimum prove it is a PE binary. This is not a
// signature check — it catches quarantine stubs, truncated copies and injections
// that do not even parse as an image, which would otherwise fail forever (the
// tool would silently fall back to PowerShell on every run).
function looksLikeExe(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(64);
      if (fs.readSync(fd, head, 0, 64, 0) < 64) return false;
      if (head[0] !== 0x4d || head[1] !== 0x5a) return false; // "MZ"
      const peOff = head.readUInt32LE(0x3c);
      if (peOff < 64 || peOff > 1024 * 1024) return false;
      const pe = Buffer.alloc(4);
      if (fs.readSync(fd, pe, 0, 4, peOff) !== 4) return false;
      return pe[0] === 0x50 && pe[1] === 0x45 && pe[2] === 0 && pe[3] === 0; // "PE\0\0"
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function readMarker(exe) {
  try {
    return JSON.parse(fs.readFileSync(verifiedMarker(exe), 'utf8'));
  } catch {
    return null;
  }
}

function removeProbe(exe) {
  for (const f of [exe, verifiedMarker(exe)]) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Validate a probe already on disk. Removes it when it is unusable so the caller
// rebuilds — but never removes a file another run may still be signing, and never
// removes one that fails REQUIRE_SIGNED (that is a policy decision, not damage).
function validateExisting(exe) {
  if (!looksLikeExe(exe)) {
    removeProbe(exe);
    return { ok: false, reason: 'cached probe is not a PE image' };
  }
  if (!readMarker(exe)) {
    // a publisher writes the marker immediately after publishing; give it a moment
    for (let i = 0; i < 15 && !readMarker(exe); i++) sleep(100);
    if (!readMarker(exe)) {
      removeProbe(exe);
      return { ok: false, reason: 'cached probe has no provenance marker' };
    }
  }
  if (process.env.WSHX_AUDIT_REQUIRE_SIGNED === '1' && !isVerifiedCached(exe)) {
    if (!verifySignature(exe)) {
      return { ok: false, reason: 'WSHX_AUDIT_REQUIRE_SIGNED=1 but the cached probe is not signed by the pinned certificate' };
    }
    markVerified(exe, true);
  }
  return { ok: true, exe };
}

// Returns { ok, exe?, compiled?, signed?, reason? }. Never throws.
function ensureProbe() {
  if (process.platform !== 'win32') return { ok: false, reason: 'not Windows' };

  let exe;
  try {
    exe = probeExe();
  } catch (err) {
    return { ok: false, reason: `cannot read ${SOURCE}: ${err.message}` };
  }

  // A cached probe only needs to exist and be valid — the compiler is needed to
  // build, not to run. Checking csc first meant a machine that lost its .NET
  // compiler could not use an already-built (signed) probe at all.
  if (fs.existsSync(exe)) {
    const v = validateExisting(exe);
    if (v.ok) return { ok: true, exe, compiled: false };
    if (fs.existsSync(exe)) return v; // policy refusal (REQUIRE_SIGNED) — do not rebuild over it
  }

  const csc = findCsc();
  if (!csc) return { ok: false, reason: 'csc.exe not found (.NET Framework 4.x missing)' };

  let dir;
  try {
    dir = cacheDir();
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `cannot create cache dir: ${err.message}` };
  }

  const tmp = path.join(dir, `.probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp.exe`);
  try {
    execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${tmp}`, SOURCE], {
      stdio: 'pipe',
      timeout: 120000,
      windowsHide: true,
    });
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    const text = (err.stdout || '') + (err.stderr || '');
    return { ok: false, reason: `compile failed: ${String(text).trim().slice(0, 400) || err.message}` };
  }

  // Sign before publishing. The published file is therefore never observable in
  // an unsigned state, which removes the sign-after-publish window a concurrent
  // run could otherwise execute or delete.
  const signed = trySign(tmp);
  if (!signed && process.env.WSHX_AUDIT_REQUIRE_SIGNED === '1') {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return { ok: false, reason: 'WSHX_AUDIT_REQUIRE_SIGNED=1 but signing failed (cert or signtool missing)' };
  }
  if (!looksLikeExe(tmp)) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return { ok: false, reason: 'compiler produced no usable PE image' };
  }

  // Publish without clobbering. Both operations fail with EEXIST instead of
  // replacing, so a concurrent run cannot overwrite a signed build:
  //   hard link  — same volume, no data copy
  //   copy EXCL  — different volume or no hard-link support, still atomic-ish
  // rename() is deliberately not used: on Windows it silently replaces.
  let published = false;
  // WSHX_AUDIT_PUBLISH=copy forces the fallback path, so the no-hard-link case
  // (network share, FAT32, other volume) is exercisable on any machine.
  if (process.env.WSHX_AUDIT_PUBLISH !== 'copy') {
    try {
      fs.linkSync(tmp, exe);
      published = true;
    } catch {}
  }
  if (!published) {
    try {
      fs.copyFileSync(tmp, exe, fs.constants.COPYFILE_EXCL);
      published = true;
    } catch (copyErr) {
      if (copyErr.code !== 'EEXIST') {
        try {
          fs.unlinkSync(tmp);
        } catch {}
        return { ok: false, reason: `cannot publish probe: ${copyErr.message}` };
      }
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {}

  if (!published) {
    // lost the race: validate the winner instead of returning it unexamined
    return validateExisting(exe);
  }

  markVerified(exe, signed);
  return { ok: true, exe, compiled: true, signed };
}

module.exports = { ensureProbe, probeExe, findCsc, findSigntool, cacheDir };

if (require.main === module) {
  const r = ensureProbe();
  if (!r.ok) {
    if (/csc\.exe not found|not Windows/.test(r.reason)) {
      console.log(`build-probe: skipped — ${r.reason}; audit will use the PowerShell engine`);
      process.exit(0);
    }
    console.error(`build-probe: FAILED — ${r.reason}`);
    process.exit(1);
  }
  console.log(
    r.compiled
      ? `build-probe: compiled ${path.basename(r.exe)}${r.signed ? ' (signed)' : ' (unsigned)'}`
      : `build-probe: cached ${path.basename(r.exe)}`
  );
}
