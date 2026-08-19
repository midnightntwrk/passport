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
  /** The device commitment the contract carries, as a decimal Field. */
  deviceCommitment?: string;
  /** Whether the indexer was seen serving state at {@link address}. */
  ledgerConfirmed?: boolean;
  /** Which side really paid the deployment fee. */
  feePaidBy?: 'sponsored' | 'own-dust';
  /** Present on every `'failed'` record — never a bare status. */
  failureReason?: string;
  updatedAt: string;
}

const STORAGE_KEY = 'passport-contract:v1';

/** `credentialId` and `network` both, so neither can shadow the other. */
function recordKey(credentialId: string, network: string): string {
  return `${credentialId}::${network}`;
}

function readAll(): Record<string, PassportContractRecord> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const records: Record<string, PassportContractRecord> = {};
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
    return {};
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
  return readAll()[recordKey(credentialId, network)] ?? null;
}

/**
 * Persists a record, refusing the two shapes that would let the UI lie: a
 * `'deployed'` record with no address or no transaction id, and a `'failed'`
 * record that does not say why. The throw is deliberate — it turns a
 * would-be silent falsehood into a visible bug.
 */
export function savePassportContractRecord(record: PassportContractRecord): void {
  if (record.status === 'deployed' && (!record.address || !record.deployTxId)) {
    throw new Error(
      'A deployed Passport contract record must carry both the contract address and the deployment transaction id.',
    );
  }
  if (record.status === 'failed' && !record.failureReason) {
    throw new Error('A failed Passport contract record must explain itself with a failureReason.');
  }
  try {
    const records = readAll();
    records[recordKey(record.credentialId, record.network)] = {
      ...record,
      updatedAt: record.updatedAt || new Date().toISOString(),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // The deployment still happened; only the memory of it is lost on reload.
  }
  publish();
}

/** Forgets one record — used when a deploy is retried after a failure. */
export function clearPassportContractRecord(credentialId: string, network: string): void {
  try {
    const records = readAll();
    delete records[recordKey(credentialId, network)];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Nothing stored to clear.
  }
  publish();
}

export function clearPassportContractRecords(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored to clear.
  }
  publish();
}

/** Subscribes to record changes. Returns an unsubscribe function. */
export function subscribePassportContractRecords(
  listener: (records: Record<string, PassportContractRecord>) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
