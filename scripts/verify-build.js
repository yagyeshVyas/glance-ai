// Verify a packaged Windows build instead of trusting the build log.
//
// Run: npm run verify:build            (x64, static)
//      npm run verify:build -- --all   (x64 + arm64, static)
//      npm run verify:build -- --launch (also start the app and wait for its
//                                        smoke marker; only on a matching host)
//
// Checks, per architecture:
//   1. the executable is a real PE of the expected machine type
//   2. Electron fuses are the ones package.json asks for (raw wire read, not
//      the build config that was supposed to apply them)
//   3. onlyLoadAppFromAsar really left an app.asar and no unpacked app/
//   4. the OCR helper shipped in resources
//   5. app-update.yml pins the same publisher the installer is signed with
//   6. --launch: the app reaches whenReady, creates its window, and exits
//
// It reads `dist/`, so it runs after electron-builder. It never signs anything.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const pkg = require(path.join(ROOT, 'package.json'));

const MACHINE = { x64: 0x8664, arm64: 0xaa64 };
const DIR = { x64: 'win-unpacked', arm64: 'win-arm64-unpacked' };
const FUSE = { DISABLE: 48, ENABLE: 49 };

const EXPECTED_FUSES = [
  [FuseV1Options.RunAsNode, FUSE.DISABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FUSE.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FUSE.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FUSE.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FUSE.ENABLE],
];

let failures = 0;
const ok = (msg) => console.log('ok  ', msg);
const fail = (msg) => {
  failures++;
  console.error('FAIL', msg);
};

function peMachine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    if (head.toString('ascii', 0, 2) !== 'MZ') return null;
    const peOffset = head.readUInt32LE(0x3c);
    const pe = Buffer.alloc(6);
    fs.readSync(fd, pe, 0, 6, peOffset);
    if (pe.toString('ascii', 0, 4) !== 'PE\0\0') return null;
    return pe.readUInt16LE(4);
  } finally {
    fs.closeSync(fd);
  }
}

function publisherFromUpdateYml(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((l) => /^publisherName:/.test(l));
    if (at === -1) return null;
    const unquote = (v) => v.trim().replace(/^["']|["']$/g, '');
    const inline = lines[at].slice('publisherName:'.length).trim();
    if (inline) return unquote(inline);
    // electron-builder writes the pinned name as a YAML list.
    const list = [];
    for (let i = at + 1; i < lines.length; i++) {
      const m = lines[i].match(/^\s+-\s+(.+)$/);
      if (!m) break;
      list.push(unquote(m[1]));
    }
    return list.length ? list : null;
  } catch {
    return null;
  }
}

function expectedPublisher() {
  // electron-builder copies win.signtoolOptions.publisherName into
  // app-update.yml when verifyUpdateCodeSignature is on (the default). A
  // publisherName key inside publish[] is rejected by the config schema.
  const win = pkg.build.win || {};
  return (win.signtoolOptions && win.signtoolOptions.publisherName) || '';
}

async function verifyStatic(arch) {
  const dir = path.join(DIST, DIR[arch]);
  const exe = path.join(dir, 'GlanceAI.exe');
  const label = `${arch} ${path.relative(ROOT, exe)}`;

  if (!fs.existsSync(exe)) {
    fail(`${label}: not built`);
    return false;
  }

  const machine = peMachine(exe);
  if (machine !== MACHINE[arch]) {
    fail(`${label}: PE machine 0x${(machine || 0).toString(16)} is not ${arch} (0x${MACHINE[arch].toString(16)})`);
  } else {
    ok(`${label}: PE machine 0x${machine.toString(16)}`);
  }

  const wire = await getCurrentFuseWire(exe);
  if (wire.version !== '1') fail(`${label}: unknown fuse wire version ${wire.version}`);
  for (const [index, expected] of EXPECTED_FUSES) {
    const actual = wire[index];
    const name = FuseV1Options[index];
    if (actual !== expected) {
      fail(`${label}: fuse ${name} is ${actual}, expected ${expected} (${expected === FUSE.ENABLE ? 'enabled' : 'disabled'})`);
    } else {
      ok(`${label}: fuse ${name} ${expected === FUSE.ENABLE ? 'enabled' : 'disabled'}`);
    }
  }

  const asar = path.join(dir, 'resources', 'app.asar');
  const unpackedApp = path.join(dir, 'resources', 'app');
  if (!fs.existsSync(asar)) fail(`${label}: resources/app.asar is missing`);
  else if (fs.existsSync(unpackedApp)) fail(`${label}: resources/app exists next to app.asar (onlyLoadAppFromAsar) `);
  else ok(`${label}: only the asar payload is present`);

  if (!fs.existsSync(path.join(dir, 'resources', 'ocr-helper.exe'))) {
    fail(`${label}: resources/ocr-helper.exe is missing`);
  } else {
    ok(`${label}: OCR helper shipped`);
  }

  const publisher = expectedPublisher();
  const updateYml = path.join(dir, 'resources', 'app-update.yml');
  const pinned = publisherFromUpdateYml(updateYml);
  if (!publisher) fail(`${label}: package.json win.signtoolOptions.publisherName is empty`);
  else if (!fs.existsSync(updateYml)) fail(`${label}: resources/app-update.yml is missing — verify an installer-target build, not --dir`);
  else if (!(pinned === publisher || (Array.isArray(pinned) && pinned.length === 1 && pinned[0] === publisher))) {
    fail(`${label}: app-update.yml publisherName is ${JSON.stringify(pinned)}, expected ${JSON.stringify(publisher)}`);
  } else ok(`${label}: app-update.yml pins the signing publisher`);

  return true;
}

function smokeLaunch(arch) {
  if (process.arch !== arch) {
    console.log(`skip  ${arch} launch: host is ${process.arch}`);
    return Promise.resolve();
  }
  const exe = path.join(DIST, DIR[arch], 'GlanceAI.exe');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `glance-smoke-${arch}-`));
  const marker = path.join(profile, 'smoke.marker');
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(exe, ['--smoke-test'], {
      env: { ...process.env, RB_PROFILE_DIR: profile, RB_SMOKE_FILE: marker },
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const finish = (failure) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (failure) fail(failure);
      else ok(`${arch} packaged launch reached the smoke marker in ${Date.now() - started} ms`);
      const cleanup = () => {
        try {
          fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
        } catch {}
        resolve();
      };
      // Chromium keeps handles on its profile for a moment after the marker is
      // written. Wait for the process to exit, then retry the removal; never
      // hang the verifier on a profile lock.
      if (child.exitCode !== null) {
        setTimeout(cleanup, 300);
        return;
      }
      child.once('exit', () => setTimeout(cleanup, 300));
      child.kill();
      setTimeout(cleanup, 5000);
    };
    const timer = setInterval(() => {
      const wrote = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'ready';
      if (wrote) return finish(null);
      if (child.exitCode !== null) return finish(`${arch} packaged launch exited early (${child.exitCode}) without writing its marker`);
      if (Date.now() - started > 30000) return finish(`${arch} packaged launch timed out without writing its marker`);
    }, 250);
  });
}

(async () => {
  const args = process.argv.slice(2);
  const archArg = args.find((a) => a.startsWith('--arch='));
  const archs = args.includes('--all')
    ? ['x64', 'arm64']
    : [archArg ? archArg.slice('--arch='.length) : 'x64'];
  for (const arch of archs) {
    if (!MACHINE[arch]) {
      console.error(`unknown architecture ${arch}`);
      process.exit(1);
    }
  }

  for (const arch of archs) {
    const built = await verifyStatic(arch);
    if (built && args.includes('--launch')) await smokeLaunch(arch);
  }

  if (failures) {
    console.error(`\n${failures} build verification failure(s)`);
    process.exit(1);
  }
  console.log('\nbuild verification passed');
})().catch((err) => {
  console.error('FAIL', err && err.stack ? err.stack : err);
  process.exit(1);
});
