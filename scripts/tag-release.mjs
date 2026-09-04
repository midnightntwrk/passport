/**
 * Tags a production deploy as a pre-release on GitHub.
 *
 * WHY THIS EXISTS (2026/09/03)
 * ----------------------------
 * The rule from review is that every production deploy is backed by a GitHub
 * release tag — nothing fancy, just the release tag, so that "what is live"
 * is a question with an answer. Today's deploy was tagged by hand as
 * `demo-2026.09.03-f3b1f118`, which is exactly the step that gets skipped at
 * the end of a long day. So it runs from the deploy script instead.
 *
 * It is the LAST step of `deploy:passport:manual`, after Vercel has accepted
 * the upload. A tag for a deploy that failed would be worse than no tag.
 *
 * WHAT THE TAG IS
 * ---------------
 *   demo-<YYYY.MM.DD>-<first 8 of the service-worker build id>
 *
 * The date is UTC, so two people in two timezones tagging the same deploy
 * agree. The build id is the one the service worker carries — see the header
 * of `examples/passport-demo/public/sw.js` — and it is read from `dist/sw.js`,
 * the stamped copy, because that is the identity the installed client reports
 * back. A tag naming a build id is therefore checkable against a browser:
 * ask the service worker for its BUILD_ID and the two agree, or the client is
 * running something other than what was tagged.
 *
 * WHAT IT REFUSES
 * ---------------
 * A dirty tree (`git status --porcelain` says anything at all, uncommitted or
 * untracked) and an unauthenticated `gh`. Both mean the tag would name a
 * commit that is not what was uploaded, which is the whole thing the rule is
 * for. It also refuses an unstamped `__BUILD_ID__`, which means the build did
 * not run.
 *
 * It is idempotent: re-running after a re-deploy of the same build on the same
 * day prints the existing tag and exits 0.
 *
 * USAGE
 * -----
 *   node scripts/tag-release.mjs [--dry-run]
 *
 *   --dry-run   print the `gh release create` command and exit, creating
 *               nothing. The preflight checks still run — they are read-only.
 *
 *   PASSPORT_RELEASE_REPO    default `midnightntwrk/passport`, this repository.
 *                            The carry into `midnightntwrk/passport-demo` sets
 *                            it to that, so the same deploy is tagged the same
 *                            way in both places.
 *   PASSPORT_RELEASE_NOTES   the gate summary, appended to the notes verbatim.
 *                            Whatever was actually run: typecheck, unit tests,
 *                            the PWA check, a browser walk.
 *   PASSPORT_RELEASE_URL     default `https://midnightpassport.com`.
 *
 * `--target <sha>` names the deployed commit, so the release points at what
 * shipped rather than at whatever the default branch has moved on to. That sha
 * has to be on the remote already; if it is not, `gh` says so and this exits
 * non-zero — push, then re-run.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceWorker = path.join(repositoryRoot, 'examples/passport-demo/dist/sw.js');

const releaseRepository = process.env.PASSPORT_RELEASE_REPO || 'midnightntwrk/passport';
const productionUrl = process.env.PASSPORT_RELEASE_URL || 'https://midnightpassport.com';
const gateSummary = process.env.PASSPORT_RELEASE_NOTES;
/* Every release must say which issues it fixes. The notes are written by hand
   in RELEASE-NOTES.md at the repository root before deploying — one "Fixed"
   entry per issue, who reported it, what the cause was, and the commits — and
   the file is consumed here. Refusing without it is the point. */
const notesFile = path.join(repositoryRoot, 'RELEASE-NOTES.md');
let issueNotes;
try {
  issueNotes = readFileSync(notesFile, 'utf8').trim();
} catch {
  issueNotes = '';
}
if (!dryRun && !/##\s*Fixed/i.test(issueNotes)) {
  fail('RELEASE-NOTES.md is missing or has no "## Fixed" section. Write one entry per issue fixed, then tag.');
}
const dryRun = process.argv.includes('--dry-run');

function fail(message) {
  console.error(`tag-release: ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    fail(`\`${command}\` is not on PATH.`);
  }
  return result;
}

function git(...args) {
  const result = run('git', ['-C', repositoryRoot, ...args]);
  if (result.status !== 0) {
    fail(`\`git ${args.join(' ')}\` failed: ${(result.stderr || '').trim()}`);
  }
  return result.stdout.trim();
}

// Preflight. Read-only, so it runs under --dry-run too.

const dirty = git('status', '--porcelain');
if (dirty) {
  fail(
    'the working tree is dirty, so a tag would name a commit that is not what ' +
      `was deployed. Commit or stash first:\n${dirty}`,
  );
}

const auth = run('gh', ['auth', 'status']);
if (auth.status !== 0) {
  fail('`gh` is not authenticated. Run `gh auth login`.');
}

let serviceWorkerSource;
try {
  serviceWorkerSource = readFileSync(serviceWorker, 'utf8');
} catch {
  fail(
    `${path.relative(repositoryRoot, serviceWorker)} is missing. ` +
      'Build the demo before tagging.',
  );
}

const buildIdMatch = /^const BUILD_ID = '([^']+)';/m.exec(serviceWorkerSource);
if (!buildIdMatch) {
  fail(`no \`const BUILD_ID = '…'\` in ${path.relative(repositoryRoot, serviceWorker)}.`);
}

const buildId = buildIdMatch[1];
if (buildId === '__BUILD_ID__') {
  fail('the build id is still the `__BUILD_ID__` placeholder, so the build did not stamp it.');
}

const commit = git('rev-parse', 'HEAD');
const date = new Date().toISOString().slice(0, 10).replaceAll('-', '.');
const tag = `demo-${date}-${buildId.slice(0, 8)}`;

// Already tagged? A re-deploy of the same build on the same day is not an error.

const existing = run('gh', ['release', 'view', tag, '--repo', releaseRepository]);
if (existing.status === 0) {
  console.log(`tag-release: ${releaseRepository} already has ${tag}; nothing to do.`);
  process.exit(0);
}

const notes = [
  `Build id: ${buildId} · Commit: ${commit.slice(0, 7)} · Production: ${productionUrl}`,
  '',
  issueNotes,
  ...(gateSummary ? ['', 'Gates', '-----', gateSummary] : []),
].join('\n');

const args = [
  'release',
  'create',
  tag,
  '--repo',
  releaseRepository,
  '--target',
  commit,
  '--prerelease',
  '--title',
  `Passport demo ${date.replaceAll('.', '/')}`,
  '--notes',
  notes,
];

if (dryRun) {
  const quoted = args
    .map((arg) => (/^[\w.:/@-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
    .join(' ');
  console.log(`tag-release: --dry-run, creating nothing. Would run:\n\ngh ${quoted}\n`);
  process.exit(0);
}

const created = run('gh', args);
process.stdout.write(created.stdout);
if (created.status !== 0) {
  fail(`\`gh release create\` failed: ${(created.stderr || '').trim()}`);
}
console.log(`tag-release: ${releaseRepository} tagged ${tag} (build ${buildId}).`);
