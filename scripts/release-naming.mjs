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

/**
 * WHAT A RELEASE BODY SAYS (2026/09/08)
 * -------------------------------------
 * RELEASE-NOTES.md is CUMULATIVE: every "## Fixed" entry written since
 * 2026/09/03 is still in it, because it is the changelog. Its header line used
 * to tell whoever wrote it next to rewrite the file before every deploy, and
 * nobody ever did — so publishing the whole section made v10 on GitHub a
 * 51,000-character page listing forty-two fixes, the same text v1 to v8 had
 * carried. A reviewer opening it cannot tell what THIS deploy changed, which
 * is the only question a release page exists to answer.
 *
 * So the file stays cumulative and the release page carries the DELTA: the
 * entries whose bold title was not already there at the previous release, one
 * line each. The full prose stays in the repository, where whoever wants it
 * will look for it.
 */

/** How long one entry's summary sentence may run before it is trimmed. */
export const SUMMARY_SENTENCE_LIMIT = 220;

/**
 * How long the whole body may run. A release over this means someone deployed
 * far too much at once — the interesting failure, not a formatting problem —
 * so it is refused rather than truncated, and the operator can insist with
 * `--allow-long`.
 */
export const RELEASE_BODY_LIMIT = 4000;

/* A sentence end is a full stop followed by whitespace, so neither `0.1.1` nor
   `` `.night` `` splits one. These are the remaining cases where that rule
   would end a sentence too early. */
const ABBREVIATIONS = ['e.g.', 'i.e.', 'etc.', 'vs.', 'mr.', 'mrs.', 'ms.', 'dr.'];

/**
 * The entries of the "## Fixed" section, as `{ title, detail }`.
 *
 * An entry opens with `- **Title**` at the start of a line and runs until the
 * next one (or the next heading); its indented continuation paragraphs are
 * folded into `detail`, so a summary can be taken from the whole of it.
 */
export function fixedEntries(notes) {
  const section = fixedSection(notes);
  if (!section) {
    return [];
  }
  const entries = [];
  let current = null;
  for (const line of section.split('\n').slice(1)) {
    const opening = /^-\s+\*\*(.+?)\*\*\s*(.*)$/.exec(line);
    if (opening) {
      current = { title: opening[1].trim(), detail: [opening[2].trim()].filter(Boolean) };
      entries.push(current);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      current = null;
      continue;
    }
    if (current && line.trim()) {
      current.detail.push(line.trim());
    }
  }
  return entries.map(({ title, detail }) => ({ title, detail: detail.join(' ') }));
}

/**
 * The entries in `notes` that were not already in `previousNotes`, matched on
 * the bold title. A title is what a human would recognise as "the same fix";
 * the prose under it is edited between deploys and the commits are not in the
 * file at all, so neither can be the identity.
 */
export function newEntries(notes, previousNotes) {
  const previous = new Set(fixedEntries(previousNotes).map((entry) => entry.title));
  return fixedEntries(notes).filter((entry) => !previous.has(entry.title));
}

/**
 * One entry as one line: `- **Title.** First sentence of the entry.`
 *
 * The "(found by the release gate, 2026/09/08)" parenthetical every entry
 * opens with is dropped — it is provenance for the changelog, not news for the
 * release page — and the sentence is capped, so one very long sentence cannot
 * push the body over its limit by itself.
 */
export function summariseEntry(entry, limit = SUMMARY_SENTENCE_LIMIT) {
  const title = String(entry?.title ?? '').trim().replace(/[.\s]+$/, '');
  const detail = String(entry?.detail ?? '').replace(/^\s*\([^()]*\)\s*[.,;:]?\s*/, '');
  const sentence = capSentence(firstSentence(detail), limit);
  return sentence ? `- **${title}.** ${sentence}` : `- **${title}.**`;
}

/**
 * The body of a release: the header line, then this release's delta.
 *
 * Throws a `RangeError` when the result is over `bodyLimit` and `allowLong` is
 * not set, because a body that long is a deploy that should have been two.
 */
export function releaseBody({
  buildId,
  commit,
  productionUrl = 'https://midnightpassport.com',
  entries = [],
  gateSummary,
  sentenceLimit = SUMMARY_SENTENCE_LIMIT,
  bodyLimit = RELEASE_BODY_LIMIT,
  allowLong = false,
} = {}) {
  const header =
    `Build ${String(buildId ?? '').slice(0, 8)} · ` +
    `commit ${String(commit ?? '').slice(0, 7)} · ${productionUrl}`;
  const delta = entries.length
    ? ['## Fixed in this release', ...entries.map((entry) => summariseEntry(entry, sentenceLimit))]
    : ['## This release', '- Release tooling only; no user-facing change.'];
  const body = [
    header,
    '',
    ...delta,
    ...(gateSummary ? ['', 'Gates', '-----', gateSummary] : []),
  ].join('\n');
  if (!allowLong && body.length > bodyLimit) {
    throw new RangeError(
      `the release body is ${body.length} characters, over the ${bodyLimit}-character limit ` +
        `(${entries.length} new ${entries.length === 1 ? 'entry' : 'entries'}). That is more than ` +
        "one deploy's worth of change: deploy less at a time, or pass --allow-long to publish it anyway.",
    );
  }
  return body;
}

/**
 * The release before number `below`: the highest `v<N>` among the given tags
 * and titles that is lower than it, or `null` when there is none. That is the
 * release whose RELEASE-NOTES.md the delta is taken against.
 */
export function previousReleaseNumber(candidates, below) {
  assertNumber(below);
  const previous = (candidates ?? []).reduce((highest, candidate) => {
    const number = releaseNumberOf(candidate);
    return number !== null && number < below && number > highest ? number : highest;
  }, 0);
  return previous > 0 ? previous : null;
}

function firstSentence(text) {
  const ends = /[.!?](?=\s|$)/g;
  let match;
  while ((match = ends.exec(text)) !== null) {
    const head = text.slice(0, match.index + 1);
    const lowered = head.toLowerCase();
    if (ABBREVIATIONS.some((abbreviation) => lowered.endsWith(abbreviation))) {
      continue;
    }
    return head.trim();
  }
  return text.trim();
}

function capSentence(sentence, limit) {
  if (sentence.length <= limit) {
    return sentence;
  }
  const cut = sentence.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed.replace(/[\s,;:.]+$/, '')}…`;
}

function assertNumber(number) {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`release number must be a positive integer, got ${JSON.stringify(number)}`);
  }
}
