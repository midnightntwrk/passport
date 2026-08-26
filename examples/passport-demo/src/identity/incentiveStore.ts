/**
 * Redeemed incentives — the "what have I earned" half of the ecosystem view.
 *
 * A record is written only when an app reports a genuine redemption back to
 * Passport (the raffle demo's connector calls `onIncentiveRedeemed`). `txId` is
 * optional because not every incentive is a transaction, but when it is set it
 * is a real chain hash and the UI links it.
 *
 * localStorage, under `passport-incentives:v1`.
 */

import { readTimestamp } from './timestamps.js';

export interface PassportIncentiveRecord {
  id: string;
  /** Which app granted it, e.g. `Midnight Raffle`. */
  app: string;
  /** What it was, in the app's own words. */
  label: string;
  txId?: string;
  network: string;
  redeemedAt: string;
}

const STORAGE_KEY = 'passport-incentives:v1';

/**
 * How many redemptions this browser keeps, newest first. Exported because a
 * restore has to be able to SAY that the cap is why a record it carried was
 * not written, rather than dropping it and reporting it stored.
 */
export const INCENTIVE_LIMIT = 50;

const listeners = new Set<(records: PassportIncentiveRecord[]) => void>();

export function loadIncentives(): PassportIncentiveRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is PassportIncentiveRecord => {
      const record = value as PassportIncentiveRecord;
      return (
        Boolean(record) &&
        typeof record.id === 'string' &&
        typeof record.app === 'string' &&
        typeof record.label === 'string' &&
        typeof record.redeemedAt === 'string'
      );
    });
  } catch {
    return [];
  }
}

export function saveIncentive(record: PassportIncentiveRecord): void {
  try {
    const existing = loadIncentives().filter((candidate) => candidate.id !== record.id);
    const next = [record, ...existing].slice(0, INCENTIVE_LIMIT);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The redemption still happened; only its record is lost.
  }
  publish();
}

/** What became of one record a bulk write was asked to store. */
export interface IncentiveWriteOutcome {
  id: string;
  /** True ONLY when the record was read back out of storage afterwards. */
  written: boolean;
  /** Why it was not written. Never absent when {@link written} is false. */
  reason?: string;
}

/**
 * Records with an unreadable date sort last, and are never silently reordered
 * past a readable one.
 *
 * The reader is the SHARED one, and it is strict about ISO-8601 for the reason
 * `./timestamps.ts` sets out. `Date.parse` was doing this job, and `Date.parse`
 * is not a validator: a file whose rewards carried `redeemedAt: '99999'` read
 * as the year 99999, sorted ahead of every genuine reward, took every place the
 * cap had left, and pushed the user's real rewards out with the cap as their
 * stated reason — while sitting permanently at the top of the merged list.
 * Anything the reader cannot read is not a date, and a record with no readable
 * date sorts last rather than first.
 */
function redeemedAtRank(value: string): number {
  return readTimestamp(value) ?? Number.NEGATIVE_INFINITY;
}

/** Newest first, with an unreadable date sorting last rather than first. */
function newestFirst(
  left: PassportIncentiveRecord,
  right: PassportIncentiveRecord,
): number {
  const leftRank = redeemedAtRank(left.redeemedAt);
  const rightRank = redeemedAtRank(right.redeemedAt);
  if (leftRank === rightRank) return 0;
  return leftRank > rightRank ? -1 : 1;
}

/**
 * Writes many redemptions in ONE read and ONE `setItem`, notifying subscribers
 * ONCE, and — the part {@link saveIncentive} cannot do for a batch — keeping
 * the list NEWEST FIRST across the merge.
 *
 * `saveIncentive` prepends, so replaying a newest-first backup through it one
 * record at a time leaves the store oldest-first and lets the
 * {@link INCENTIVE_LIMIT} cap fall on the NEWEST records. Here the incoming
 * records are ordered by `redeemedAt` before the cap is applied, so the cap
 * always falls on the oldest of them, and every record the cap leaves out
 * comes back to the caller as `written: false` with that as its reason.
 *
 * THE CAP APPLIES TO THE FILE, NEVER TO WHAT IS ALREADY HERE
 * ---------------------------------------------------------
 * A restore is not allowed to cost the user a reward they already hold. The
 * merged list used to be capped as a whole, so fifty future-dated rewards in a
 * file evicted fifty genuine local ones and reported `skipped: 0` — the file
 * won every place and nothing said so. Now the records already in this browser
 * keep their places unconditionally, the file's records fill whatever room is
 * left (newest first), and each one that finds no room is reported with the cap
 * as its reason.
 *
 * A SAME-ID RECORD IS A DUPLICATE, NOT A REPLACEMENT. A file record used to
 * REPLACE the local record of the same id — the local copy was dropped from
 * the merge before the cap, on the reasoning that one redemption deserves one
 * place. It does, and the copy already here is the one that keeps it: the
 * incoming record then had to win a place back through the cap like any other,
 * and a batch of newer records could take the last of the room, so the reward
 * the user already held was deleted from this browser altogether while the
 * outcome text asserted that local rewards are never evicted. A record whose id
 * is already here is now reported as the duplicate it is and changes nothing.
 */
export function restoreIncentives(records: PassportIncentiveRecord[]): IncentiveWriteOutcome[] {
  if (records.length === 0) return [];
  const local = loadIncentives();
  const held = new Set(local.map((record) => record.id));
  const room = Math.max(0, INCENTIVE_LIMIT - local.length);
  const admitted = [...records]
    .filter((record) => !held.has(record.id))
    .sort(newestFirst)
    .slice(0, room);
  const admittedIds = new Set(admitted.map((record) => record.id));
  const kept = [...local, ...admitted].sort(newestFirst);

  let failure: string | null = null;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }
  const stored = new Set(failure ? [] : loadIncentives().map((record) => record.id));
  const outcomes = records.map<IncentiveWriteOutcome>((record) => {
    if (failure) {
      return {
        id: record.id,
        written: false,
        reason: `this browser refused to store the record: ${failure}`,
      };
    }
    /* Asked BEFORE the read-back, because the id is in storage either way —
       the copy already here put it there — and calling that a write would
       report the file's record stored when nothing of it was. */
    if (held.has(record.id)) {
      return {
        id: record.id,
        written: false,
        reason:
          'this browser already holds a reward with this id, and the copy already here is the one that keeps its place',
      };
    }
    if (stored.has(record.id)) return { id: record.id, written: true };
    return {
      id: record.id,
      written: false,
      reason: admittedIds.has(record.id)
        ? 'the record was stored but did not read back, so this browser does not hold it'
        : `this browser keeps the ${INCENTIVE_LIMIT} most recent rewards; the rewards already here are never evicted by a restore, and the newer rewards in the file took the places that were left`,
    };
  });
  publish();
  return outcomes;
}

export function clearIncentives(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored to clear.
  }
  publish();
}

function publish(): void {
  const snapshot = loadIncentives();
  for (const listener of listeners) listener(snapshot);
}

/** Subscribes to redemption changes. Returns an unsubscribe function. */
export function subscribeIncentives(
  listener: (records: PassportIncentiveRecord[]) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
