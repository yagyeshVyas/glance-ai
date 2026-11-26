// Syntax-check all JS sources. Run: npm run check
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const files = [
  'src/main.js',
  'src/preload.js',
  'src/renderer/renderer.js',
  'src/shared.js',
  'src/identity.js',
  'src/broadcast.js',
  'src/renderer/drag.js',
  'scripts/detect-audit.js',
  'scripts/build-probe.js',
  'scripts/hotkey-audit.js',
  'scripts/start.js',
  'scripts/test.js',
  'scripts/test-main.js',
  'scripts/ui-probe.js',
  'scripts/capture-probe.js',
  'scripts/composite-probe.js',
  'scripts/api-probe.js',
  'server/glance-api.js',
  'scripts/cdp-eval.js',
  'scripts/capture-frame.js',
  'scripts/eye-probe.js',
  'scripts/broadcast-gateway-probe.js',
  'scripts/resedit.js',
  'scripts/sign-build.js',
  'scripts/sign-file.js',
  'scripts/after-sign.js',
  'scripts/pe-imports.js',
  'scripts/build-ocr-helper.js',
  'scripts/before-pack.js',
  'scripts/check.js',
  'scripts/verify-build.js',
];
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', path.join(__dirname, '..', f)], { stdio: 'pipe' }); console.log('ok  ', f); }
  catch (e) { bad++; console.error('FAIL', f, '\n' + e.stderr); }
}

// The C# probe has no linter — compiling it is the check. This also warms the
// cache the audit uses, so `npm run check` leaves `npm run audit` fast.
const { ensureProbe } = require('./build-probe');
const probe = ensureProbe();
if (probe.ok) {
  console.log('ok  ', 'scripts/detect-audit-probe.cs', probe.compiled ? '(compiled)' : '(cached)');
} else if (/csc\.exe not found|not Windows/.test(probe.reason)) {
  console.log('skip', 'scripts/detect-audit-probe.cs', `(${probe.reason}; audit falls back to PowerShell)`);
} else {
  bad++;
  console.error('FAIL', 'scripts/detect-audit-probe.cs', '\n' + probe.reason);
}

// One identity, four copies: package.json, build/installer.nsh, the identity
// module, and the version resource values electron-builder writes. Drift is how
// this app ended up named "Glance AI" on disk while its PE metadata said
// "assistant" and its Run key said a third thing.
const IDENTITY = require('../src/identity');
const pkg = require('../package.json');
const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');

// Electron supports the latest three stable majors. An EOL major means an
// unpatched Chromium in the app, so this fails instead of warning. Update the
// range and the dependency together; the build has no other EOL gate.
const SUPPORTED_ELECTRON_MAJORS = [43, 44, 45];
const electronRange = (pkg.devDependencies && pkg.devDependencies.electron) || '';
const electronMajor = Number((/\d+/.exec(electronRange) || [0])[0]);
if (!SUPPORTED_ELECTRON_MAJORS.includes(electronMajor)) {
  bad++;
  console.error(
    'FAIL electron: ' + (electronRange || '(missing)') +
    ' is outside the supported majors ' + SUPPORTED_ELECTRON_MAJORS.join(', '),
  );
} else {
  console.log('ok   electron (' + electronMajor + ', supported major)');
}

// The anti-inspection subsystem was removed in 3.3.7. These paths are the
// components that made the app harder to inspect, not easier to use; a build
// that re-adds one should fail here rather than ship quietly.
for (const rel of [
  'src/native',
  'src/embed-helpers.js',
  'scripts/embed-helpers.js',
  'scripts/hide-helper.cs',
  'scripts/build-hide-helper.js',
  'scripts/build-native.js',
  'scripts/after-pack.js',
]) {
  if (fs.existsSync(path.join(__dirname, '..', rel))) {
    bad++;
    console.error('FAIL removed-subsystem: ' + rel + ' is back');
  }
}

// The installer must not add trust. Removing the legacy certificates is
// allowed; importing one (certutil -addstore Root, Import-Certificate) is not.
let installerOk = true;
if (/-addstore|Import-Certificate/i.test(nsh)) {
  bad++; installerOk = false;
  console.error('FAIL installer: build/installer.nsh imports a certificate into a trust store');
}
if (/taskkill/i.test(nsh)) {
  bad++; installerOk = false;
  console.error('FAIL installer: build/installer.nsh kills processes by image name');
}
if (installerOk) console.log('ok   installer (no trust-store import, no taskkill)');
const identityChecks = [
  ['package.json name', pkg.name, 'glance-ai'],
  ['package.json productName', pkg.productName, IDENTITY.PRODUCT],
  ['package.json appId', pkg.build.appId, IDENTITY.APP_ID],
  ['package.json executableName', pkg.build.win.executableName, IDENTITY.EXE.replace(/\.exe$/i, '')],
  ['package.json description', pkg.description, IDENTITY.DESCRIPTION],
  ['package.json author', pkg.author, IDENTITY.COMPANY],
  ['package.json copyright', pkg.build.copyright, IDENTITY.COPYRIGHT],
  ['package.json shortcutName', pkg.build.nsis.shortcutName, IDENTITY.PRODUCT],
];
for (const [label, got, want] of identityChecks) {
  if (got !== want) { bad++; console.error('FAIL identity ' + label + ': ' + JSON.stringify(got) + ' !== ' + JSON.stringify(want)); }
}
// installer.nsh cannot require the module, so pin the paths it must build:
// the executable in $INSTDIR, the Run value, and no System32 mirror under the
// product name (the old impersonation must not come back).
if (!nsh.includes('$INSTDIR\\' + IDENTITY.EXE + '"')) {
  bad++; console.error('FAIL identity build/installer.nsh: install path is not $INSTDIR\\' + IDENTITY.EXE);
}
if (nsh.includes('xcopy') && nsh.includes('$R5\\' + IDENTITY.PRODUCT)) {
  bad++; console.error('FAIL identity build/installer.nsh: still mirrors ' + IDENTITY.PRODUCT + ' into System32');
}
if (!nsh.includes('"Software\\Microsoft\\Windows\\CurrentVersion\\Run" "' + IDENTITY.AUTOSTART_NAME + '"')) {
  bad++; console.error('FAIL identity build/installer.nsh: Run value is not ' + IDENTITY.AUTOSTART_NAME);
}
if (!bad) console.log('ok   identity (package.json <-> src/identity.js <-> build/installer.nsh)');

// The project must not name a person anywhere it ships: not in the signature,
// not in package metadata, not on the site, not in a doc. This is the same walk
// the history filter uses, so a regression in the working tree is caught before
// it can be committed.
try {
  execFileSync(process.execPath, [path.join(__dirname, 'scrub-identity.js'), '--check'], { stdio: 'pipe' });
  console.log('ok   publisher (no personal name in the tree)');
} catch (e) {
  bad++;
  console.error('FAIL publisher: a personal name is still in the tree\n' + String(e.stdout || '').trim());
}

// A thumbprint is a selector, not a signature: a wrong one produces an unsigned
// build, silently. The committed .cer is the public half of the certificate the
// build signs with, so its SHA-1 *is* the thumbprint the build must select —
// comparing them catches a re-issued cert that was exported without updating
// the module.
const SIGNING = require('../src/signing');
if (!/^[0-9A-F]{40}$/.test(SIGNING.THUMBPRINT || '')) {
  bad++; console.error('FAIL signing: thumbprint is not a 40-hex SHA-1');
}
if (!/^CN=[^,]+/.test(SIGNING.SUBJECT || '')) {
  bad++; console.error('FAIL signing: subject has no CN');
}
try {
  const der = fs.readFileSync(path.join(__dirname, '..', 'build', 'codesign.cer'));
  const thumb = require('crypto').createHash('sha1').update(der).digest('hex').toUpperCase();
  if (thumb !== SIGNING.THUMBPRINT) {
    bad++;
    console.error('FAIL signing: build/codesign.cer is ' + thumb + ' but src/signing.js pins ' + SIGNING.THUMBPRINT);
  }
} catch (e) {
  bad++; console.error('FAIL signing: build/codesign.cer is unreadable (' + e.message + ')');
}
if (!bad) console.log('ok   signing (' + SIGNING.SUBJECT.split(',')[0] + ', .cer matches)');

// The site prints the release it documents. A version bump that misses it is a
// page advertising the previous build.
const siteHtml = fs.readFileSync(path.join(__dirname, '..', 'website', 'index.html'), 'utf8');
if (!siteHtml.includes('"' + pkg.version + '"') && !siteHtml.includes('v' + pkg.version)) {
  bad++; console.error('FAIL version: website/index.html does not carry ' + pkg.version);
} else {
  console.log('ok   version (' + pkg.version + ' on site and in package.json)');
}

process.exit(bad ? 1 : 0);
