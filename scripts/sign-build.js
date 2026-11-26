'use strict';
// Build + identity pipeline: electron-builder → version-resource edit → sign.
// Keeps `dist:signed` one command so the two steps that make the binary look
// like a Windows shell process can never run in the wrong order (editing the
// resource AFTER signing would invalidate the signature).
//
// Evidence is recorded, not assumed: each step is re-verified and the final
// signature is checked with signtool /pa.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IDENTITY = require('../src/identity');
const EXE = path.join(ROOT, 'dist', 'win-unpacked', IDENTITY.EXE);
const { THUMBPRINT } = require('../src/signing');
const CERT_THUMB = process.env.WSHX_CERT_THUMB || THUMBPRINT;
const REQUIRE_SIGNING = process.env.REQUIRE_SIGNING === '1';

function signtool() {
  const kits = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const base = path.join(kits, 'Windows Kits', '10', 'bin');
  if (!fs.existsSync(base)) return null;
  // x64 host tool only; the arm/arm64 builds cannot sign for this host
  for (const v of fs.readdirSync(base)) {
    const p = path.join(base, v, 'x64', 'signtool.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function thumbExists(thumb) {
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `if (Get-Item "Cert:\\CurrentUser\\My\\${thumb}" -EA SilentlyContinue) { 'yes' } else { 'no' }`,
  ], { encoding: 'utf8' });
  return out.trim() === 'yes';
}

(async () => {
  const steps = [];
  const run = (label, fn) => {
    try { const r = fn(); steps.push([label, 'ok', r]); return r; }
    catch (e) { steps.push([label, 'FAIL', e.message.slice(0, 300)]); }
  };

  console.log('1/4 electron-builder');
  // The published build has to name the account releases actually live under,
  // because electron-builder writes that into resources/app-update.yml and
  // electron-updater reads it from there. The source tree keeps a neutral
  // placeholder (and `npm run check` rejects a personal name), so the account is
  // injected for the pack and the file is restored afterwards — a crash restores
  // it too, via the exit handler installed below.
  const pkgFile = path.join(ROOT, 'package.json');
  const originalPkg = fs.readFileSync(pkgFile, 'utf8');
  const restorePkg = () => { try { fs.writeFileSync(pkgFile, originalPkg); } catch {} };
  const owner = process.env.RB_REPO_OWNER;
  if (owner) {
    const pkg = JSON.parse(originalPkg);
    const pub = (pkg.build && pkg.build.publish) || [];
    if (pub[0]) pub[0].owner = owner;
    if (process.env.RB_REPO_NAME && pub[0]) pub[0].repo = process.env.RB_REPO_NAME;
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`  • release owner injected for this pack: ${owner}/${pub[0] && pub[0].repo}`);
    process.on('exit', restorePkg);
    process.on('SIGINT', () => { restorePkg(); process.exit(130); });
  }
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), '--win'], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' },
    });
  } finally {
    if (owner) restorePkg();
  }

  // Read the payload metadata back. NOTE: resedit rewrites the PE and would
  // strip the signature electron-builder just applied, so read it via the
  // shell's VersionInfo instead of re-running the editor.
  console.log('2/4 app payload metadata (resource applied during pack)');
  run('payload metadata', () => {
    const v = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `$v=(Get-Item -Force '${EXE.replace(/'/g, "''")}').VersionInfo; "$($v.CompanyName)|$($v.FileDescription)|$($v.OriginalFilename)|$($v.InternalName)"`,
    ], { encoding: 'utf8' }).trim();
    if (!v.startsWith(`${IDENTITY.COMPANY}|${IDENTITY.FILE_DESCRIPTION}|${IDENTITY.EXE}|${IDENTITY.EXE}`)) {
      throw new Error('metadata mismatch: ' + v);
    }
    return v;
  });
  // The window-class rename used to be verified here. It was removed with the
  // patch itself: renaming Chromium's Aura classes in the shipped binary exists
  // only to defeat window inspection and is not part of a releasable build.

  const st = signtool();
  if (!st) {
    if (REQUIRE_SIGNING) {
      steps.push(['signing', 'FAIL', 'signtool not found and REQUIRE_SIGNING=1']);
      console.log('3/4 signtool not found — release build refuses to ship unsigned');
    } else {
      console.log('3/4 signtool not found — binaries stay unsigned (dev build)');
    }
  } else if (!thumbExists(CERT_THUMB)) {
    if (REQUIRE_SIGNING) {
      steps.push(['signing', 'FAIL', 'certificate ' + CERT_THUMB + ' not in the user store']);
      console.log('3/4 certificate ' + CERT_THUMB + ' not in the user store — release build refuses to ship unsigned');
    } else {
      console.log('3/4 certificate ' + CERT_THUMB + ' not in the user store — unsigned (dev build)');
    }
  } else {
    // app payload was signed in afterPack; the installer + uninstaller are
    // separate executables signed now that NSIS has produced them
    console.log('3/4 signing installer + uninstaller');
    run('sign installer', () => {
      const dist = path.join(ROOT, 'dist');
      const targets = fs.readdirSync(dist)
        .filter((f) => f.endsWith('.exe'))
        .map((f) => path.join(dist, f));
      for (const t of targets) {
        execFileSync(st, [
          'sign', '/sha1', CERT_THUMB, '/fd', 'sha256',
          '/tr', 'http://timestamp.digicert.com', '/td', 'sha256', t,
        ], { stdio: 'pipe' });
      }
      return targets.map((t) => path.basename(t)).join(', ');
    });
    // Signing rewrote every byte the updater will hash, so latest.yml has to be
    // re-stamped from the signed files or electron-updater rejects the download
    // on a checksum mismatch — and that failure is silent.
    run('re-stamp latest.yml', () =>
      execFileSync(process.execPath, [path.join(__dirname, 'refresh-latest-yml.js')], { stdio: 'inherit' }));
    console.log('4/4 verify payload + installer');
    run('verify payload', () => {
      const exes = [];
      for (const d of fs.readdirSync(path.join(ROOT, 'dist'))) {
        if (!d.includes('unpacked')) continue;
        const p = path.join(ROOT, 'dist', d, IDENTITY.EXE);
        if (fs.existsSync(p)) exes.push(p);
      }
      for (const e of exes) execFileSync(st, ['verify', '/pa', '/v', e], { stdio: 'pipe' });
      return exes.map((e) => path.basename(path.dirname(e))).join(', ');
    });
    run('verify installer', () => {
      // installers are named <artifactName>, so 'Setup' is not in the name; they
      // are the loose .exe files that are not the unpacked payload
      const setups = fs.readdirSync(path.join(ROOT, 'dist'))
        .filter((f) => f.endsWith('.exe'));
      for (const s of setups) execFileSync(st, ['verify', '/pa', '/v', path.join(ROOT, 'dist', s)], { stdio: 'pipe' });
      return setups.join(', ');
    });
  }

  console.log('\n--- pipeline result ---');
  for (const [label, status, detail] of steps) {
    console.log(status.padEnd(4) + '  ' + label + (status === 'FAIL' ? '  ' + detail : ''));
  }
  // A printed FAIL used to exit 0, so a release could ship after a verification
  // step had already failed. The pipeline result is now the process result.
  if (steps.some(([, status]) => status === 'FAIL')) process.exitCode = 1;

  // final metadata readback, straight from the file
  if (fs.existsSync(EXE)) {
    const vi = require('child_process').execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `$v=(Get-Item '${EXE.replace(/'/g, "''")}').VersionInfo; "$($v.CompanyName)|$($v.FileDescription)|$($v.ProductName)|$($v.OriginalFilename)|$($v.InternalName)"`,
    ], { encoding: 'utf8' }).trim();
    console.log('\nmetadata: ' + vi);
    const sig = require('child_process').execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `(Get-AuthenticodeSignature '${EXE.replace(/'/g, "''")}').Status`,
    ], { encoding: 'utf8' }).trim();
    console.log('signature: ' + sig);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
