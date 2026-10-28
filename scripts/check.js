// Syntax-check all JS sources. Run: npm run check
const { execFileSync } = require('child_process');
const path = require('path');
const files = [
  'src/main.js',
  'src/preload.js',
  'src/renderer/renderer.js',
  'src/shared.js',
  'src/renderer/drag.js',
  'scripts/detect-audit.js',
  'scripts/build-probe.js',
  'scripts/hotkey-audit.js',
  'scripts/start.js',
  'scripts/test.js',
  'scripts/test-main.js',
  'scripts/ui-probe.js',
  'scripts/capture-probe.js',
  'scripts/pe-imports.js',
  'scripts/check.js',
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

process.exit(bad ? 1 : 0);
