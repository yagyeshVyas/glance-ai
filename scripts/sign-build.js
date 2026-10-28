'use strict';
// Build + identity pipeline: electron-builder → version-resource edit → sign.
// Keeps `dist:signed` one command so the two steps that make the binary look
// like a Microsoft shell process can never run in the wrong order (editing the
// resource AFTER signing would invalidate the signature).
//
// Evidence is recorded, not assumed: each step is re-verified and the final
// signature is checked with signtool /pa.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'win-unpacked', 'assistant.exe');
const CERT_THUMB = process.env.WSHX_CERT_THUMB || 'E24291F0B8B8BB49B0E9BC169CAE4E32B8E1B09C';

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
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), '--win'], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' },
  });

  // Read the payload metadata back. NOTE: resedit rewrites the PE and would
  // strip the signature electron-builder just applied, so read it via the
  // shell's VersionInfo instead of re-running the editor.
  console.log('2/4 app payload metadata (resource applied during pack)');
  run('payload metadata', () => {
    const v = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `$v=(Get-Item -Force '${EXE.replace(/'/g, "''")}').VersionInfo; "$($v.CompanyName)|$($v.FileDescription)|$($v.OriginalFilename)|$($v.InternalName)"`,
    ], { encoding: 'utf8' }).trim();
    if (!/Yagyesh Vyas\|Glance AI\|Glance AI\.exe\|Glance AI\.exe/.test(v)) {
      throw new Error('metadata mismatch: ' + v);
    }
    return v;
  });

  const st = signtool();
  if (!st) {
    console.log('3/4 signtool not found — binaries stay unsigned');
  } else if (!thumbExists(CERT_THUMB)) {
    console.log('3/4 certificate ' + CERT_THUMB + ' not in the user store — unsigned');
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
    console.log('4/4 verify payload + installer');
    run('verify payload', () => {
      const exes = [];
      for (const d of fs.readdirSync(path.join(ROOT, 'dist'))) {
        if (!d.includes('unpacked')) continue;
        const p = path.join(ROOT, 'dist', d, 'assistant.exe');
        if (fs.existsSync(p)) exes.push(p);
      }
      for (const e of exes) execFileSync(st, ['verify', '/pa', '/v', e], { stdio: 'pipe' });
      return exes.map((e) => path.basename(path.dirname(e))).join(', ');
    });
    run('verify installer', () => {
      const setups = fs.readdirSync(path.join(ROOT, 'dist')).filter((f) => f.endsWith('.exe') && f.includes('Setup'));
      for (const s of setups) execFileSync(st, ['verify', '/pa', '/v', path.join(ROOT, 'dist', s)], { stdio: 'pipe' });
      return setups.join(', ');
    });
  }

  console.log('\n--- pipeline result ---');
  for (const [label, status, detail] of steps) {
    console.log(status.padEnd(4) + '  ' + label + (status === 'FAIL' ? '  ' + detail : ''));
  }

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
