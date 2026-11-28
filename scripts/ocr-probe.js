'use strict';
// Native-helper regression test.
//
// The old native addon is gone; the only native code left is the in-box Windows
// OCR helper. This test builds nothing and changes nothing: it renders a PNG with
// known text, runs the shipped helper over it, and checks the decoded lines. It
// skips cleanly when the helper is not built (fresh clone) or the machine has no
// OCR language pack, so it never turns an environment gap into a false failure.
//
//   node scripts/ocr-probe.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const helper = path.join(__dirname, '..', 'build', 'ocr-helper.exe');
if (!fs.existsSync(helper)) {
  console.log('skip OCR helper: build/ocr-helper.exe is not built (npm run ocr-helper)');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-ocr-'));
const png = path.join(tmp, 'fixture.png');

function run(args) {
  try {
    return {
      code: 0,
      out: execFileSync(helper, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 }),
    };
  } catch (err) {
    return { code: err.status || 1, out: (err.stdout || '') + (err.stderr || '') };
  }
}

try {
  // Windows PowerShell 5.1 ships System.Drawing, so this needs no npm package.
  const draw = [
    'Add-Type -AssemblyName System.Drawing',
    '$bmp = New-Object System.Drawing.Bitmap 1000, 320',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.Clear([System.Drawing.Color]::White)',
    '$font = New-Object System.Drawing.Font("Arial", 84, [System.Drawing.FontStyle]::Bold)',
    '$brush = [System.Drawing.Brushes]::Black',
    '$g.DrawString("GLANCE OCR 123", $font, $brush, 30, 90)',
    '$bmp.Save("' + png.replace(/\\/g, '/') + '", [System.Drawing.Imaging.ImageFormat]::Png)',
    '$g.Dispose()',
    '$bmp.Dispose()',
  ].join('; ');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', draw], {
    windowsHide: true,
    timeout: 30000,
  });

  const r = run(['ocr', png]);
  if (/no OCR language pack|no OCR language/i.test(r.out)) {
    console.log('skip OCR helper: this machine has no OCR language pack');
    process.exit(0);
  }
  assert.strictEqual(r.code, 0, 'OCR helper failed: ' + r.out.slice(0, 300));
  const text = r.out
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((parts) => parts[0] === 'L' && parts[1])
    .map((parts) => Buffer.from(parts[1], 'base64').toString('utf8'))
    .join(' ');
  assert.match(text, /GLANCE/i, 'OCR did not read the fixture text: ' + JSON.stringify(text));
  console.log('ok   OCR helper reads a generated fixture');

  const usage = run([]);
  assert.notStrictEqual(usage.code, 0, 'usage error must exit non-zero');
  assert.match(usage.out, /usage: ocr/, 'usage error must say how to call the helper');
  console.log('ok   OCR helper rejects a missing argument');

  const missing = run(['ocr', path.join(tmp, 'does-not-exist.png')]);
  assert.notStrictEqual(missing.code, 0, 'missing file must exit non-zero');
  assert.match(missing.out, /no file/, 'missing file must say what is wrong');
  console.log('ok   OCR helper rejects a missing file');
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
