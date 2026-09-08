/**
 * The naming contract for a Passport release.
 *
 * Run with `npm run test:release-naming` (or `node --test scripts/`).
 *
 * The cases that matter are the ones the repositories actually contain: a
 * repository with nothing but legacy `demo-…` tags must start at v1, and one
 * that already has `v<N>` must count past the highest of them however that
 * number reaches us — as a `refs/tags/` line from `git ls-remote --tags`, as a
 * bare tag from `gh release list`, or as a release title.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RELEASE_BODY_LIMIT,
  fixedEntries,
  fixedSection,
  highestReleaseNumber,
  newEntries,
  nextReleaseNumber,
  previousReleaseNumber,
  releaseBody,
  releaseDate,
  releaseNumberOf,
  releaseTag,
  releaseTitle,
  summariseEntry,
} from './release-naming.mjs';

test('a legacy demo- tag carries no release number', () => {
  assert.equal(releaseNumberOf('demo-2026.09.04-19729c64'), null);
  assert.equal(releaseNumberOf('refs/tags/demo-2026.09.07-a207dee8'), null);
  assert.equal(releaseNumberOf('Passport demo 2026/09/07'), null);
});

test('a release number is read from every shape the two sources print', () => {
  assert.equal(releaseNumberOf('v4'), 4);
  assert.equal(releaseNumberOf('refs/tags/v4'), 4);
  assert.equal(releaseNumberOf('refs/tags/v4^{}'), 4);
  assert.equal(releaseNumberOf('v4 - 2026/09/07'), 4);
  assert.equal(releaseNumberOf('0123456789abcdef0123456789abcdef01234567\trefs/tags/v12'), 12);
});

test('a name that merely starts with a v is not a release', () => {
  assert.equal(releaseNumberOf('v1.2.3'), null);
  assert.equal(releaseNumberOf('vercel-output'), null);
  assert.equal(releaseNumberOf('v0'), null);
  assert.equal(releaseNumberOf(undefined), null);
});

test('a repository with only legacy tags starts at v1', () => {
  const existing = [
    'refs/tags/demo-2026.09.03-f3b1f118',
    'refs/tags/demo-2026.09.04-19729c64',
    'refs/tags/demo-2026.09.07-a207dee8',
    'Passport demo 2026/09/07',
  ];
  assert.equal(highestReleaseNumber(existing), 0);
  assert.equal(nextReleaseNumber(existing), 1);
});

test('a repository with no tags at all starts at v1', () => {
  assert.equal(nextReleaseNumber([]), 1);
  assert.equal(nextReleaseNumber(undefined), 1);
});

test('the next number is one past the highest, from either source', () => {
  // The tag ref is ahead of what `gh release list` reports, and vice versa;
  // both are consulted so neither can hand back a number already taken.
  assert.equal(nextReleaseNumber(['refs/tags/v1', 'refs/tags/v2', 'v1 - 2026/09/07']), 3);
  assert.equal(nextReleaseNumber(['refs/tags/v1', 'v9 - 2026/09/08', 'refs/tags/v2']), 10);
});

test('the count is numeric, not alphabetical', () => {
  assert.equal(nextReleaseNumber(['refs/tags/v9', 'refs/tags/v10']), 11);
});

test('the tag is v<N> and the title is v<N> - YYYY/MM/DD', () => {
  assert.equal(releaseTag(1), 'v1');
  assert.equal(releaseTitle(1, '2026/09/07'), 'v1 - 2026/09/07');
  assert.equal(releaseTitle(12, '2026/10/01'), 'v12 - 2026/10/01');
});

test('a title refuses a date in any other shape', () => {
  assert.throws(() => releaseTitle(1, '2026-09-07'), TypeError);
  assert.throws(() => releaseTitle(1, '07/09/2026'), TypeError);
  assert.throws(() => releaseTitle(0, '2026/09/07'), TypeError);
});

test('the date is UTC, formatted the way this repository writes dates', () => {
  assert.equal(releaseDate(new Date('2026-09-07T23:30:00Z')), '2026/09/07');
  // Late evening in New York is already the next day in UTC, and the tag is UTC.
  assert.equal(releaseDate(new Date('2026-09-07T04:00:00Z')), '2026/09/07');
});

test('the body carries the Fixed section, not the note to whoever writes it', () => {
  const notes = [
    'Build notes for the NEXT production deploy. Rewrite this file before every deploy.',
    '',
    '## Fixed',
    '- **Something was broken** (found 2026/09/07).',
    '',
  ].join('\n');
  assert.equal(fixedSection(notes), '## Fixed\n- **Something was broken** (found 2026/09/07).');
  assert.equal(fixedSection('no section here'), '');
});

/* The delta. RELEASE-NOTES.md is cumulative, so these two fixtures are what the
   file looked like at the previous release and what it looks like now — the
   shape that made v10 publish forty-two fixes when four had shipped. */

const previousFile = [
  'Build notes. This file is cumulative.',
  '',
  '## Fixed',
  '- **An old fix that shipped a while ago** (found by the release gate, 2026/09/05). It was broken. Then it was not.',
  '',
  '  A second paragraph nobody needs on the release page.',
  '',
  '- **Another old one** (reported 2026/09/06). Something else was wrong.',
  '',
].join('\n');

const currentFile = [
  'Build notes. This file is cumulative.',
  '',
  '## Fixed',
  '- **A brand new fix** (found in production, 2026/09/08). The sponsor was ahead of the record. It said so, loudly, and two people were told a send had failed.',
  '',
  '  A continuation paragraph, which is part of the same entry.',
  '- **An old fix that shipped a while ago** (found by the release gate, 2026/09/05). It was broken. Then it was not.',
  '',
  '  A second paragraph nobody needs on the release page.',
  '',
  '- **A second new fix** (seen against production, 2026/09/08). Shipped as `@midnight-passport/connect` 0.1.1, and the name is a `.night` name. Not this sentence.',
  '- **Another old one** (reported 2026/09/06). Something else was wrong.',
  '',
].join('\n');

test('an entry is its bold title plus the prose under it, continuations and all', () => {
  const entries = fixedEntries(currentFile);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].title, 'A brand new fix');
  assert.match(entries[0].detail, /^\(found in production, 2026\/09\/08\)\./);
  assert.match(entries[0].detail, /A continuation paragraph, which is part of the same entry\.$/);
  assert.deepEqual(fixedEntries('no Fixed section here'), []);
});

test('the delta is the entries whose title was not there at the previous release', () => {
  assert.deepEqual(
    newEntries(currentFile, previousFile).map((entry) => entry.title),
    ['A brand new fix', 'A second new fix'],
  );
  // Nothing new since the previous release: the same file, deployed twice.
  assert.deepEqual(newEntries(currentFile, currentFile), []);
  // No previous release at all: every entry is new.
  assert.equal(newEntries(currentFile, '').length, 4);
});

test('an entry summarises to one line, without its provenance parenthetical', () => {
  const [first, second] = newEntries(currentFile, previousFile);
  assert.equal(
    summariseEntry(first),
    '- **A brand new fix.** The sponsor was ahead of the record.',
  );
  // A full stop inside `0.1.1` or `.night` does not end the sentence.
  assert.equal(
    summariseEntry(second),
    '- **A second new fix.** Shipped as `@midnight-passport/connect` 0.1.1, and the name is a `.night` name.',
  );
});

test('a long first sentence is cut at a word, not mid-word', () => {
  const entry = { title: 'A long one', detail: `(found 2026/09/08). ${'word '.repeat(80)}end.` };
  const line = summariseEntry(entry, 60);
  const sentence = line.slice('- **A long one.** '.length);
  assert.ok(sentence.length <= 60, `sentence was ${sentence.length} characters`);
  assert.ok(sentence.endsWith('…'));
  assert.ok(!sentence.includes('wor…'));
  // Under the limit, the sentence is left exactly as written.
  assert.equal(summariseEntry(entry, 5000).endsWith('end.'), true);
});

test('the body is the header line and this release delta, nothing else', () => {
  const body = releaseBody({
    buildId: '42acea841f96624d',
    commit: '9477b2e7ae7c1cbc7d170c701b36e76c0e07ce13',
    entries: newEntries(currentFile, previousFile),
  });
  assert.equal(
    body.split('\n')[0],
    'Build 42acea84 · commit 9477b2e · https://midnightpassport.com',
  );
  assert.match(body, /^## Fixed in this release$/m);
  assert.equal(body.split('\n').filter((line) => line.startsWith('- **')).length, 2);
  assert.ok(!body.includes('An old fix that shipped a while ago'));
});

test('a release with no new entries says so rather than repeating the last one', () => {
  const body = releaseBody({
    buildId: '42acea841f96624d',
    commit: '9477b2e7ae7c1cbc7d170c701b36e76c0e07ce13',
    entries: newEntries(currentFile, currentFile),
  });
  assert.equal(
    body,
    [
      'Build 42acea84 · commit 9477b2e · https://midnightpassport.com',
      '',
      '## This release',
      '- Release tooling only; no user-facing change.',
    ].join('\n'),
  );
});

test('a body over 4,000 characters is refused, and --allow-long overrides it', () => {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    title: `Fix number ${index} with a title long enough to matter`,
    detail: `(found 2026/09/08). ${'a clause that runs on and on, '.repeat(12)}and then it ends.`,
  }));
  assert.equal(RELEASE_BODY_LIMIT, 4000);
  assert.throws(
    () => releaseBody({ buildId: '42acea84', commit: '9477b2e', entries }),
    (error) => error instanceof RangeError && /over the 4000-character limit/.test(error.message),
  );
  const forced = releaseBody({ buildId: '42acea84', commit: '9477b2e', entries, allowLong: true });
  assert.ok(forced.length > RELEASE_BODY_LIMIT);
});

test('the previous release is the highest v<N> below the one being created', () => {
  // v9 was never published, so the release before v10 is v8.
  const existing = ['refs/tags/v8', 'refs/tags/v10', 'v10 - 2026/09/08', 'refs/tags/demo-2026.09.04-19729c64'];
  assert.equal(previousReleaseNumber(existing, 10), 8);
  assert.equal(previousReleaseNumber(existing, 11), 10);
  assert.equal(previousReleaseNumber(existing, 1), null);
  assert.equal(previousReleaseNumber([], 4), null);
});
