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
    const next = [record, ...existing].slice(0, 50);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The redemption still happened; only its record is lost.
  }
  publish();
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
