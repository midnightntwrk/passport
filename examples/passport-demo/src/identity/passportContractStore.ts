/**
 * Passport account-custody contract records — one per credential and network.
 *
 * The same discipline `./aliasStore.ts` keeps for alias claims applies here,
 * for the same reason: the store holds only what actually happened. A
 * `'deployed'` record must carry both a real contract address and a real
 * deployment transaction id; anything short of that is `'failed'` with the
 * reason it failed, in words the user can act on. There is deliberately no
 * "pending" state that looks like success — a deploy in flight lives in React
 * state and is written here only once the chain has answered.
 *
 * Keyed by credential AND network, because both matter: one passkey may hold a
 * contract on the localnet and another on preview, and a contract deployed on
 * one network is not a contract on the other. The credential id comes first so
 * a second passkey in the same browser never reads the first one's contract.
 *
 * localStorage, under `passport-contract:v1`.
 */

export type PassportContractRecordStatus = 'deployed' | 'failed';

export interface PassportContractRecord {
  /** The passkey credential this contract's device secret is derived from. */
  credentialId: string;
  /** The network the deployment really landed on. */
  network: string;
  status: PassportContractRecordStatus;
  /** Raw 64-hex contract address. Present on every `'deployed'` record. */
  address?: string;
  /** The deployment transaction. Present on every `'deployed'` record. */
  deployTxId?: string;
  /**
   * Whether {@link deployTxId} is the 32-byte ledger HASH an explorer can
   * resolve, rather than the 33-byte identifier `submitTransaction` answers
   * with. `false` means the indexer had not yet mapped it when the deployment
   * was written — the id is real either way, but nothing may link it until
   * this is `true`. Absent on records written before this field existed; a
   * reader should treat that as "unknown" and check the value itself.
   */
  txIdResolved?: boolean;
  /** The device commitment the contract carries, as a decimal Field. */
  deviceCommitment?: string;
  /** Whether the indexer was seen serving state at {@link address}. */
  ledgerConfirmed?: boolean;
  /** Which side really paid the deployment fee. */
  feePaidBy?: 'sponsored' | 'own-dust';
  /** Present on every `'failed'` record — never a bare status. */
  failureReason?: string;
  /**
   * True when this record was NOT written by a deployment this device
   * performed, but seeded from the contract address the passkey itself carries
   * in its WebAuthn largeBlob (see `demo-backend/src/passkey.ts`) on a browser
   * that had never seen this Passport.
   *
   * A recovered record therefore has NO deployment transaction — this device
   * never saw one, and inventing a plausible id would be exactly the lie the
   * rest of this store exists to prevent. What it does have is an address the
   * indexer answered for: {@link savePassportContractRecord} refuses a
   * recovered record whose {@link ledgerConfirmed} is not `true`, so "recovered"
   * can never be written on the strength of the blob alone.
   */
  recovered?: boolean;
  /**
   * True when this record was written by a RESTORE from a backup file rather
   * than by a deployment this device performed.
   *
   * `../identity/backup.ts` sets it on every record it writes and no other
   * path sets it at all, so it is the only thing that distinguishes "this
   * browser submitted a deployment and the indexer has not caught up" from
   * "a file said this address exists and nothing here has checked". Both carry
   * `ledgerConfirmed: false`, and the card must not tell the second story with
   * the first one's words.
   */
  restoredFromBackup?: boolean;
  /**
   * When this record last changed, ISO-8601 — and ABSENT where nothing has
   * ever recorded one. See `./aliasStore.ts`'s field of the same name: the
   * bulk restore below stamped an undated file entry with the moment of the
   * restore, and that invented date then outranked the user's own genuine
   * backup for good.
   */
  updatedAt?: string;
  /**
   * When a restore wrote this record into THIS browser, ISO-8601. A fact about
   * the browser, never about the record: no comparison in
   * `../identity/backup.ts` consults it, and it is not in that module's export
   * allow-list, so it never reaches a backup file.
   */
  restoredAt?: string;
}

const STORAGE_KEY = 'passport-contract:v1';

/**
 * The storage key for one credential's contract on one network — `credentialId`
 * and `network` both, so neither can shadow the other.
 *
 * Exported because callers hold the whole record map (through
 * {@link subscribePassportContractRecords}) and have to index into it. Spelling
 * the key out at the call site is how a reader and a writer drift apart.
 */
export function passportContractRecordKey(credentialId: string, network: string): string {
  return `${credentialId}::${network}`;
}

/**
 * A null-prototype map, for the reason spelled out on `./aliasStore.ts`:
 * `__proto__` is a legal JSON key, an ordinary object turns a write to it into
 * a prototype assignment that stores nothing, and the read-back this store
 * reports its counts from would then answer from `Object.prototype` and call
 * that a written record.
 */
function emptyRecordMap(): Record<string, PassportContractRecord> {
  return Object.create(null) as Record<string, PassportContractRecord>;
}

function readAll(): Record<string, PassportContractRecord> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyRecordMap();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyRecordMap();
    const records: Record<string, PassportContractRecord> = emptyRecordMap();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as PassportContractRecord;
      if (
        record &&
        typeof record.credentialId === 'string' &&
        typeof record.network === 'string' &&
        (record.status === 'deployed' || record.status === 'failed')
      ) {
        records[key] = record;
      }
    }
    return records;
  } catch {
    // Storage denied or corrupt: the session simply has no remembered contract.
    return emptyRecordMap();
  }
}

const listeners = new Set<(records: Record<string, PassportContractRecord>) => void>();

function publish(): void {
  const snapshot = readAll();
  for (const listener of listeners) listener(snapshot);
}

export function loadPassportContractRecords(): Record<string, PassportContractRecord> {
  return readAll();
}

/** The contract this credential holds on this network, or null. */
export function loadPassportContractRecord(
  credentialId: string,
  network: string,
): PassportContractRecord | null {
  const records = readAll();
  const key = passportContractRecordKey(credentialId, network);
  return Object.hasOwn(records, key) ? records[key]! : null;
}

/**
 * Persists a record, refusing the two shapes that would let the UI lie: a
 * `'deployed'` record with no address or no transaction id, and a `'failed'`
 * record that does not say why. The throw is deliberate — it turns a
 * would-be silent falsehood into a visible bug.
 */
/**
 * Why this record may not be stored, in the store's own words, or null when it
 * may.
 *
 * Split out of {@link savePassportContractRecord} so the bulk path below
 * enforces the SAME invariants instead of a second copy of them that could
 * drift.
 *
 * It enforces what {@link readAll} filters on, for the reason spelled out on
 * `./aliasStore.ts`'s `refuseAliasRecord`: a predicate that admits a record the
 * reader discards lets that record be staged over a valid one, persisted, and
 * then vanish on the way back out — and the valid record it replaced vanishes
 * with it, while the caller is told only that the write "did not read back".
 *
 * EXPORTED since 2026/08/26, for `../identity/backup.ts`. A restore that
 * deduplicates two file entries onto one store key has to choose between them,
 * and choosing by date alone discarded a fully restorable older entry in favour
 * of a newer one this predicate then refused outright — the file's two-entry
 * claim restored neither. The restore asks this question BEFORE it dedupes, so
 * the choice is made among the entries that can actually be written. The
 * predicate stays the store's, so there is still exactly one copy of it.
 */
export function refusePassportContractRecord(record: PassportContractRecord): string | null {
  if (typeof record.credentialId !== 'string' || typeof record.network !== 'string') {
    return 'A Passport contract record must name the credential and the network it was deployed on, both as text.';
  }
  if (record.status !== 'deployed' && record.status !== 'failed') {
    return 'A Passport contract record\'s status must be deployed or failed.';
  }
  if (record.status === 'deployed' && record.recovered) {
    /* The recovered case, and the only one exempt from the transaction-id
       rule: this device did not witness the deployment, so it has no id to
       carry. In exchange the bar is higher — the address must have been
       confirmed against the chain before the record may exist at all. */
    if (!record.address || record.ledgerConfirmed !== true) {
      return 'A recovered Passport contract record must carry the contract address and a confirmed on-chain read-back.';
    }
  } else if (record.status === 'deployed' && (!record.address || !record.deployTxId)) {
    return 'A deployed Passport contract record must carry both the contract address and the deployment transaction id.';
  }
  if (record.status === 'failed' && !record.failureReason) {
    return 'A failed Passport contract record must explain itself with a failureReason.';
  }
  return null;
}

export function savePassportContractRecord(record: PassportContractRecord): void {
  const refusal = refusePassportContractRecord(record);
  if (refusal) throw new Error(refusal);
  try {
    const records = readAll();
    records[passportContractRecordKey(record.credentialId, record.network)] = {
      ...record,
      updatedAt: record.updatedAt || new Date().toISOString(),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // The deployment still happened; only the memory of it is lost on reload.
  }
  publish();
}

/** What became of one record a bulk write was asked to store. */
export interface PassportContractWriteOutcome {
  /** The {@link passportContractRecordKey} the record was written under. */
  key: string;
  /**
   * True ONLY when the record was read back out of storage afterwards — see
   * `./aliasStore.ts`'s outcome type for why an attempted write is not a write.
   */
  written: boolean;
  /** Why it was not written. Never absent when {@link written} is false. */
  reason?: string;
}

/**
 * Writes many records in ONE read and ONE `setItem`, notifying subscribers ONCE.
 *
 * The bulk path for `../identity/backup.ts`, for the reason given on
 * `restoreAliasRecords`: a restore that saved record by record re-serialised
 * this whole map and re-rendered every subscriber once per record.
 */
export function restorePassportContractRecords(
  records: PassportContractRecord[],
): PassportContractWriteOutcome[] {
  const next = readAll();
  const now = new Date().toISOString();
  let stagedCount = 0;
  const outcomes = records.map<PassportContractWriteOutcome>((record) => {
    const key = passportContractRecordKey(record.credentialId, record.network);
    const refusal = refusePassportContractRecord(record);
    if (refusal) return { key, written: false, reason: refusal };
    /* The record's OWN date, or none — never the moment of the restore. See
       {@link PassportContractRecord.updatedAt}. */
    const stored: PassportContractRecord = { ...record, restoredAt: now };
    if (!record.updatedAt) delete stored.updatedAt;
    next[key] = stored;
    stagedCount += 1;
    return { key, written: true };
  });
  if (stagedCount === 0) return outcomes;

  let failure: string | null = null;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }
  const readBack = failure ? emptyRecordMap() : readAll();
  for (const outcome of outcomes) {
    if (!outcome.written) continue;
    if (failure) {
      outcome.written = false;
      outcome.reason = `this browser refused to store the record: ${failure}`;
    } else if (!Object.hasOwn(readBack, outcome.key)) {
      outcome.written = false;
      outcome.reason =
        'the record was stored but did not read back, so this browser does not hold it';
    }
  }
  publish();
  return outcomes;
}

/** Subscribes to record changes. Returns an unsubscribe function. */
export function subscribePassportContractRecords(
  listener: (records: Record<string, PassportContractRecord>) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
