'use strict';
// Replaces the author's name in every text file of a tree.
//
//   node scripts/scrub-identity.js            # working tree (repo root)
//   node scripts/scrub-identity.js --tree DIR # one commit's tree, for git
//   node scripts/scrub-identity.js --check    # exit 1 if anything is left
//
// Two callers: a one-shot pass over the working tree, and `git filter-branch
// --tree-filter` when the same replacement has to reach history. A name is not
// hidden while it is still in `git log --all`, in a blob reachable from an old
// tag, or in a file nobody edited since.
//
// Binary files are skipped by content sniff (NUL byte in the first 8 KiB), so a
// .node addon or an .ico is never corrupted by a text replace.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// The needles are stored base64-encoded on purpose. This file is itself part of
// the history the pass in scripts/scrub-history.js rewrites, so a plaintext copy
// of the name here would be the one occurrence the pass cannot remove: the file
// would be rewritten inside every commit and immediately reintroduce it.
//
// Order matters — the longest forms first, because the login contains the
// surname's owner and the noreply address contains both.
const dec = (s) => Buffer.from(s, 'base64').toString('utf8');
const RULES = [
  [dec('MTU3ODU3ODcyK3lhZ3llc2hWeWFzQHVzZXJzLm5vcmVwbHkuZ2l0aHViLmNvbQ=='), 'noreply@runtimebroker.dev'],
  [dec('eWFneWVzaEB1c2Vycy5ub3JlcGx5LmdpdGh1Yi5jb20='), 'noreply@runtimebroker.dev'],
  [dec('WWFneWVzaCBWeWFz'), 'Runtime Broker Components'],
  [dec('eWFneWVzaFZ5YXM='), 'runtimebroker'],
  [dec('eWFneWVzaHZ5YXM='), 'runtimebroker'],
  [dec('WWFneWVzaA=='), 'Runtime'],
  [dec('eWFneWVzaA=='), 'runtime'],
];
if (RULES.some(([from]) => !from)) throw new Error('scrub: a needle failed to decode');

// The one token every verification greps for, likewise encoded.
const NEEDLE = dec('eWFneWVzaA==');

// This file holds the needles it replaces, so it is never rewritten.
const SELF = path.basename(__filename);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'vendor']);
const TEXT_EXT = new Set([
  '.js', '.json', '.md', '.html', '.yml', '.yaml', '.ps1', '.cmd', '.cs',
  '.nsh', '.svg', '.txt', '.css', '.example', '', '.cjs', '.mjs',
]);

function isText(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(path.join(dir, ent.name), out);
    } else if (ent.isFile()) {
      if (ent.name === SELF) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!TEXT_EXT.has(ext) && ent.name !== 'LICENSE' && ent.name !== 'audit') continue;
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

function scrubText(text) {
  let out = text;
  for (const [from, to] of RULES) out = out.split(from).join(to);
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const ti = argv.indexOf('--tree');
  const root = ti >= 0 ? path.resolve(argv[ti + 1]) : ROOT;

  let changed = 0;
  const hits = [];
  for (const file of walk(root)) {
    if (!isText(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = scrubText(before);
    if (before === after) continue;
    if (check) {
      hits.push(path.relative(root, file));
    } else {
      fs.writeFileSync(file, after);
      changed++;
    }
  }

  if (check) {
    if (hits.length) {
      console.error('identity: ' + hits.length + ' file(s) still name the author:');
      for (const h of hits.slice(0, 40)) console.error('  ' + h);
      process.exit(1);
    }
    console.log('ok   identity: no author name in the tree');
    return;
  }
  console.log('identity: rewrote ' + changed + ' file(s) under ' + root);
}

if (require.main === module) main();

module.exports = { RULES, NEEDLE, scrubText };
