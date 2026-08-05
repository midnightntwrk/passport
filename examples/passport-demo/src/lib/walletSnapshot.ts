/**
 * Smart-sync persistence for the in-browser Midnight wallet.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MAKES RESUME REAL, NOT COSMETIC
 * ---------------------------------------------------------------------------
 * The three component wallets each expose `serializeState(): Promise<string>`
 * and each class exposes a `restore(serializedState)` starter. The strings this
 * module stores are those SDK snapshots verbatim — this file never inspects,
 * rewrites, or synthesises their contents. What matters is what the SDK puts
 * inside them (read from the shipped `dist` on 2026/08/05, SDK versions:
 * facade 4.0.0, shielded 3.0.0, unshielded 3.0.0, dust 4.0.0):
 *
 *   - shielded  `{ publicKeys, state (hex ZswapLocalState), protocolVersion,
 *                  networkId, offset: progress.appliedIndex, coinHashes }`
 *   - unshielded `{ publicKey, state, protocolVersion, networkId, appliedId }`
 *   - dust      `{ …, protocolVersion, networkId, offset }`
 *
 * On restore, the shielded and DUST sync loops start their indexer
 * subscription AT the stored offset — `wallet-sdk-shielded`'s `Sync.js` reads
 * `state.progress.appliedIndex` and calls `ZswapEvents.run({ id:
 * Number(appliedIndex) })`, with `appliedIndex` documented there as "the first
 * block number we haven't processed yet". So a resumed wallet continues the
 * chain walk instead of replaying it from zero. That is the whole point of
 * this cache; nothing here fakes a synced state.
 *
 * ---------------------------------------------------------------------------
 * KEYING AND FAILURE POSTURE
 * ---------------------------------------------------------------------------
 * A snapshot is only valid for the (networkId, unshielded address) pair it was
 * taken from, so that is the primary key — switching networks or passports can
 * never resume the wrong chain state. `WALLET_SNAPSHOT_VERSION` guards against
 * a future change to this record's shape.
 *
 * {@link loadWalletSnapshot} NEVER throws and NEVER guesses: a missing record,
 * a version bump, a key mismatch, or an unavailable IndexedDB all return
 * `null`, which the caller treats as "cold start". Corrupt SDK payloads are
 * not detectable here — `restore()` is what rejects them — so the caller is
 * responsible for clearing a snapshot the SDK refused (see
 * {@link deleteWalletSnapshot}).
 */

const DATABASE = 'passport-wallet-cache';
const STORE = 'snapshots';

/** Bump when the shape of {@link WalletSnapshot} itself changes. */
export const WALLET_SNAPSHOT_VERSION = 1;

export interface WalletSnapshot {
  version: 1;
  /** The Midnight network the snapshot was taken on, e.g. `preview`. */
  networkId: string;
  /** Bech32m `mn_addr…` unshielded address that owns this state. */
  unshieldedAddress: string;
  /** ISO-8601 timestamp of the save, for display and debugging only. */
  savedAt: string;
  /** Verbatim `facade.shielded.serializeState()` output. */
  shielded: string;
  /** Verbatim `facade.unshielded.serializeState()` output. */
  unshielded: string;
  /** Verbatim `facade.dust.serializeState()` output. */
  dust: string;
}

export function walletSnapshotKey(networkId: string, unshieldedAddress: string): string {
  return `${networkId}:${unshieldedAddress}`;
}

async function database(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error('IndexedDB is unavailable in this browser.');
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onerror = () =>
      reject(request.error ?? new Error('Unable to open the Passport wallet sync cache.'));
    request.onblocked = () =>
      reject(new Error('The Passport wallet sync cache is blocked by another tab.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const result = operation(transaction.objectStore(STORE));
      result.onsuccess = () => resolve(result.result);
      result.onerror = () =>
        reject(result.error ?? new Error('The Passport wallet sync cache request failed.'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('The Passport wallet sync cache aborted.'));
    });
  } finally {
    db.close();
  }
}

/**
 * Writes a snapshot, replacing any previous one for the same network and
 * address. Rejects if the cache is unavailable; the wallet treats that as a
 * non-event (the next session simply cold-starts).
 */
export async function saveWalletSnapshot(snapshot: WalletSnapshot): Promise<void> {
  await withStore('readwrite', (store) =>
    store.put(snapshot, walletSnapshotKey(snapshot.networkId, snapshot.unshieldedAddress)),
  );
}

/**
 * Reads the snapshot for one network and address, or `null` when there is
 * nothing safe to resume from. Never throws.
 */
export async function loadWalletSnapshot(
  networkId: string,
  unshieldedAddress: string,
): Promise<WalletSnapshot | null> {
  let record: unknown;
  try {
    record = await withStore('readonly', (store) =>
      store.get(walletSnapshotKey(networkId, unshieldedAddress)),
    );
  } catch (cause) {
    console.debug('[walletSnapshot] cache unreadable; cold start', cause);
    return null;
  }
  if (!record || typeof record !== 'object') return null;
  const candidate = record as Partial<WalletSnapshot>;
  if (candidate.version !== WALLET_SNAPSHOT_VERSION) return null;
  // The key already encodes both, but a hand-edited or migrated row must not
  // be able to smuggle another chain's state in under this key.
  if (candidate.networkId !== networkId) return null;
  if (candidate.unshieldedAddress !== unshieldedAddress) return null;
  if (
    typeof candidate.shielded !== 'string' ||
    typeof candidate.unshielded !== 'string' ||
    typeof candidate.dust !== 'string' ||
    typeof candidate.savedAt !== 'string'
  ) {
    return null;
  }
  return {
    version: WALLET_SNAPSHOT_VERSION,
    networkId,
    unshieldedAddress,
    savedAt: candidate.savedAt,
    shielded: candidate.shielded,
    unshielded: candidate.unshielded,
    dust: candidate.dust,
  };
}

/**
 * Removes exactly one snapshot. Used when the SDK's `restore()` rejects a
 * payload, so that one bad row is dropped and unrelated passports on the same
 * network keep their caches. Never throws.
 */
export async function deleteWalletSnapshot(
  networkId: string,
  unshieldedAddress: string,
): Promise<void> {
  try {
    await withStore('readwrite', (store) =>
      store.delete(walletSnapshotKey(networkId, unshieldedAddress)),
    );
  } catch (cause) {
    console.debug('[walletSnapshot] unable to delete snapshot', cause);
  }
}

/**
 * Clears cached sync state — every network when `networkId` is omitted, or one
 * network's rows when it is given. This is what a "Reset local sync cache"
 * control calls after a chain reset: the next session cold-starts honestly
 * rather than resuming against a chain that no longer has those blocks.
 */
export async function clearWalletSnapshots(networkId?: string): Promise<void> {
  if (networkId === undefined) {
    try {
      await withStore('readwrite', (store) => store.clear());
    } catch (cause) {
      console.debug('[walletSnapshot] unable to clear the sync cache', cause);
    }
    return;
  }
  let keys: IDBValidKey[];
  try {
    keys = await withStore('readonly', (store) => store.getAllKeys());
  } catch (cause) {
    console.debug('[walletSnapshot] unable to enumerate the sync cache', cause);
    return;
  }
  const prefix = `${networkId}:`;
  const doomed = keys.filter((key) => typeof key === 'string' && key.startsWith(prefix));
  for (const key of doomed) {
    try {
      await withStore('readwrite', (store) => store.delete(key));
    } catch (cause) {
      console.debug(`[walletSnapshot] unable to delete ${String(key)}`, cause);
    }
  }
}
