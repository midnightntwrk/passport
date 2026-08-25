/**
 * Alias claim records — one per network.
 *
 * The store holds only what actually happened. A `'registered'` record must
 * carry both real transaction ids; anything short of that is `'queued'` (with
 * the reason it is queued, in words the user can act on) or `'failed'`. There
 * is deliberately no "pending" state that looks like success.
 *
 * localStorage, keyed by network, under `passport-alias:v1`.
 */

export type AliasRecordStatus = 'registered' | 'queued' | 'failed';

export interface AliasRecord {
  alias: string;
  domain: string;
  network: string;
  status: AliasRecordStatus;
  resolverAddress?: string;
  resolverDeployTxId?: string;
  registerTxId?: string;
  /** Present on every `'queued'` and `'failed'` record — never a bare status. */
  queuedReason?: string;
  /** Whether the registry itself was seen carrying the name. */
  registryConfirmed?: boolean;
  /**
   * What the resolver leaf this record's claim deployed actually points at.
   *
   * OPTIONAL, and absent on every record written before 2026/08/19 — those
   * claims all bound the name to the wallet's unshielded address, because that
   * was the only path the code had. The field is not back-filled: a reader
   * that finds it missing knows only that the record predates the choice, and
   * the identity card says exactly that rather than asserting a value nobody
   * recorded. `'contract'` means the name resolves to this Passport's
   * account-custody contract.
   */
  resolverTarget?: 'wallet' | 'contract';
  /** The raw 64-hex bytes {@link resolverTarget} resolves to, when recorded. */
  resolverTargetHex?: string;
  updatedAt: string;
}

const STORAGE_KEY = 'passport-alias:v1';

function readAll(): Record<string, AliasRecord> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const records: Record<string, AliasRecord> = {};
    for (const [network, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as AliasRecord;
      if (
        record &&
        typeof record.alias === 'string' &&
        typeof record.domain === 'string' &&
        (record.status === 'registered' || record.status === 'queued' || record.status === 'failed')
      ) {
        records[network] = { ...record, network };
      }
    }
    return records;
  } catch {
    // Storage denied or corrupt: the session simply has no remembered alias.
    return {};
  }
}

const listeners = new Set<(records: Record<string, AliasRecord>) => void>();

function publish(): void {
  const snapshot = readAll();
  for (const listener of listeners) listener(snapshot);
}

export function loadAliasRecords(): Record<string, AliasRecord> {
  return readAll();
}

export function loadAliasRecord(network: string): AliasRecord | null {
  return readAll()[network] ?? null;
}

/**
 * Why this record may not be stored, in the store's own words, or null when it
 * may.
 *
 * Split out of {@link saveAliasRecord} so the bulk path below enforces the SAME
 * invariants instead of a second copy of them that could drift.
 */
function refuseAliasRecord(record: AliasRecord): string | null {
  if (record.status === 'registered' && (!record.resolverDeployTxId || !record.registerTxId)) {
    return 'A registered alias record must carry both the resolver deployment and registration transaction ids.';
  }
  if (record.status !== 'registered' && !record.queuedReason) {
    return 'A queued or failed alias record must explain itself with a queuedReason.';
  }
  return null;
}

export function saveAliasRecord(record: AliasRecord): void {
  const refusal = refuseAliasRecord(record);
  if (refusal) throw new Error(refusal);
  try {
    const records = readAll();
    records[record.network] = { ...record, updatedAt: record.updatedAt || new Date().toISOString() };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // The claim still happened; only the memory of it is lost on reload.
  }
  publish();
}

/** What became of one record a bulk write was asked to store. */
export interface AliasRecordWriteOutcome {
  network: string;
  /**
   * True ONLY when the record was read back out of storage afterwards. A
   * `setItem` that throws (private browsing, quota) and a record this store's
   * own reader filters out on load both land here as `false` with the reason,
   * because a caller that counts writes must count what survived, not what was
   * attempted.
   */
  written: boolean;
  /** Why it was not written. Never absent when {@link written} is false. */
  reason?: string;
}

/**
 * Writes many records in ONE read and ONE `setItem`, notifying subscribers ONCE.
 *
 * {@link saveAliasRecord} re-reads and re-serialises the whole map and publishes
 * on every call, which is right for the one-record path every claim takes and
 * quadratic for a restore carrying dozens. This is the bulk path for
 * `../identity/backup.ts`, and it reports per record whether the write actually
 * survived rather than assuming it did.
 */
export function restoreAliasRecords(records: AliasRecord[]): AliasRecordWriteOutcome[] {
  const next = readAll();
  const now = new Date().toISOString();
  const staged: string[] = [];
  const outcomes = records.map<AliasRecordWriteOutcome>((record) => {
    const refusal = refuseAliasRecord(record);
    if (refusal) return { network: record.network, written: false, reason: refusal };
    next[record.network] = { ...record, updatedAt: record.updatedAt || now };
    staged.push(record.network);
    return { network: record.network, written: true };
  });
  if (staged.length === 0) return outcomes;

  let failure: string | null = null;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }
  const readBack = failure ? {} : readAll();
  for (const outcome of outcomes) {
    if (!outcome.written) continue;
    if (failure) {
      outcome.written = false;
      outcome.reason = `this browser refused to store the record: ${failure}`;
    } else if (!readBack[outcome.network]) {
      outcome.written = false;
      outcome.reason =
        'the record was stored but did not read back, so this browser does not hold it';
    }
  }
  publish();
  return outcomes;
}

export function clearAliasRecords(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored to clear.
  }
  publish();
}

/** Subscribes to record changes. Returns an unsubscribe function. */
export function subscribeAliasRecords(
  listener: (records: Record<string, AliasRecord>) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
