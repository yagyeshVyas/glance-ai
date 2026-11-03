'use strict';
// Re-stamp latest.yml from the files that actually shipped.
//
// Signing happens AFTER electron-builder writes latest.yml: the app payload is
// signed in afterSign, then sign-build re-signs the installers. Every one of
// those steps rewrites bytes, so the sha512 and size recorded in latest.yml
// describe the pre-signature file. electron-updater verifies that hash and
// rejects the download, which is a silent "update never installs" bug.
//
// This recomputes both fields from the signed artifacts on disk. Blockmaps have
// the same problem and cannot be regenerated without app-builder, so they are
// dropped: the updater falls back to a full download when a blockmap is absent,
// where a stale one would fail a differential check it cannot satisfy.
//
//   node scripts/refresh-latest-yml.js [dist dir]

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const dist = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist'));
const yml = path.join(dist, 'latest.yml');

if (!fs.existsSync(yml)) {
  console.log('refresh-latest-yml: no latest.yml at ' + yml + ' — skipped');
  process.exit(0);
}

const doc = yaml.load(fs.readFileSync(yml, 'utf8'));
const stamp = (url) => {
  const file = path.join(dist, path.basename(url));
  if (!fs.existsSync(file)) throw new Error('latest.yml names a missing file: ' + url);
  const buf = fs.readFileSync(file);
  return { sha512: crypto.createHash('sha512').update(buf).digest('base64'), size: buf.length };
};

let fixed = 0;
for (const entry of doc.files || []) {
  const next = stamp(entry.url);
  if (entry.sha512 !== next.sha512 || entry.size !== next.size) fixed++;
  Object.assign(entry, next);
}
if (doc.path) Object.assign(doc, stamp(doc.path));

fs.writeFileSync(yml, yaml.dump(doc));
console.log(`refresh-latest-yml: re-stamped ${fixed} file hash(es) from the signed artifacts`);

// stale blockmaps would be offered to the updater and fail
let dropped = 0;
for (const f of fs.readdirSync(dist)) {
  if (!f.endsWith('.exe.blockmap')) continue;
  fs.unlinkSync(path.join(dist, f));
  dropped++;
}
if (dropped) console.log(`refresh-latest-yml: removed ${dropped} pre-signature blockmap(s)`);
