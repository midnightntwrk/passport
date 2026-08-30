/**
 * The activity trail's rules — what a row says about WHEN, which day it sits
 * under, which dot it wears, and what survives a reload.
 *
 * Passport has recorded activity since it had anything to record: `addActivity`
 * in `App.tsx` has seven call sites and every one of them writes a real row.
 * Until 2026/08/30 nothing rendered them. That is the defect this module is the
 * pure half of — the JSX that paints the list is in `src/screens/Home.tsx`, and
 * everything here is a decision a test can hold to.
 *
 * The decisions are worth drilling because each of them is a way of misleading
 * somebody about their own money:
 *
 *   - a relative time that rounds the wrong way makes a transfer look older or
 *     fresher than it is, and "2 min ago" against a row from yesterday is the
 *     kind of thing a person acts on;
 *   - a day heading computed off UTC rather than the reader's own calendar puts
 *     this morning's transfer under "Yesterday" for anyone west of Greenwich;
 *   - a status dot that flattens `blocked` into `complete` claims something
 *     happened that did not.
 *
 * WHAT IS NOT HERE
 * ----------------
 * Storage. `readStoredActivity` and `serialiseActivity` are the two halves of
 * persistence that can be reasoned about — a parse that refuses junk, and a
 * writer that caps what it keeps — and the `window.localStorage` call between
 * them is two lines in `App.tsx`. A module that touched storage could not be
 * drilled in this workspace without a fake DOM, and a fake DOM proves nothing
 * about a real one.
 */

/** The four states `addActivity` can write. Mirrors `ActivityEntry` in `App.tsx`. */
export type ActivityFeedStatus = 'pending' | 'complete' | 'blocked' | 'error';

/** One row, as the feed needs it. A subset of `App.tsx`'s own `ActivityEntry`. */
export interface ActivityFeedEntry {
  id: string;
  label: string;
  detail: string;
  status: ActivityFeedStatus;
  /** ISO-8601, as `addActivity` writes it. */
  createdAt: string;
  /** The ledger transaction hash, where the entry has one. */
  txHash?: string;
  /**
   * The network the row was written on.
   *
   * Stored with the row rather than read from the switcher at render time,
   * because the two are not the same fact: a transfer made on preview and
   * looked at after switching to stagenet would otherwise be offered a stagenet
   * explorer link for a preview hash — a link that goes somewhere and shows
   * nothing.
   */
  network?: string;
}

/**
 * The three dots a reader can tell apart at a glance.
 *
 * `blocked` and `error` share one, and deliberately: they are different
 * SENTENCES — one is "nothing happened", the other is "it failed" — but they
 * are the same signal, which is that this row wants reading. A fourth colour
 * would be a distinction the eye cannot make and the copy already makes.
 */
export type ActivityDot = 'pending' | 'complete' | 'attention';

export function activityDot(status: ActivityFeedStatus): ActivityDot {
  if (status === 'complete') return 'complete';
  if (status === 'pending') return 'pending';
  return 'attention';
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long ago, in the plainest words that stay true.
 *
 * Rounds DOWN throughout: a row written 119 seconds ago is "1 min ago", not
 * "2 min ago". Rounding up is how a feed comes to claim more elapsed time than
 * has elapsed, and the only reader who checks is the one who is waiting.
 *
 * A timestamp in the future is a clock disagreeing with itself — the device's
 * against the one that wrote the row — and is reported as "just now" rather
 * than as a negative age. An unreadable one gets the same answer for the same
 * reason: the row is real, only its clock is not.
 */
export function relativeTime(createdAt: string, now: Date = new Date()): string {
  const written = Date.parse(createdAt);
  if (Number.isNaN(written)) return 'just now';
  const elapsed = now.getTime() - written;
  if (elapsed < 45_000) return 'just now';
  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    return minutes <= 1 ? '1 min ago' : `${minutes} min ago`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.floor(elapsed / DAY_MS);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** `2026/08/30` — the house date format, from the reader's OWN calendar. */
function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}/${month}/${day}`;
}

/**
 * The heading a row sits under: `Today`, `Yesterday`, or its date.
 *
 * Computed from the LOCAL calendar on both sides, never from the elapsed
 * milliseconds. "Less than 24 hours old" and "today" are different questions,
 * and answering the second with the first is what puts a 23:30 row under
 * "Today" at 00:30 the following morning.
 */
export function dayHeading(createdAt: string, now: Date = new Date()): string {
  const written = new Date(createdAt);
  if (Number.isNaN(written.getTime())) return 'Earlier';
  const key = localDateKey(written);
  if (key === localDateKey(now)) return 'Today';
  const yesterday = new Date(now.getTime());
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === localDateKey(yesterday)) return 'Yesterday';
  return key;
}

/** One day's worth of rows, newest first. */
export interface ActivityDayGroup {
  heading: string;
  entries: ActivityFeedEntry[];
}

/** How many rows Home shows. Everything older is still stored, just not shown. */
export const ACTIVITY_VISIBLE = 10;

/**
 * The last {@link ACTIVITY_VISIBLE} rows, newest first, split into days.
 *
 * The caller hands entries in whatever order it holds them; this sorts, because
 * a feed that trusted its input order would put a restored row from last week
 * above one written a second ago. Rows with an unreadable timestamp sort last
 * and group under "Earlier" — they are still real, and dropping them would hide
 * something that happened.
 */
export function groupActivityByDay(
  entries: readonly ActivityFeedEntry[],
  now: Date = new Date(),
  limit: number = ACTIVITY_VISIBLE,
): ActivityDayGroup[] {
  const sortable = entries.map((entry) => {
    const at = Date.parse(entry.createdAt);
    return { entry, at: Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at };
  });
  sortable.sort((left, right) => right.at - left.at);
  const groups: ActivityDayGroup[] = [];
  for (const { entry } of sortable.slice(0, limit)) {
    const heading = dayHeading(entry.createdAt, now);
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.entries.push(entry);
    else groups.push({ heading, entries: [entry] });
  }
  return groups;
}

/* -------------------------------------------------------------------------- */
/* Persistence — the two halves that can be reasoned about                    */
/* -------------------------------------------------------------------------- */

/** How many rows are KEPT. Five times what is shown, so scrolling back works. */
export const ACTIVITY_KEEP = 50;

/**
 * Where one Passport's trail lives.
 *
 * Keyed by credential, because a browser can hold several Passports and one
 * Passport's transfers are not another's to display. The version prefix is
 * there so a future shape change abandons the old records rather than trying
 * to read them.
 */
export function activityStorageKey(credentialId: string): string {
  return `midnight.passport.activity.v1:${credentialId}`;
}

function isFeedStatus(value: unknown): value is ActivityFeedStatus {
  return value === 'pending' || value === 'complete' || value === 'blocked' || value === 'error';
}

/**
 * Reads a stored trail back, keeping only rows that are entirely well-formed.
 *
 * Every refusal here is a refusal to render something invented. A row with no
 * label would paint an empty line with a dot beside it; one with an unknown
 * status would fall through the dot mapping; one with a non-string hash would
 * build a link to nowhere. Storage is a place other code can write to, and this
 * is the only reader, so it is the only place that check can live.
 *
 * A parse failure is not an error condition — it is a browser with nothing
 * stored, or storage somebody else has written over — and the answer to both is
 * an empty trail.
 */
export function readStoredActivity(raw: string | null | undefined): ActivityFeedEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: ActivityFeedEntry[] = [];
  for (const candidate of parsed) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const row = candidate as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) continue;
    if (typeof row.label !== 'string' || !row.label) continue;
    if (typeof row.detail !== 'string') continue;
    if (!isFeedStatus(row.status)) continue;
    if (typeof row.createdAt !== 'string' || Number.isNaN(Date.parse(row.createdAt))) continue;
    const entry: ActivityFeedEntry = {
      id: row.id,
      label: row.label,
      detail: row.detail,
      status: row.status,
      createdAt: row.createdAt,
    };
    if (typeof row.txHash === 'string' && row.txHash) entry.txHash = row.txHash;
    if (typeof row.network === 'string' && row.network) entry.network = row.network;
    entries.push(entry);
  }
  return entries;
}

/**
 * The trail as it is written back — newest first, capped at {@link
 * ACTIVITY_KEEP}, and carrying only the fields {@link readStoredActivity} will
 * accept. Writing a field the reader discards is how a store comes to hold
 * things nobody can explain.
 */
export function serialiseActivity(entries: readonly ActivityFeedEntry[]): string {
  const kept = entries.slice(0, ACTIVITY_KEEP).map((entry) => ({
    id: entry.id,
    label: entry.label,
    detail: entry.detail,
    status: entry.status,
    createdAt: entry.createdAt,
    ...(entry.txHash ? { txHash: entry.txHash } : {}),
    ...(entry.network ? { network: entry.network } : {}),
  }));
  return JSON.stringify(kept);
}
