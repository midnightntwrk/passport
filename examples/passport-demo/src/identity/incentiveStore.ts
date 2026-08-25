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

/** Records with an unreadable date sort last, and are never silently reordered past a readable one. */
function redeemedAtRank(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Writes many redemptions in ONE read and ONE `setItem`, notifying subscribers
 * ONCE, and — the part {@link saveIncentive} cannot do for a batch — keeping
 * the list NEWEST FIRST across the merge.
 *
 * `saveIncentive` prepends, so replaying a newest-first backup through it one
 * record at a time leaves the store oldest-first and lets the
 * {@link INCENTIVE_LIMIT} cap fall on the NEWEST records. Here the merged list
 * is ordered by `redeemedAt` before the cap is applied, so the cap always
 * discards the oldest, and every record the cap discards comes back to the
 * caller as `written: false` with that as its reason.
 */
export function restoreIncentives(records: PassportIncentiveRecord[]): IncentiveWriteOutcome[] {
  if (records.length === 0) return [];
  const incoming = new Set(records.map((record) => record.id));
  const merged = [...records, ...loadIncentives().filter((record) => !incoming.has(record.id))];
  merged.sort((left, right) => {
    const leftRank = redeemedAtRank(left.redeemedAt);
    const rightRank = redeemedAtRank(right.redeemedAt);
    if (leftRank === rightRank) return 0;
    return leftRank > rightRank ? -1 : 1;
  });
  const kept = merged.slice(0, INCENTIVE_LIMIT);

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
    if (stored.has(record.id)) return { id: record.id, written: true };
    return {
      id: record.id,
      written: false,
      reason: kept.includes(record)
        ? 'the record was stored but did not read back, so this browser does not hold it'
        : `this browser keeps the ${INCENTIVE_LIMIT} most recent rewards and this one is older than all of them`,
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
