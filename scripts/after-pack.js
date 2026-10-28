'use strict';
// electron-builder afterPack hook.
//
// The DWM cloak is a native addon, so it must be compiled for the arch that is
// being packaged, not whatever was last built on this host. electron-builder
// runs this per arch with the target arch in context, so rebuild here and let
// asar packing pick up src/native/build/Release/cloak.node afterwards.
//
// Signing happens later (afterSign) because electron-builder still edits the PE.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  // context.arch is electron-builder's Arch enum (0=ia32, 1=x64, 3=arm64),
  // not a string; accept either shape so an upgrade of the tool cannot silently
  // produce an x64 addon inside an arm64 package.
  const byEnum = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
  const arch = typeof context.arch === 'number' ? (byEnum[context.arch] || 'x64') : (context.arch || 'x64');
  const node = process.execPath;
  const gyp = path.join(__dirname, '..', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');

  if (!fs.existsSync(gyp)) {
    console.warn('  • afterPack: node-gyp missing, cloak addon may be stale');
    return;
  }

  // Build into a per-arch folder instead of the shared build/Release: an arch
  // that fails must not delete the addon another arch already packaged.
  const outDir = path.join(__dirname, '..', 'src', 'native', arch);
  const built = path.join(outDir, 'cloak.node');

  console.log(`  • afterPack: building cloak addon for ${arch}`);
  try {
    execFileSync(node, [gyp, 'rebuild', '--arch=' + arch], {
      cwd: path.join(__dirname, '..', 'src', 'native'),
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    // copy the artifact next to an arch-named file the loader probes
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'src', 'native', 'build', 'Release', 'cloak.node'), built);
  } catch (e) {
    console.warn('  • afterPack: addon build failed for ' + arch + ' — shipping without cloak');
    return;
  }

  // verify the machine code actually matches the requested arch
  try {
    const buf = fs.readFileSync(built);
    const pe = buf.readUInt32LE(0x3c);
    const machine = buf.readUInt16LE(pe + 4);
    const want = { x64: 0x8664, arm64: 0xaa64, ia32: 0x14c }[arch];
    if (want && machine !== want) {
      console.warn(`  • afterPack: addon is 0x${machine.toString(16)} but arch is ${arch} — removing`);
      fs.unlinkSync(built);
    }
  } catch (e) {
    console.warn('  • afterPack: could not verify addon arch: ' + e.message);
  }
};
