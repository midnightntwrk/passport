/**
 * Tags a production deploy as a GitHub release.
 *
 * WHY THIS EXISTS (2026/09/03)
 * ----------------------------
 * The rule from review is that every production deploy is backed by a GitHub
 * release tag — nothing fancy, just the release tag, so that "what is live"
 * is a question with an answer. The first deploy was tagged by hand, which is
 * exactly the step that gets skipped at the end of a long day. So it runs from
 * the deploy script instead.
 *
 * It is the LAST step of `deploy:passport:manual`, after Vercel has accepted
 * the upload. A tag for a deploy that failed would be worse than no tag.
 *
 * WHAT THE RELEASE IS (2026/09/07)
 * --------------------------------
 *   tag     v<N>              N is one past the highest v<N> that exists
 *   title   v<N> - YYYY/MM/DD
 *   body    the build id, the commit, and the production URL, then the
 *           "## Fixed" section of RELEASE-NOTES.md
 *
 * It is NOT a pre-release. That was the first scheme's real mistake: GitHub
 * never shows a pre-release as "Latest", so a reviewer reading the repository
 * front page saw a three-day-old release and concluded nothing had shipped.
 *
 * The number is derived from what both sources of truth say — the tag refs
 * (`git ls-remote --tags`) and the releases (`gh release list`) — so a tag
 * pushed without a release, or a release whose tag was deleted, still counts.
 * The derivation itself lives in `release-naming.mjs` and is unit-tested.
 *
 * The build id is the one the service worker carries — see the header of
 * `examples/passport-demo/public/sw.js` — and is read from `dist/sw.js`, the
 * stamped copy, because that is the identity the installed client reports
 * back. A body naming a build id is therefore checkable against a browser:
 * ask the service worker for its BUILD_ID and the two agree, or the client is
 * running something other than what was released.
 *
 * WHAT IT REFUSES
 * ---------------
 * A dirty tree (`git status --porcelain` says anything at all, uncommitted or
 * untracked) and an unauthenticated `gh`. Both mean the release would name a
 * commit that is not what was uploaded, which is the whole thing the rule is
 * for. It also refuses an unstamped `__BUILD_ID__`, which means the build did
 * not run, and RELEASE-NOTES.md with no "## Fixed" section.
 *
 * It is idempotent: a build that already has a release — under a `v<N>` tag or
 * under a legacy `demo-…` one — is reported and left alone, so re-running
 * after a re-deploy of the same build creates nothing.
 *
 * USAGE
 * -----
 *   node scripts/tag-release.mjs [options]
 *
 *   --dry-run            print the `gh release create` command and exit,
 *                        creating nothing. The preflight checks still run —
 *                        they are read-only.
 *   --repo <owner/name>  the repository to release in. Default
 *                        `midnightntwrk/passport`, this one. The carry into
 *                        `midnightntwrk/passport-demo` passes that, so the same
 *                        deploy is released the same way in both places.
 *   --commit <sha>       the commit the release points at. Default HEAD. An
 *                        older deploy is not at HEAD any more, and the carried
 *                        commit has a different sha in passport-demo; naming it
 *                        also makes the notes come from THAT commit's
 *                        RELEASE-NOTES.md rather than from the working tree,
 *                        so the release says what that build shipped. It is
 *                        resolved against the repository this is RUN in, so
 *                        the mirror release is made from a passport-demo
 *                        checkout, not from here.
 *   --build-id <id>      the service-worker build id. Default: read from the
 *                        stamped `dist/sw.js`. Needed when releasing a deploy
 *                        that is not the last thing built here — mirroring
 *                        into passport-demo, or filling in a release after the
 *                        fact — because `dist/` has moved on.
 *
 *   The commit has to be on the remote already; if it is not, `gh` says so and
 *   this exits non-zero — push, then re-run.
 *
 *   PASSPORT_RELEASE_REPO    same as `--repo` (the flag wins).
 *   PASSPORT_RELEASE_NOTES   the gate summary, appended to the body verbatim.
 *                            Whatever was actually run: typecheck, unit tests,
 *                            the PWA check, a browser walk.
 *   PASSPORT_RELEASE_URL     default `https://midnightpassport.com`.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixedSection, nextReleaseNumber, releaseDate, releaseTag, releaseTitle } from './release-naming.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceWorker = path.join(repositoryRoot, 'examples/passport-demo/dist/sw.js');

const dryRun = process.argv.includes('--dry-run');
const releaseRepository = option('--repo') || process.env.PASSPORT_RELEASE_REPO || 'midnightntwrk/passport';
const requestedCommit = option('--commit');
const requestedBuildId = option('--build-id');
const productionUrl = process.env.PASSPORT_RELEASE_URL || 'https://midnightpassport.com';
const gateSummary = process.env.PASSPORT_RELEASE_NOTES;

function option(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    fail(`${flag} needs a value.`);
  }
  return value;
}

function fail(message) {
  console.error(`tag-release: ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
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
    'the working tree is dirty, so a release would name a commit that is not what ' +
      `was deployed. Commit or stash first:\n${dirty}`,
  );
}

const auth = run('gh', ['auth', 'status']);
if (auth.status !== 0) {
  fail('`gh` is not authenticated. Run `gh auth login`.');
}

const commit = git('rev-parse', requestedCommit ?? 'HEAD');

/* Every release must say which issues it fixes. The notes are written by hand
   in RELEASE-NOTES.md at the repository root before deploying — one "Fixed"
   entry per issue, who reported it, what the cause was, and the commits — and
   the file is consumed here. Refusing without it is the point.

   With `--commit`, the notes come from that commit, because a release for an
   earlier deploy must say what THAT deploy shipped, not what has been fixed
   since. */
let issueNotes = '';
if (requestedCommit) {
  const shown = run('git', ['-C', repositoryRoot, 'show', `${commit}:RELEASE-NOTES.md`]);
  issueNotes = shown.status === 0 ? shown.stdout : '';
} else {
  try {
    issueNotes = readFileSync(path.join(repositoryRoot, 'RELEASE-NOTES.md'), 'utf8');
  } catch {
    issueNotes = '';
  }
}
const fixed = fixedSection(issueNotes);
if (!dryRun && !fixed) {
  fail(
    'RELEASE-NOTES.md is missing or has no "## Fixed" section' +
      `${requestedCommit ? ` at ${commit.slice(0, 7)}` : ''}. ` +
      'Write one entry per issue fixed, then tag.',
  );
}

let buildId = requestedBuildId;
if (!buildId) {
  let serviceWorkerSource;
  try {
    serviceWorkerSource = readFileSync(serviceWorker, 'utf8');
  } catch {
    fail(
      `${path.relative(repositoryRoot, serviceWorker)} is missing. ` +
        'Build the demo before tagging, or pass --build-id.',
    );
  }

  const buildIdMatch = /^const BUILD_ID = '([^']+)';/m.exec(serviceWorkerSource);
  if (!buildIdMatch) {
    fail(`no \`const BUILD_ID = '…'\` in ${path.relative(repositoryRoot, serviceWorker)}.`);
  }
  buildId = buildIdMatch[1];
}

if (buildId === '__BUILD_ID__') {
  fail('the build id is still the `__BUILD_ID__` placeholder, so the build did not stamp it.');
}

// What the repository already has: the tag refs and the releases. Both, because
// either can exist without the other, and a number already taken is worse than
// a number skipped.

const remoteUrl = `https://github.com/${releaseRepository}.git`;
const tagRefs = run('git', ['ls-remote', '--tags', remoteUrl]);
if (tagRefs.status !== 0) {
  console.warn(
    `tag-release: could not read tags from ${remoteUrl} ` +
      `(${(tagRefs.stderr || '').trim()}); counting from the releases alone.`,
  );
}
const refNames = (tagRefs.stdout || '')
  .split('\n')
  .map((line) => line.split('\t')[1] ?? '')
  .filter(Boolean);

const listed = run('gh', [
  'release',
  'list',
  '--repo',
  releaseRepository,
  '--limit',
  '200',
  '--json',
  'tagName,name',
]);
if (listed.status !== 0) {
  fail(`\`gh release list\` failed: ${(listed.stderr || '').trim()}`);
}
let releases = [];
try {
  releases = JSON.parse(listed.stdout || '[]');
} catch {
  fail('`gh release list --json` did not return JSON.');
}

/* `gh release list` cannot return bodies, and the build id lives in the body,
   so the bodies come from the API. A repository we cannot read the bodies of
   still gets a release — the tag check below is the weaker guard, not the only
   one. */
const bodies = run('gh', ['api', `repos/${releaseRepository}/releases?per_page=100`, '--jq', '.[].body']);
const releaseBodies = bodies.status === 0 ? bodies.stdout : '';

// Already released? A re-deploy of the same build is not an error. The build id
// is in the body of every release this script writes, and in the tag of every
// legacy `demo-…` one.

const already = releases.find((release) => (release.tagName ?? '').endsWith(`-${buildId.slice(0, 8)}`));
if (already || releaseBodies.includes(`Build id: ${buildId}`)) {
  console.log(
    `tag-release: ${releaseRepository} already has a release for build ${buildId}` +
      `${already ? ` (${already.tagName})` : ''}; nothing to do.`,
  );
  process.exit(0);
}

const number = nextReleaseNumber([...refNames, ...releases.flatMap((r) => [r.tagName, r.name])]);
const tag = releaseTag(number);
const date = releaseDate();

const body = [
  `Build id: ${buildId} · Commit: ${commit.slice(0, 7)} · Production: ${productionUrl}`,
  '',
  fixed,
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
  '--latest',
  '--title',
  releaseTitle(number, date),
  '--notes',
  body,
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
console.log(
  `tag-release: ${releaseRepository} released ${releaseTitle(number, date)} ` +
    `at ${commit.slice(0, 7)} (build ${buildId}).`,
);
