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
  fixedSection,
  highestReleaseNumber,
  nextReleaseNumber,
  releaseDate,
  releaseNumberOf,
  releaseTag,
  releaseTitle,
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
