/**
 * How a Passport release is named.
 *
 * WHY THIS EXISTS (2026/09/07)
 * ----------------------------
 * The first naming scheme tagged every deploy `demo-YYYY.MM.DD-<build id>` and
 * marked it a PRE-release. Both parts were wrong for the one person the rule is
 * for. A pre-release never shows as "Latest" on the repository's front page, so
 * a reviewer looking at midnightntwrk/passport-demo saw a three-day-old release
 * and reasonably concluded nothing had shipped since. And a tag carrying a date
 * and a build id answers "which build is this?" but not "which release is
 * this?" — there is no way to say "we are on release four" in a sentence.
 *
 * So: `v<N>`, counting up from the releases that already exist, titled
 * `v<N> - YYYY/MM/DD`. The date stays, because a release number with no date is
 * a fact nobody can place. The build id and the commit move into the body,
 * where they are still checkable against a running client.
 *
 * Everything here is pure, so `scripts/release-naming.test.mjs` can hold the
 * number derivation and the title to their contract without touching a network.
 */

/**
 * The release number a tag or release title carries, or `null` for a name that
 * is not one of ours.
 *
 * Accepts what both sources of truth actually print:
 *   - `git ls-remote --tags`:  `refs/tags/v4`, and its `refs/tags/v4^{}` peel
 *   - `gh release list`:       the tag `v4`, and the title `v4 - 2026/09/07`
 *
 * A legacy `demo-2026.09.04-19729c64` tag carries no number and is ignored,
 * which is what starts the count at v1 on a repository that has only those.
 */
export function releaseNumberOf(candidate) {
  if (typeof candidate !== 'string') {
    return null;
  }
  const name = candidate
    .trim()
    .replace(/^[0-9a-f]{40}\s+/, '') // a full `git ls-remote` line, sha and all
    .replace(/^refs\/tags\//, '')
    .replace(/\^\{\}$/, '');
  const match = /^v(\d+)(?:\s|$)/.exec(name);
  if (!match) {
    return null;
  }
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * The highest `v<N>` among the given tags and titles; 0 when there is none.
 */
export function highestReleaseNumber(candidates) {
  return (candidates ?? []).reduce((highest, candidate) => {
    const number = releaseNumberOf(candidate);
    return number !== null && number > highest ? number : highest;
  }, 0);
}

/**
 * The number the next release takes: one past the highest that exists, so a
 * repository with no `v<N>` releases starts at v1.
 */
export function nextReleaseNumber(candidates) {
  return highestReleaseNumber(candidates) + 1;
}

/** `v4`. */
export function releaseTag(number) {
  assertNumber(number);
  return `v${number}`;
}

/** `v4 - 2026/09/07`. */
export function releaseTitle(number, date) {
  assertNumber(number);
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date ?? '')) {
    throw new TypeError(`release date must be YYYY/MM/DD, got ${JSON.stringify(date)}`);
  }
  return `${releaseTag(number)} - ${date}`;
}

/**
 * Today in UTC as `YYYY/MM/DD`, so two people in two timezones tagging the same
 * deploy agree.
 */
export function releaseDate(now = new Date()) {
  return now.toISOString().slice(0, 10).replaceAll('-', '/');
}

/**
 * The "## Fixed" section of RELEASE-NOTES.md — the heading and everything under
 * it. The file opens with a line of instructions to whoever writes it next,
 * which belongs in the repository and not in a release body.
 *
 * Returns '' when there is no such section; the caller decides whether that is
 * fatal (it is, for a real release).
 */
export function fixedSection(notes) {
  const match = /^##\s*Fixed\s*$/im.exec(notes ?? '');
  return match ? notes.slice(match.index).trim() : '';
}

function assertNumber(number) {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`release number must be a positive integer, got ${JSON.stringify(number)}`);
  }
}
