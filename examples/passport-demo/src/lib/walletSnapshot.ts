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
 *
 * ---------------------------------------------------------------------------
 * TIP BOOTSTRAP — TRIED 2026/08/06, DOES NOT WORK, KEPT AS EVIDENCE
 * ---------------------------------------------------------------------------
 * NOTHING IN THE APP CALLS THE TWO FUNCTIONS BELOW, AND NOTHING SHOULD UNTIL
 * THE LEDGER GAINS THE API THIS SECTION SAYS IS MISSING. Read this before
 * wiring them up; the experiment has already been run.
 *
 * The idea. Pre-production is ~1.98M blocks deep and a from-genesis walk of it
 * kills a browser tab, so a wallet CREATED in this app — which cannot have
 * transactions predating its own creation — ought to be able to start at the
 * chain tip. Mechanically that is one small edit: take the empty state the SDK
 * serialises for a brand-new wallet and move its `offset`/`appliedId` to the
 * highest index each component's own subscription reports
 * ({@link fetchChainTipIndices}, {@link retargetSerializedStateToTip}), then
 * hand it to the same `restore()` starters smart sync uses. The wallet does
 * come up, and the facade does report synced within ~3 s.
 *
 * Why it is not usable. It stays synced only until the first event arrives.
 * Both `ZswapLocalState` and `DustLocalState` carry a local copy of a GLOBAL
 * commitment tree that must be filled in strictly increasing index order, and
 * an empty tree cannot accept an insert from the middle of the chain. Measured
 * against the live Pre-production indexer, `replayEventsWithChanges` throws:
 *
 *   values inserted non-linearly into zswap commitment tree;
 *     expected to insert index 0, but received 17671.
 *   values inserted non-linearly into dust commitment tree;
 *     expected to insert index 0, but received 1023684.
 *
 * The wallet then sits in a permanent error-and-retry loop — `appliedIndex`
 * frozen, `highestRelevantWalletIndex` climbing, ~0.6 SDK errors a second —
 * which is worse than refusing, because for the first few seconds it looks
 * synced.
 *
 * Why it cannot be patched from here. The ledger has exactly one fast-forward
 * primitive, `ZswapLocalState.applyCollapsedUpdate(MerkleTreeCollapsedUpdate)`,
 * and the public indexer serves no collapsed update to feed it: its whole
 * subscription surface is `blocks`, `contractActions`, `dustGenerations`,
 * `dustLedgerEvents`, `dustNullifierTransactions`,
 * `shieldedNullifierTransactions`, `shieldedTransactions`,
 * `unshieldedTransactions`, and `zswapLedgerEvents`. `DustLocalState` has no
 * equivalent primitive at all. Skipping the walk therefore requires state that
 * only something which has already walked the chain can produce.
 *
 * What DOES hold, and is worth keeping:
 *
 *   - The unshielded component needs no bootstrap. Its subscription is
 *     address-scoped, so a fresh address gets `highestTransactionId: 0` and is
 *     strictly complete from the first message. Verified on Pre-production.
 *   - These indices are event ordinals, not block heights: on 2026/08/06 the
 *     chain stood at block 1,980,335 while `zswapLedgerEvents.maxId` was
 *     1,383,866 and `dustLedgerEvents.maxId` 1,383,873.
 *   - A DUST-only walk from genesis is not a cheaper subset: measured at
 *     ~410 events/s with the heap past 3 GB inside 30 s, ~1 % of the stream.
 *   - {@link fetchChainHeight} is used in earnest — it backs the depth guard in
 *     `./localWallet.ts`, which refuses a walk no browser tab can finish.
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
      /* The key is passed as its own argument rather than interpolated: a
         value that reached the log through a format specifier could forge a
         line in it. */
      console.debug('[walletSnapshot] unable to delete', String(key), cause);
    }
  }
}

// ---------------------------------------------------------------------------
// Tip bootstrap — the refuted experiment. See the header before using any of
// this. `fetchChainHeight` further down is the only part in live use.
// ---------------------------------------------------------------------------

/**
 * The highest index each component's own indexer subscription reports, in the
 * units that component's `SyncProgress` compares against. Never mix them: the
 * three streams advance independently (7 apart on Pre-production when this was
 * written).
 */
export interface ChainTipIndices {
  /** `zswapLedgerEvents.maxId` — what the shielded wallet stores as `offset`. */
  shielded: bigint;
  /**
   * `UnshieldedTransactionsProgress.highestTransactionId` — what the unshielded
   * wallet stores as `appliedId`.
   */
  unshielded: bigint;
  /** `dustLedgerEvents.maxId` — what the DUST wallet stores as `offset`. */
  dust: bigint;
}

export interface ChainTipRequest {
  indexerHttpUrl: string;
  indexerWsUrl: string;
  /** Bech32m `mn_addr…`, exactly as the unshielded wallet's own sync passes it. */
  unshieldedAddress: string;
  /** Upper bound on the whole three-stream read. Default 20 s. */
  timeoutMs?: number;
}

const CHAIN_TIP_TIMEOUT_MS = 20_000;

/**
 * The subscription documents below are the SDK's own, trimmed to the progress
 * fields — `wallet-sdk-indexer-client/dist/graphql/subscriptions/{ZswapEvents,
 * DustLedgerEvents,UnshieldedTransactions}.js`. The `raw` event payloads are
 * deliberately not selected: this asks the indexer where the chain ends, it
 * does not download the chain.
 */
const ZSWAP_TIP_DOCUMENT = `
  subscription ZswapEvents($id: Int) {
    zswapLedgerEvents(id: $id) {
      id
      maxId
    }
  }
`;

const DUST_TIP_DOCUMENT = `
  subscription DustLedgerEvents($id: Int) {
    dustLedgerEvents(id: $id) {
      id
      maxId
    }
  }
`;

const UNSHIELDED_TIP_DOCUMENT = `
  subscription UnshieldedTransactions($address: UnshieldedAddress!, $transactionId: Int) {
    unshieldedTransactions(address: $address, transactionId: $transactionId) {
      ... on UnshieldedTransactionsProgress {
        type: __typename
        highestTransactionId
      }
      ... on UnshieldedTransaction {
        type: __typename
        transaction {
          id
        }
      }
    }
  }
`;

/** A tip read that could not be completed. Callers must fall back, not guess. */
export class ChainTipUnavailableError extends Error {
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'ChainTipUnavailableError';
    if (detail !== undefined) this.detail = detail;
  }
}

function firstBigInt(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

/**
 * Opens one GraphQL-over-WebSocket connection, runs the three subscriptions on
 * it, keeps the first message from each that carries a tip, and disposes. The
 * client is the same `graphql-ws` one the SDK's own `WsSubscriptionClient`
 * builds; this module only borrows it because the SDK exposes no "where does
 * the chain end" query.
 */
export async function fetchChainTipIndices(
  request: ChainTipRequest,
): Promise<ChainTipIndices> {
  const { createClient } = await import('graphql-ws');
  const timeoutMs = request.timeoutMs ?? CHAIN_TIP_TIMEOUT_MS;
  const client = createClient({
    url: request.indexerWsUrl,
    shouldRetry: () => false,
    keepAlive: 15_000,
  });

  const firstMatching = <T>(
    document: string,
    variables: Record<string, unknown>,
    extract: (payload: unknown) => T | null,
    label: string,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          dispose();
        } catch {
          // A subscription that is already gone needs no disposal.
        }
        fn();
      };
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new ChainTipUnavailableError(
                `The indexer did not report the ${label} tip within ${Math.round(timeoutMs / 1000)}s.`,
              ),
            ),
          ),
        timeoutMs,
      );
      const dispose = client.subscribe(
        { query: document, variables },
        {
          next: (message: { data?: unknown; errors?: readonly { message: string }[] }) => {
            if (message.errors?.length) {
              finish(() =>
                reject(
                  new ChainTipUnavailableError(
                    `The indexer refused the ${label} tip subscription.`,
                    message.errors?.[0]?.message,
                  ),
                ),
              );
              return;
            }
            const found = extract(message.data);
            // A message that carries no tip (an ordinary transaction on the
            // unshielded stream) is simply not the one we are waiting for.
            if (found !== null) finish(() => resolve(found));
          },
          error: (cause: unknown) =>
            finish(() =>
              reject(
                new ChainTipUnavailableError(
                  `The ${label} tip subscription failed.`,
                  cause instanceof Error ? cause.message : String(cause),
                ),
              ),
            ),
          complete: () =>
            finish(() =>
              reject(
                new ChainTipUnavailableError(
                  `The indexer closed the ${label} tip subscription before reporting one.`,
                ),
              ),
            ),
        },
      );
    });

  try {
    const [shielded, dust, unshielded] = await Promise.all([
      firstMatching(
        ZSWAP_TIP_DOCUMENT,
        { id: 0 },
        (data) =>
          firstBigInt((data as { zswapLedgerEvents?: { maxId?: unknown } })?.zswapLedgerEvents?.maxId),
        'shielded',
      ),
      firstMatching(
        DUST_TIP_DOCUMENT,
        { id: 0 },
        (data) =>
          firstBigInt((data as { dustLedgerEvents?: { maxId?: unknown } })?.dustLedgerEvents?.maxId),
        'DUST',
      ),
      firstMatching(
        UNSHIELDED_TIP_DOCUMENT,
        { address: request.unshieldedAddress, transactionId: 0 },
        (data) =>
          firstBigInt(
            (data as { unshieldedTransactions?: { highestTransactionId?: unknown } })
              ?.unshieldedTransactions?.highestTransactionId,
          ),
        'unshielded',
      ),
    ]);
    return { shielded, unshielded, dust };
  } finally {
    try {
      client.dispose();
    } catch {
      // Disposing an already-closed client is not an error worth reporting.
    }
  }
}

/**
 * The chain's current block height, straight from the indexer's `block` query
 * (the same one `wallet-sdk-indexer-client`'s `BlockHash` uses). Returns `null`
 * rather than throwing when the indexer cannot be reached — the depth guard
 * treats "unknown depth" as "do not claim it is shallow".
 */
export async function fetchChainHeight(
  indexerHttpUrl: string,
  timeoutMs = 10_000,
): Promise<bigint | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(indexerHttpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query BlockHeight { block { height } }' }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { block?: { height?: unknown } } };
    return firstBigInt(body?.data?.block?.height);
  } catch (cause) {
    console.debug('[walletSnapshot] unable to read the chain height', cause);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The three component wallets, named as the SDK names them. */
export type WalletComponent = 'shielded' | 'unshielded' | 'dust';

/** The progress field each component stores its position in. */
const OFFSET_FIELD: Record<WalletComponent, 'offset' | 'appliedId'> = {
  shielded: 'offset',
  unshielded: 'appliedId',
  dust: 'offset',
};

/** Refusal to retarget a state. The caller must fall back honestly. */
export class NotEmptyAtCreationError extends Error {
  readonly component: WalletComponent;

  constructor(component: WalletComponent, reason: string) {
    super(
      `The ${component} state cannot start at the chain tip: ${reason}. Only a wallet with no chain history may skip the walk.`,
    );
    this.name = 'NotEmptyAtCreationError';
    this.component = component;
  }
}

/**
 * Reads the offset a serialised state currently sits at, or `null` when the
 * field is absent (which the SDK's own deserialisers read as zero).
 */
function currentOffset(component: WalletComponent, snapshot: Record<string, unknown>): bigint | null {
  return firstBigInt(snapshot[OFFSET_FIELD[component]]);
}

/**
 * Proves, from the serialised state alone, that this wallet has never been on
 * chain. Throws {@link NotEmptyAtCreationError} otherwise.
 *
 * This is the whole safety argument for tip bootstrap, so it is deliberately
 * strict and structural rather than trusting the caller's word that a wallet is
 * new. Anything unrecognised is treated as history, not as absence of it.
 */
function assertEmptyAtCreation(
  component: WalletComponent,
  snapshot: Record<string, unknown>,
): void {
  const offset = currentOffset(component, snapshot);
  if (offset !== null && offset !== 0n) {
    throw new NotEmptyAtCreationError(component, `it has already walked to index ${offset}`);
  }
  if (typeof snapshot.networkId !== 'string' || snapshot.protocolVersion === undefined) {
    throw new NotEmptyAtCreationError(component, 'its serialised shape is not the one this build knows');
  }
  if (component === 'shielded') {
    const coinHashes = snapshot.coinHashes;
    if (coinHashes === undefined || coinHashes === null || typeof coinHashes !== 'object') {
      throw new NotEmptyAtCreationError(component, 'it carries no coinHashes record to check');
    }
    if (Object.keys(coinHashes as Record<string, unknown>).length > 0) {
      throw new NotEmptyAtCreationError(component, 'it already knows about shielded coins');
    }
    if (typeof snapshot.state !== 'string') {
      throw new NotEmptyAtCreationError(component, 'its ZswapLocalState is not the expected hex string');
    }
  }
  if (component === 'unshielded') {
    const state = snapshot.state as { availableUtxos?: unknown; pendingUtxos?: unknown } | undefined;
    if (!state || !Array.isArray(state.availableUtxos) || !Array.isArray(state.pendingUtxos)) {
      throw new NotEmptyAtCreationError(component, 'its UTxO arrays are not the expected shape');
    }
    if (state.availableUtxos.length > 0 || state.pendingUtxos.length > 0) {
      throw new NotEmptyAtCreationError(component, 'it already holds UTxOs');
    }
  }
  if (component === 'dust' && typeof snapshot.state !== 'string') {
    throw new NotEmptyAtCreationError(component, 'its DustLocalState is not the expected hex string');
  }
}

/**
 * Returns `serialized` with ONLY its `offset` (shielded, DUST) or `appliedId`
 * (unshielded) field moved to `tipIndex`. Every other byte — keys, state hex,
 * protocol version, network id — is the SDK's own output, untouched.
 *
 * The value is written as a decimal string because that is how effect's
 * `Schema.BigInt` encodes these fields (see each component's
 * `v1/Serialization.js`); a JSON number would not survive `restore()`.
 *
 * Throws {@link NotEmptyAtCreationError} if the state shows any sign of having
 * been on chain, and a plain `Error` if it is not JSON at all.
 *
 * DO NOT WIRE THIS INTO THE WALLET. The state it produces is accepted by
 * `restore()` and then rejected by the ledger the moment a real event arrives;
 * see the tip-bootstrap section of this file's header for the measurements.
 */
export function retargetSerializedStateToTip(
  component: WalletComponent,
  serialized: string,
  tipIndex: bigint,
): string {
  if (tipIndex < 0n) throw new RangeError('A chain tip index cannot be negative.');
  let snapshot: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    snapshot = parsed as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `The ${component} wallet's serialised state could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  assertEmptyAtCreation(component, snapshot);
  return JSON.stringify({ ...snapshot, [OFFSET_FIELD[component]]: tipIndex.toString() });
}
