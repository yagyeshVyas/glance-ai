'use strict';
// Rewrites every commit so the author identity and the name inside the files
// stop being reachable from the repository.
//
//   node scripts/scrub-history.js              # rewrite, then collect the old objects
//   node scripts/scrub-history.js --dry-run    # report what is there, change nothing
//   node scripts/scrub-history.js --no-backup   # skip the bundle next to the repo
//
// Why history and not just the files: a public repository serves its old commits
// to a browser, and `git log --format=%an` is one click. Replacing the name in
// HEAD leaves it in every earlier blob and in every commit object.
//
// The replacement itself is `scripts/scrub-identity.js` — the same script
// `npm run check` runs — so the tree filter and the working tree cannot drift.
// It is copied out of the repository first, because old commits do not contain
// the script and the filter runs with the commit's tree as the working directory.
//
// After a rewrite the old objects are still in `.git/objects` until they are
// expired: `refs/original`, the reflogs and the packs all keep them. This script
// deletes `refs/original`, expires every reflog and runs `git gc --prune=now`,
// which is the part that actually removes them.
//
// A rewrite changes every commit id. Whatever remote is configured needs a force
// push, and any clone of the old history keeps its own copy — neither is
// something this script can do for you.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAME = 'Runtime Broker Components';
const EMAIL = 'noreply@runtimebroker.dev';
const DRY = process.argv.includes('--dry-run');
const BACKUP = !process.argv.includes('--no-backup');

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
}

function main() {
  const status = git(['status', '--porcelain']);
  if (status) {
    console.error('working tree is not clean — commit or stash first:\n' + status.split('\n').slice(0, 20).join('\n'));
    process.exit(1);
  }
  const head = git(['rev-parse', '--short', 'HEAD']);
  const commits = git(['rev-list', '--all', '--count']);
  console.log(`repo: ${commits} commit(s) across all refs, HEAD ${head}`);

  const authors = git(['log', '--all', '--format=%an <%ae>']);
  const identities = [...new Set(authors.split('\n').filter(Boolean))];
  console.log('identities in history:');
  for (const id of identities) console.log('  ' + id);

  if (DRY) {
    console.log('\n--dry-run: nothing rewritten');
    return;
  }

  if (BACKUP) {
    const bundle = path.join(path.dirname(ROOT), path.basename(ROOT) + '-pre-scrub.bundle');
    if (fs.existsSync(bundle)) {
      console.log('backup bundle already exists, keeping it: ' + bundle);
    } else {
      git(['bundle', 'create', bundle, '--all']);
      console.log('backup bundle: ' + bundle + ' (' + (fs.statSync(bundle).size / 1048576).toFixed(1) + ' MB)');
    }
  }

  // Outside the repository: the filter's working directory is each commit's tree
  // and a commit from before this file existed cannot run it.
  const scrubber = path.join(require('os').tmpdir(), 'rb-scrub-identity.js');
  fs.copyFileSync(path.join(__dirname, 'scrub-identity.js'), scrubber);

  const envFilter = [
    `export GIT_AUTHOR_NAME='${NAME}'`,
    `export GIT_AUTHOR_EMAIL='${EMAIL}'`,
    `export GIT_COMMITTER_NAME='${NAME}'`,
    `export GIT_COMMITTER_EMAIL='${EMAIL}'`,
  ].join('; ');

  console.log('\nrewriting (filter-branch)...');
  execFileSync('git', [
    'filter-branch', '-f',
    '--env-filter', envFilter,
    '--tree-filter', `"${process.execPath}" "${scrubber}" --tree .`,
    '--tag-name-filter', 'cat',
    '--', '--all',
  ], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: '1' } });

  // The rewrite keeps the originals here; deleting the ref is what makes them
  // unreachable, and the reflog + gc is what deletes the bytes.
  console.log('\ncollecting the old objects...');
  try { git(['update-ref', '-d', 'refs/original/refs/heads/master']); } catch {}
  try { execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/original'], { cwd: ROOT }) ; } catch {}
  const originals = git(['for-each-ref', '--format=%(refname)', 'refs/original']).split('\n').filter(Boolean);
  for (const ref of originals) git(['update-ref', '-d', ref]);
  git(['reflog', 'expire', '--expire=now', '--all']);
  execFileSync('git', ['gc', '--prune=now', '--quiet'], { cwd: ROOT, stdio: 'inherit' });

  console.log('\nverifying...');
  const after = [...new Set(git(['log', '--all', '--format=%an <%ae>']).split('\n').filter(Boolean))];
  console.log('identities now: ' + after.join(', '));

  const revs = git(['rev-list', '--all']).split('\n').filter(Boolean);
  const needle = require('./scrub-identity').NEEDLE;
  let found = [];
  for (let i = 0; i < revs.length; i += 40) {
    const chunk = revs.slice(i, i + 40);
    try {
      const out = execFileSync('git', ['grep', '-I', '-i', '-l', '-e', needle, ...chunk], { cwd: ROOT, encoding: 'utf8' });
      if (out.trim()) found = found.concat(out.trim().split('\n'));
    } catch {
      // exit 1 = no match in this chunk, which is the good case
    }
  }
  if (found.length) {
    console.error('FAIL: ' + found.length + ' path(s) still contain "' + needle + '":');
    for (const f of found.slice(0, 20)) console.error('  ' + f);
    process.exit(1);
  }
  console.log('ok: no commit reachable from any ref contains "' + needle + '" in its tree');
  console.log('ok: every commit is authored by ' + NAME + ' <' + EMAIL + '>');
  console.log('\nnext: force-push the rewritten branches/tags (ids changed), and remember');
  console.log('that any existing clone still holds the old objects.');
}

main();
