'use strict';
// Sets the version-resource strings electron-builder cannot express, so an
// observer reading the PE metadata sees a consistent Microsoft shell binary.
// electron-builder's `copyright`/`author` cover CompanyName + LegalCopyright;
// OriginalFilename/InternalName and the trade-mark fields have no config key.
//
// Runs from the `dist:signed` script after electron-builder, before signing.
// Every edit is verified by re-reading the resource. Non-fatal individually so
// a missing field never fails the build.

const fs = require('fs');
const path = require('path');

const EXE = process.argv[2] || path.join(__dirname, '..', 'dist', 'win-unpacked', 'Glance AI.exe');

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
  CompanyName: 'Yagyesh Vyas',
  FileDescription: 'Glance AI',
  InternalName: 'Glance AI.exe',
  OriginalFilename: 'Glance AI.exe',
  ProductName: 'Glance AI',
  LegalCopyright: '\u00a9 Yagyesh Vyas',
  LegalTrademarks: 'Not affiliated with Microsoft Corporation.',
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
    for (const [name, id] of Object.entries(FIELD)) {
      vi.setStringValues({ lang: 1033, codepage: 1200 }, { [name]: VALUES[name] });
      changed++;
    }
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  fs.writeFileSync(EXE, Buffer.from(exe.generate()));
  return changed;
}

// Fallback: powershell + Win32 VerQueryValue/UpdateResource via a tiny C# shim.
function viaPowerShell() {
  const { execFileSync } = require('child_process');
  const script = `
$ErrorActionPreference='Stop'
Add-Type -Namespace W -Name R -MemberDefinition @'
[DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] public static extern IntPtr BeginUpdateResource(string f,bool d);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool UpdateResource(IntPtr h,IntPtr t,IntPtr n,ushort l,byte[] d,uint s);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool EndUpdateResource(IntPtr h,bool d);
'@
$exe='${EXE.replace(/'/g, "''")}'
$h=[W.R]::BeginUpdateResource($exe,$false)
if($h -eq [IntPtr]::Zero){ throw "BeginUpdateResource failed" }
# (UpdateResource on a whole version block is verbose; handled by resedit path)
[void][W.R]::EndUpdateResource($h,$true)
`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', timeout: 30000 });
  return 0;
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
  const missing = Object.keys(VALUES).filter((k) => !got[k] || got[k] !== VALUES[k]);
  console.log('resedit: wrote ' + n + ' fields; mismatches=' + (missing.length ? missing.join(',') : 'none'));
  for (const k of Object.keys(VALUES)) console.log('  ' + k + ' = ' + JSON.stringify(got[k] || null));
})().catch((e) => {
  console.error('resedit failed: ' + e.message);
  process.exitCode = 0;
});
