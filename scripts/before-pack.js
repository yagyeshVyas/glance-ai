'use strict';
// electron-builder beforePack hook.
//
// The DWM cloak is a native addon, so it must be compiled for the arch being
// packaged. This must run in beforePack, not afterPack: afterPack fires once the
// app directory and its asar are already written, so a file created there never
// makes it into the package (measured — both installers shipped a stale addon).
//
// Builds for the requested arch and keeps an arch-named copy the loader probes:
//   src/native/<arch>/cloak.node   ← preferred
//   src/native/build/Release/...   ← plain `npm install` fallback

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;

  // context.arch is electron-builder's Arch enum (0=ia32, 1=x64, 3=arm64), not
  // a string; accept either shape so a tool upgrade cannot silently mis-map.
  const byEnum = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' };
  const arch = typeof context.arch === 'number' ? (byEnum[context.arch] || 'x64') : (context.arch || 'x64');

  const gyp = path.join(__dirname, '..', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  const release = path.join(__dirname, '..', 'src', 'native', 'build', 'Release', 'cloak.node');
  const outDir = path.join(__dirname, '..', 'src', 'native', arch);
  const built = path.join(outDir, 'cloak.node');

  if (!fs.existsSync(gyp)) {
    console.warn('  • beforePack: node-gyp missing, cloak addon may be stale');
    return;
  }

  console.log(`  • beforePack: building cloak addon for ${arch}`);
  try {
    execFileSync(process.execPath, [gyp, 'rebuild', '--arch=' + arch], {
      cwd: path.join(__dirname, '..', 'src', 'native'),
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  } catch (e) {
    console.warn('  • beforePack: addon build failed for ' + arch + ' — no cloak in this build');
    return;
  }

  // verify machine code before trusting it; a wrong-arch .node fails at dlopen
  let machine = 0;
  try {
    const buf = fs.readFileSync(release);
    machine = buf.readUInt16LE(buf.readUInt32LE(0x3c) + 4);
  } catch (e) {
    console.warn('  • beforePack: cannot read built addon: ' + e.message);
    return;
  }
  const want = { x64: 0x8664, arm64: 0xaa64, ia32: 0x14c }[arch];
  if (want && machine !== want) {
    console.warn(`  • beforePack: addon is 0x${machine.toString(16)} but arch is ${arch} — not shipping it`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(release, built);
  console.log(`  • beforePack: cloak addon ready for ${arch} (0x${machine.toString(16)})`);
};
