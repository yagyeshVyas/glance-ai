'use strict';
// Build the cloak addon for one arch, reliably.
//
// Why this exists instead of `node-gyp rebuild`:
// Node 26 ships a config.gypi with `clang: 1` (its Windows dist is LLVM-built),
// so gyp stamps clang-only flags onto the generated .vcxproj — `-flto=thin` on
// the compiler and `/opt:lldltojobs=2` on the linker. The local toolchain here
// is MSVC (VS2019 BuildTools, no clang-cl), and link.exe rejects
// `/opt:lldltojobs=2` outright with LNK1117, so the build dies at link time
// with no addon at all.
//
// The flags are cosmetic for two small translation units, so the fix is:
// configure, strip the clang-only options from the generated project, build.
// This is a generated-file patch, not a toolchain change, and the PE machine
// type is verified before the addon is published to its arch path.
//
//   node scripts/build-native.js [x64|arm64|ia32]

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NATIVE = path.join(ROOT, 'src', 'native');
const GYP = path.join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
const RELEASE = path.join(NATIVE, 'build', 'Release', 'cloak.node');
const MACHINE = { x64: 0x8664, arm64: 0xaa64, ia32: 0x14c };

// clang-only switches that MSVC's link.exe either ignores or hard-fails on
const CLANG_ONLY = ['-flto=thin', '-flto=full', '/opt:lldltojobs=2'];

function runGyp(args) {
  execFileSync(process.execPath, [GYP, ...args], {
    cwd: NATIVE,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}

// Strip the offending options from every generated project under build/.
function stripClangFlags() {
  let patched = 0;
  for (const name of fs.readdirSync(path.join(NATIVE, 'build'))) {
    if (!name.endsWith('.vcxproj')) continue;
    const file = path.join(NATIVE, 'build', name);
    const before = fs.readFileSync(file, 'utf8');
    let after = before;
    for (const flag of CLANG_ONLY) after = after.split(flag + ' ').join('');
    if (after !== before) {
      fs.writeFileSync(file, after);
      patched++;
    }
  }
  return patched;
}

function peMachine(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file: ' + file);
  return buf.readUInt16LE(buf.readUInt32LE(0x3c) + 4);
}

function loadableByElectron(file) {
  // NAPI is ABI-stable, so a plain node build loads in Electron; still prove it
  // rather than shipping a file that only fails at first require().
  const mod = require(file);
  for (const fn of ['cloak', 'uncloak', 'attachHost', 'setAffinity']) {
    if (typeof mod[fn] !== 'function') throw new Error('addon is missing export: ' + fn);
  }
}

function main() {
  const arch = process.argv[2] || 'x64';
  const want = MACHINE[arch];
  if (!want) {
    console.error(`unknown arch "${arch}" — expected one of ${Object.keys(MACHINE).join(', ')}`);
    process.exit(2);
  }
  if (!fs.existsSync(GYP)) {
    console.error('node-gyp is not installed (run npm install first)');
    process.exit(2);
  }

  console.log(`• configure ${arch}`);
  runGyp(['configure', '--arch=' + arch]);
  const patched = stripClangFlags();
  console.log(`• stripped clang-only link flags from ${patched} project file(s)`);
  console.log(`• build ${arch}`);
  runGyp(['build', '--arch=' + arch]);

  if (!fs.existsSync(RELEASE)) throw new Error('build produced no ' + RELEASE);
  const machine = peMachine(RELEASE);
  if (machine !== want) {
    throw new Error(`addon is 0x${machine.toString(16)}, expected 0x${want.toString(16)} for ${arch}`);
  }
  // A foreign arch cannot be require()d by this host node, so the PE machine
  // check above is the proof for it; only the host arch gets the load test.
  if (arch === process.arch) loadableByElectron(RELEASE);

  const out = path.join(NATIVE, arch, 'cloak.node');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(RELEASE, out);
  console.log(`• ok — ${arch} addon (0x${machine.toString(16)}) at src/native/${arch}/cloak.node`);
}

try {
  main();
} catch (e) {
  console.error('build-native failed:', e.message);
  process.exit(1);
}
