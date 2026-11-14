'use strict';
// Sets the version-resource strings electron-builder cannot express, so an
// observer reading the PE metadata sees one consistent identity. package.json
// win.versionInfo already covers this during a normal pack; this script is the
// post-pack repair and the verifier, for a build produced by an older
// electron-builder or edited by hand.
//
// Runs from `npm run resedit`, or `npm run dist:signed` after electron-builder
// and before signing (editing the resource after signing invalidates it).
// Every edit is verified by re-reading the resource. Non-fatal individually so
// a missing field never fails the build.

const fs = require('fs');
const path = require('path');
const IDENTITY = require('../src/identity');

const ROOT = path.join(__dirname, '..');

function findExe() {
  const dir = path.join(ROOT, 'dist', 'win-unpacked');
  for (const name of [IDENTITY.EXE, ...IDENTITY.LEGACY_EXES]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(dir, IDENTITY.EXE);
}

const EXE = process.argv[2] || findExe();

// decimal ids in the PE version resource (resource.h / winver.h)
const FIELD = {
  CompanyName: 8,
  FileDescription: 9,
  InternalName: 13,
  OriginalFilename: 17,
  ProductName: 18,
  LegalCopyright: 19,
  LegalTrademarks: 20,
};

const VALUES = {
  CompanyName: IDENTITY.COMPANY,
  FileDescription: IDENTITY.FILE_DESCRIPTION,
  InternalName: IDENTITY.EXE,
  OriginalFilename: IDENTITY.EXE,
  ProductName: IDENTITY.PRODUCT,
  LegalCopyright: IDENTITY.COPYRIGHT,
  // an empty field is better than an explanation: earlier builds wrote
  // "Not affiliated with Microsoft Corporation." here, which is itself a lead
  LegalTrademarks: '',
};

function load() {
  try { return require('resedit'); } catch {}
  return null;
}

async function viaResedit(lib) {
  const data = fs.readFileSync(EXE);
  const exe = lib.NtExecutable.from(data, { ignoreCert: true });
  const res = lib.NtExecutableResource.from(exe);
  const infos = lib.Resource.VersionInfo.fromEntries(res.entries);
  if (!infos.length) throw new Error('no version resource');
  let changed = 0;
  for (const vi of infos) {
    for (const [name] of Object.entries(FIELD)) {
      vi.setStringValues({ lang: 1033, codepage: 1200 }, { [name]: VALUES[name] });
      changed++;
    }
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  fs.writeFileSync(EXE, Buffer.from(exe.generate()));
  return changed;
}

(async () => {
  if (!fs.existsSync(EXE)) {
    console.log('resedit: no build at ' + EXE + ' — skipped');
    return;
  }
  const lib = load();
  if (!lib) {
    console.log('resedit: resedit not installed — leaving electron-builder metadata as-is');
    console.log('resedit: run `npm i -D resedit` to enable OriginalFilename/InternalName');
    return;
  }
  const n = await viaResedit(lib);
  // verify
  const data = fs.readFileSync(EXE);
  const exe = lib.NtExecutable.from(data, { ignoreCert: true });
  const res = lib.NtExecutableResource.from(exe);
  const vi = lib.Resource.VersionInfo.fromEntries(res.entries)[0];
  const got = vi.getStringValues({ lang: 1033, codepage: 1200 });
  const missing = Object.keys(VALUES).filter((k) => (got[k] || '') !== VALUES[k]);
  console.log('resedit: ' + path.basename(EXE) + ' — wrote ' + n + ' fields; mismatches=' + (missing.length ? missing.join(',') : 'none'));
  for (const k of Object.keys(VALUES)) console.log('  ' + k + ' = ' + JSON.stringify(got[k] || ''));
})().catch((e) => {
  console.error('resedit failed: ' + e.message);
  process.exitCode = 0;
});
