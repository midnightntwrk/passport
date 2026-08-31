/**
 * The balancer's Midnight wallet, run under plain Node against ledger-9.
 *
 * Structurally this is `examples/passport-funder/src/wallet.ts` — a facade, a
 * serialised sync snapshot on disk, a one-spend-at-a-time queue, and a DUST
 * registration at start-up. The API underneath is NOT the same, and the
 * differences are called out where they bite:
 *
 *   1. **The ledger is the hyphenless scope.** `@midnight-ntwrk/wallet-sdk`
 *      2.0.0-beta.2 binds to `@midnightntwrk/ledger-v9`, not
 *      `@midnight-ntwrk/ledger-v9`. Two different WASM modules; importing the
 *      hyphenated one here would hand the facade objects from a foreign
 *      instance. Everything below imports the scope the SDK itself imports.
 *   2. **There is no global network id.** `setNetworkId`/`getNetworkId` from
 *      `midnight-js-network-id` are gone. The network is a field on the wallet
 *      configuration and an argument to `createKeystore`.
 *   3. **The keystore takes a tagged secret.** `createKeystore({ kind, secret },
 *      networkId)` — `kind` names the signature scheme, and the NightExternal
 *      role key is `schnorr` exactly as it was on ledger-8. (The HD wallet
 *      gained a separate `EcdsaUnshielded` role for the other scheme; role
 *      *numbers* are unchanged, so a seed derives the same address as before.)
 *   4. **Cost parameters are required**, not optional, on the dust wallet.
 *   5. **Proving can happen in this process.** The beta ships a WASM prover
 *      (`makeWasmProvingService`) whose default key-material provider fetches
 *      the four ledger-9 circuit keys over HTTPS and caches them in memory. A
 *      proof server is therefore an optimisation on stagenet, not a
 *      precondition — which matters, because stagenet publishes none.
 *   6. **Transaction history is an interface, not a stub.** The old
 *      `{ upsert, getAll, get, serialize }` shape is now
 *      `gotPending`/`gotFinalized`/`gotRejected`, and the SDK ships
 *      `NoOpTransactionHistoryStorage` for services that keep no history.
 *   7. **A DUST registration pays for itself out of the DUST it is about to
 *      generate**, so it has to wait for that projection to cover its own fee —
 *      `estimateRegistration` then `waitForGeneratedDust`. On ledger-8 the
 *      registration was submitted immediately.
 *
 * The seed is read once at start-up and never leaves this process.
 */

import { Buffer } from 'node:buffer';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import * as Rx from 'rxjs';

import * as ledger from '@midnightntwrk/ledger-v9';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { Zkir, type KeyMaterialProvider } from '@midnight-ntwrk/zkir-v2';
/* Everything else comes through the umbrella `@midnight-ntwrk/wallet-sdk`
   package, which is what this service actually depends on. The individual
   `wallet-sdk-*` packages are present only because the umbrella pulls them in,
   and reaching past it would leave this code importing packages nothing here
   declares — which is precisely how the `@midnight-ntwrk/ledger-v9` /
   `@midnightntwrk/ledger-v9` confusion arises in the first place. */
import { NoOpTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk';
import {
  makeServerProvingService,
  makeWasmProvingService,
} from '@midnight-ntwrk/wallet-sdk/capabilities/proving';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk/dust';
import {
  WalletFacade,
  type BalancingRecipe,
  type FacadeState,
  type UtxoWithMeta,
} from '@midnight-ntwrk/wallet-sdk/facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk/hd';
import { WasmProver } from '@midnight-ntwrk/wallet-sdk/prover-client/effect';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk/shielded';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk/unshielded';

import type { BalancerConfig } from './config.js';
import { createWalletReservation } from './reservation.js';

// The wallet SDK's indexer client needs a global WebSocket under plain Node.
(globalThis as { WebSocket?: unknown }).WebSocket ??= WebSocket;

export const NIGHT_DECIMALS = 6;

/** Formats atomic NIGHT for logs, on the same 6-decimal human scale the demo uses. */
export function formatNight(value: bigint): string {
  const scale = 10n ** BigInt(NIGHT_DECIMALS);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(NIGHT_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** Account 0, index 0 — the derivation the demo, the funder, and the prototype share. */
export function deriveRoleKeys(seedHex: string): Record<0 | 2 | 3, Uint8Array> {
  const wallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (wallet.type !== 'seedOk') throw new Error('The balancer seed was rejected by the HD wallet.');
  const derived = wallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  wallet.hdWallet.clear();
  if (derived.type !== 'keysDerived') {
    throw new Error('Key derivation from the balancer seed failed.');
  }
  return derived.keys;
}

/** The bech32m unshielded address a seed produces on a given network. */
export function unshieldedAddressFromSeed(seedHex: string, networkId: string): string {
  const keys = deriveRoleKeys(seedHex);
  const keystore = createKeystore(
    { kind: 'schnorr', secret: keys[Roles.NightExternal] },
    networkId,
  );
  return PublicKey.fromKeyStore(keystore).address;
}

interface StoredSnapshot {
  version: 1;
  networkId: string;
  unshieldedAddress: string;
  savedAt: string;
  shielded: string;
  unshielded: string;
  dust: string;
}

function snapshotPath(config: BalancerConfig): string {
  return join(config.stateDir, `sync-snapshot-${config.networkId}.json`);
}

async function loadSnapshot(
  config: BalancerConfig,
  address: string,
): Promise<StoredSnapshot | null> {
  try {
    const raw = await readFile(snapshotPath(config), 'utf8');
    const parsed = JSON.parse(raw) as StoredSnapshot;
    if (
      parsed.version !== 1 ||
      parsed.networkId !== config.networkId ||
      parsed.unshieldedAddress !== address
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * How far behind each wallet is, for `/status` and the sync log.
 *
 * `applied` versus `highestRelevant` is the pair that DECIDES `isSynced`: the
 * SDK's `isStrictlyComplete()` is `isConnected && applied === highestRelevant`,
 * where "relevant" means relevant to THIS wallet, not the chain tip. `highest`
 * is the tip the indexer reports and is carried only for an operator's sense of
 * scale — on the stagenet indexer (4.4.0-pre-alpha.16) it comes through as 0,
 * so it must never be mistaken for the sync verdict.
 */
export interface SyncSnapshotProgress {
  isSynced: boolean;
  shielded: WalletProgress;
  unshielded: WalletProgress;
  dust: WalletProgress;
}

export interface WalletProgress {
  applied: string;
  highestRelevant: string;
  highest: string;
  connected: boolean;
  complete: boolean;
}

/**
 * One spendable shielded coin, flattened to the three fields a Compact
 * `ShieldedCoinInfo` argument needs.
 *
 * Deliberately NOT the SDK's `AvailableCoin`: the asset grant's only interest in
 * the wallet's coin set is "which coin do I hand to `deposit_shielded`", and
 * keeping the SDK's shielded types out of `./account.ts` is what stops that
 * module from acquiring a second opinion about which ledger package is in play.
 * `nonce` and `type` are the ledger's own string forms — hex, `0x`-prefixed or
 * not, exactly as the wallet reports them.
 */
export interface ShieldedCoin {
  readonly nonce: string;
  readonly type: string;
  readonly value: bigint;
}

export interface BalanceOnlyResult {
  txHash: string;
  /** Lower-case hex, no `0x` prefix — what `sponsor.ts` normalises to. */
  txBytes: string;
  expiresAt: string;
}

/**
 * A refusal the HTTP layer can turn into the wire shape `sponsor.ts` parses:
 * `{ error, message }` with an optional `cause` and `retryAfterMs`.
 */
export class BalanceRefusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly cause?: string;
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: { cause?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'BalanceRefusal';
    this.status = status;
    this.code = code;
    if (extra.cause !== undefined) this.cause = extra.cause;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

/**
 * The circuits a Midnight transaction can need proofs for. The balancing leg
 * this service adds only ever spends DUST, so `midnight/dust/spend` is the one
 * that must work; the three Zswap circuits are warmed with it because they cost
 * seconds now and would cost a caller's first request otherwise.
 */
const PROVING_KEY_LOCATIONS = [
  'midnight/dust/spend',
  'midnight/zswap/spend',
  'midnight/zswap/output',
  'midnight/zswap/sign',
] as const;

export type ProvingReadiness =
  /** An external proof server is configured; its health is that server's business. */
  | { state: 'server'; url: string }
  | { state: 'warming' }
  | { state: 'ready'; warmedInMs: number; bytes: number }
  | { state: 'failed'; reason: string };

/**
 * The midnight-js v5 `WalletProvider` / `MidnightProvider` pair, backed by the
 * beta wallet SDK — what a contract deploy or circuit call balances, signs, and
 * submits through.
 *
 * This is the join `deploy-stagenet` proved on chain: midnight-js hands out an
 * `UnboundTransaction` and expects a `FinalizedTransaction` back, which is
 * exactly `balanceUnboundTransaction` → `signRecipe` → `finalizeRecipe` on the
 * facade. Both sides speak `@midnightntwrk/ledger-v9` 1.0.0-rc.3, so the
 * objects cross the boundary unconverted.
 */
export interface ContractWalletProvider {
  getCoinPublicKey(): unknown;
  getEncryptionPublicKey(): unknown;
  balanceTx(tx: unknown, ttl?: Date): Promise<unknown>;
  submitTx(tx: unknown): Promise<string>;
}

export interface BalancerWallet {
  readonly address: string;
  /** `'server'` when an external prover is configured, `'wasm'` when in-process. */
  readonly provingMode: 'server' | 'wasm';
  /**
   * Whether this service can prove a DUST fee leg. In WASM mode that is not a
   * given — the circuit keys come over the network — so it is established at
   * start-up rather than discovered inside somebody's first request.
   */
  provingReadiness(): ProvingReadiness;
  /** Fetches and caches the proving key material. Safe to call more than once. */
  warmProvingKeys(): Promise<ProvingReadiness>;
  currentState(): Promise<FacadeState>;
  waitForSync(onTick?: (progress: SyncSnapshotProgress) => void): Promise<void>;
  progress(state?: FacadeState): Promise<SyncSnapshotProgress>;
  /** Atomic NIGHT held right now. */
  nightBalance(state?: FacadeState): Promise<bigint>;
  /** Spendable DUST (Specks) right now. */
  dustBalance(state?: FacadeState): Promise<bigint>;
  /**
   * This wallet's own shielded balance of one raw token type — the colour a
   * minted mUSD coin carries, not NIGHT.
   */
  shieldedBalance(tokenType: string, state?: FacadeState): Promise<bigint>;
  /**
   * The spendable shielded coins this wallet holds of one colour.
   *
   * Read from the wallet's own coin set rather than assumed from what a mint
   * was called with: a coin is only spendable once the wallet has really seen
   * it, and that is the thing the asset grant has to wait for.
   */
  availableShieldedCoins(tokenType: string, state?: FacadeState): Promise<ShieldedCoin[]>;
  /**
   * The 32 bytes a Compact `CoinPublicKey` argument takes for THIS wallet — the
   * recipient a mint pays to when the balancer is minting to itself.
   */
  shieldedCoinPublicKeyBytes(): Promise<Uint8Array>;
  /** How many DUST UTxOs back that balance — `/wallet-status` reports it. */
  dustUtxoCount(state?: FacadeState): Promise<number>;
  /**
   * Registers every unregistered NIGHT UTxO for DUST generation, so the
   * balancer has DUST to spend on other people's fees. Returns what happened.
   */
  registerDustIfNeeded(): Promise<
    'registered' | 'already-generating' | 'no-night' | 'waiting-for-dust'
  >;
  /**
   * The whole point of the service: take somebody else's finalized transaction,
   * add a DUST fee leg paid from this wallet, prove that leg, and hand the
   * merged transaction back. Nothing is submitted here — the caller's own
   * wallet submits, which is what the demo's balancing path in
   * `examples/passport-demo/src/identity/contractRuntime.ts` expects.
   */
  balanceOnly(transactionBytes: Uint8Array): Promise<BalanceOnlyResult>;
  /**
   * True while a CLAIM on this wallet's coin state is outstanding — a balancing,
   * a signature, a submission, or a revert. Deliberately NOT true while a job is
   * merely proving: see `./reservation.ts` for why the two are different
   * questions, and what conflating them cost.
   *
   * This is the signal `/wallet-status` publishes as `available`.
   */
  isReserved(): boolean;
  /**
   * True while any spend job holds the queue, proving included. For background
   * housekeeping that has no reason to run mid-grant — the DUST registration —
   * rather than for a caller's "can you pay a fee?".
   */
  isBusy(): boolean;
  /**
   * Runs `task` as one spend job, queued behind every other spend job.
   *
   * `/balance-only` reserves DUST; a sponsored registration spends NIGHT and
   * DUST twice over. Serialising them keeps two grants arriving together from
   * racing the proof server, and keeps the order of what this wallet submits
   * predictable.
   *
   * It does NOT by itself claim the wallet's coins — the phases inside do, for
   * as long as they need them. That is why {@link contractWalletProvider} may
   * take a claim inside a job that already holds the queue without deadlocking.
   *
   * `priority` reorders only what is still WAITING — see {@link SpendPriority},
   * which is where the measurement behind the one non-default value lives.
   */
  exclusive<T>(task: () => Promise<T>, options?: { priority?: number }): Promise<T>;
  /**
   * The provider midnight-js balances, signs, and submits contract
   * transactions through. Built per job, because it snapshots the wallet's
   * shielded keys; calls made through it MUST be inside {@link exclusive}.
   */
  contractWalletProvider(): ContractWalletProvider;
  saveSnapshot(): Promise<void>;
  close(): Promise<void>;
}

export async function openBalancerWallet(config: BalancerConfig): Promise<BalancerWallet> {
  /* The wallet SDK takes its network as a field (point 2 above), but midnight-js
     5 does NOT: it keeps the id in module-level state and `getNetworkId` THROWS
     when it is unset — `Transaction.fromParts` and `parseCoinPublicKeyToHex`
     both call it, so every contract deploy and every circuit call goes through
     it. It is also the bech32m tag, so a mismatch here would silently produce
     addresses for another network. Set once, here, where the network is first
     known and before anything can use it. */
  setNetworkId(config.networkId);

  const keys = deriveRoleKeys(config.seedHex);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore: UnshieldedKeystore = createKeystore(
    { kind: 'schnorr', secret: keys[Roles.NightExternal] },
    config.networkId,
  );
  const publicKey = PublicKey.fromKeyStore(unshieldedKeystore);
  const address = publicKey.address;

  const configuration = {
    networkId: config.networkId,
    indexerClientConnection: {
      indexerHttpUrl: config.indexerHttpUrl,
      indexerWsUrl: config.indexerWsUrl,
    },
    relayURL: new URL(config.relayUrl),
    costParameters: { feeBlocksMargin: config.feeBlocksMargin },
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
    ...(config.provingServerUrl ? { provingServerUrl: new URL(config.provingServerUrl) } : {}),
  };

  /* Stagenet publishes no proof server, and the balancing DUST leg has to be
     proved by somebody. The beta SDK can do it here: the WASM prover pulls the
     four ledger-9 circuit keys (`zswap/spend`, `zswap/output`, `zswap/sign`,
     `dust/spend`) plus their BLS parameters and keeps them in memory. When
     BALANCER_PROVER_URL names a server — the 9.0.0-rc.5_experimental image,
     once it is hosted — that is used instead, because a server proves faster
     than a Node worker.

     The key-material provider is constructed HERE rather than left to
     `makeWasmProvingService()`'s default, because the cache lives in that
     object's closure: warming a provider the prover does not hold would warm
     nothing. */
  const provingServerUrl = config.provingServerUrl;
  const provingMode: 'server' | 'wasm' = provingServerUrl ? 'server' : 'wasm';
  /* Inert until something asks it for a key — it is just a cache and a `fetch`
     — so it costs nothing to build in server mode too, and building it
     unconditionally keeps the branch below to one decision. */
  const keyMaterialProvider: KeyMaterialProvider = WasmProver.makeDefaultKeyMaterialProvider();
  const provingService = provingServerUrl
    ? makeServerProvingService({ provingServerUrl: new URL(provingServerUrl) })
    : makeWasmProvingService({ keyMaterialProvider });

  const startFacade = async (snapshot: StoredSnapshot | null): Promise<WalletFacade> =>
    WalletFacade.init({
      configuration,
      provingService: () => provingService,
      shielded: (cfg) =>
        snapshot
          ? ShieldedWallet(cfg).restore(snapshot.shielded)
          : ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (cfg) =>
        snapshot
          ? UnshieldedWallet(cfg).restore(snapshot.unshielded)
          : UnshieldedWallet(cfg).startWithPublicKey(publicKey),
      dust: (cfg) =>
        snapshot
          ? DustWallet(cfg).restore(snapshot.dust)
          : DustWallet(cfg).startWithSecretKey(
              dustSecretKey,
              ledger.LedgerParameters.initialParameters().dust,
            ),
    });

  await mkdir(config.stateDir, { recursive: true });
  const cached = await loadSnapshot(config, address);
  let facade: WalletFacade;
  let resumed = false;
  if (cached) {
    try {
      facade = await startFacade(cached);
      resumed = true;
      console.log(`[wallet] resumed sync from the snapshot saved at ${cached.savedAt}`);
    } catch (cause) {
      console.warn('[wallet] stored sync snapshot rejected; cold-starting', cause);
      facade = await startFacade(null);
    }
  } else {
    facade = await startFacade(null);
  }
  if (!resumed) console.log('[wallet] cold start — walking the chain from genesis');

  await facade.start(shieldedSecretKeys, dustSecretKey);

  const nightTokenType = ledger.nativeToken().raw;
  let closed = false;

  const currentState = (): Promise<FacadeState> =>
    Rx.firstValueFrom(facade.state().pipe(Rx.timeout({ first: 30_000 })));

  const progressOf = (state: FacadeState): SyncSnapshotProgress => {
    const shielded = state.shielded.progress;
    const unshielded = state.unshielded.progress;
    const dust = state.dust.progress;
    return {
      isSynced: state.isSynced,
      shielded: {
        applied: shielded.appliedIndex.toString(),
        highestRelevant: shielded.highestRelevantWalletIndex.toString(),
        highest: shielded.highestIndex.toString(),
        connected: shielded.isConnected,
        complete: shielded.isStrictlyComplete(),
      },
      unshielded: {
        /* The unshielded wallet counts TRANSACTIONS relevant to its address
           rather than ledger indices, so it has no separate "relevant" figure —
           every id it knows about is one of its own. */
        applied: unshielded.appliedId.toString(),
        highestRelevant: unshielded.highestTransactionId.toString(),
        highest: unshielded.highestTransactionId.toString(),
        connected: unshielded.isConnected,
        complete: unshielded.isStrictlyComplete(),
      },
      dust: {
        applied: dust.appliedIndex.toString(),
        highestRelevant: dust.highestRelevantWalletIndex.toString(),
        highest: dust.highestIndex.toString(),
        connected: dust.isConnected,
        complete: dust.isStrictlyComplete(),
      },
    };
  };

  /* Snapshot saves are serialised through this chain. Two of them can be asked
     for at once — the "first synced" subscription and `close()` land together
     on a short run — and concurrently they raced on one shared `.tmp` name:
     whichever renamed first left the other renaming a file that was no longer
     there (ENOENT, observed on the very first stagenet run). Serialising also
     means a save never reads a half-serialised wallet state. */
  let saveQueue: Promise<void> = Promise.resolve();

  const writeSnapshot = async (): Promise<void> => {
    if (closed) return;
    try {
      const [shielded, unshielded, dust] = await Promise.all([
        facade.shielded.serializeState(),
        facade.unshielded.serializeState(),
        facade.dust.serializeState(),
      ]);
      const snapshot: StoredSnapshot = {
        version: 1,
        networkId: config.networkId,
        unshieldedAddress: address,
        savedAt: new Date().toISOString(),
        shielded,
        unshielded,
        dust,
      };
      const path = snapshotPath(config);
      const temp = `${path}.tmp`;
      await writeFile(temp, JSON.stringify(snapshot), 'utf8');
      await rename(temp, path);
    } catch (cause) {
      // Losing the cache costs a longer sync next time and nothing else.
      console.warn('[wallet] unable to save the sync snapshot', cause);
    }
  };

  const saveSnapshot = (): Promise<void> => {
    const next = saveQueue.then(writeSnapshot, writeSnapshot);
    saveQueue = next.catch(() => undefined);
    return next;
  };

  // Refresh the snapshot every minute while synced, so a killed process resumes
  // from close to the tip rather than replaying 150k blocks.
  let sawSynced = false;
  const snapshotTimer = setInterval(() => {
    if (sawSynced) void saveSnapshot();
  }, 60_000);
  snapshotTimer.unref();
  const snapshotSubscription = facade.state().subscribe({
    next: (state) => {
      if (state.isSynced && !sawSynced) {
        sawSynced = true;
        void saveSnapshot();
      } else if (!state.isSynced) {
        sawSynced = false;
      }
    },
    error: () => undefined,
  });

  /* Who holds this wallet, and for which PHASE — see `./reservation.ts`.
     Balancing, signing, submitting, and reverting CLAIM the wallet's coin
     state; proving claims nothing, because by the time a recipe reaches the
     prover the SDK has already committed its inputs as spent. The claim is what
     `/wallet-status` publishes as `available`; the queue is only a running
     order. Holding the two apart is the difference between a fee sponsor that
     is busy for a second and one that reads as absent for two minutes. */
  const reservation = createWalletReservation({
    onSlowClaim: (label, heldMs) =>
      console.log(
        `[claim] ${label} held this wallet for ${(heldMs / 1_000).toFixed(1)} s — /wallet-status answered available: 0 for that long`,
      ),
  });
  const { exclusive, reserve } = reservation;

  const dustBalance = async (state?: FacadeState): Promise<bigint> =>
    (state ?? (await currentState())).dust.balance(new Date());

  /** Every NIGHT UTxO this wallet holds that is not yet generating DUST. */
  const unregisteredNightUtxos = (state: FacadeState): UtxoWithMeta[] =>
    (state.unshielded.availableCoins ?? []).filter(
      (coin) =>
        coin.utxo.type === nightTokenType && coin.meta.registeredForDustGeneration === false,
    ) as UtxoWithMeta[];

  let provingReadiness: ProvingReadiness = provingServerUrl
    ? { state: 'server', url: provingServerUrl }
    : { state: 'warming' };
  let warmInFlight: Promise<ProvingReadiness> | null = null;

  const warmProvingKeys = (): Promise<ProvingReadiness> => {
    /* Nothing to warm when an external prover holds the keys, and nothing to
       redo once they are in memory. */
    if (provingMode === 'server' || provingReadiness.state === 'ready') {
      return Promise.resolve(provingReadiness);
    }
    if (warmInFlight) return warmInFlight;
    const startedAt = Date.now();
    warmInFlight = (async () => {
      try {
        let bytes = 0;
        const ks = new Set<number>();
        for (const location of PROVING_KEY_LOCATIONS) {
          const material = await keyMaterialProvider.lookupKey(location);
          if (!material) throw new Error(`no key material published for ${location}`);
          bytes += material.proverKey.length + material.verifierKey.length + material.ir.length;
          /* The IR names the circuit's size, and the BLS parameters are fetched
             per size. Reading it here means the parameters are cached too, so a
             first `/balance-only` is not also a multi-megabyte download. */
          ks.add(Zkir.deserialize(material.ir).getK());
        }
        for (const k of ks) {
          bytes += (await keyMaterialProvider.getParams(k)).length;
        }
        provingReadiness = { state: 'ready', warmedInMs: Date.now() - startedAt, bytes };
      } catch (cause) {
        provingReadiness = {
          state: 'failed',
          reason: cause instanceof Error ? cause.message : String(cause),
        };
      } finally {
        warmInFlight = null;
      }
      return provingReadiness;
    })();
    return warmInFlight;
  };

  return {
    address,
    provingMode,

    provingReadiness: () => provingReadiness,
    warmProvingKeys,

    currentState,

    async progress(state?: FacadeState): Promise<SyncSnapshotProgress> {
      return progressOf(state ?? (await currentState()));
    },

    async waitForSync(onTick?: (progress: SyncSnapshotProgress) => void): Promise<void> {
      const ticker = onTick
        ? setInterval(() => {
            void currentState()
              .then((state) => onTick(progressOf(state)))
              .catch(() => undefined);
          }, 5_000)
        : null;
      try {
        await Rx.firstValueFrom(facade.state().pipe(Rx.filter((state) => state.isSynced)));
      } finally {
        if (ticker) clearInterval(ticker);
      }
    },

    async nightBalance(state?: FacadeState): Promise<bigint> {
      const current = state ?? (await currentState());
      return current.unshielded.balances[nightTokenType] ?? 0n;
    },

    dustBalance,

    async dustUtxoCount(state?: FacadeState): Promise<number> {
      const current = state ?? (await currentState());
      return current.dust.availableCoins.length;
    },

    async shieldedBalance(tokenType: string, state?: FacadeState): Promise<bigint> {
      const current = state ?? (await currentState());
      return current.shielded.balances[tokenType] ?? 0n;
    },

    async availableShieldedCoins(tokenType: string, state?: FacadeState): Promise<ShieldedCoin[]> {
      const current = state ?? (await currentState());
      return current.shielded.availableCoins
        .filter((entry) => String(entry.coin.type) === tokenType)
        .map((entry) => ({
          nonce: String(entry.coin.nonce),
          type: String(entry.coin.type),
          value: entry.coin.value,
        }));
    },

    async shieldedCoinPublicKeyBytes(): Promise<Uint8Array> {
      /* Taken from the wallet's own address rather than from
         `shieldedSecretKeys.coinPublicKey`, which is the ledger's string form:
         the circuit argument is 32 raw bytes, and the address object is where
         those bytes already are. This is the same read the shielded-receipt
         drill minted against. */
      const shieldedAddress = await facade.shielded.getAddress();
      return new Uint8Array(shieldedAddress.coinPublicKey.data);
    },

    async registerDustIfNeeded(): Promise<
      'registered' | 'already-generating' | 'no-night' | 'waiting-for-dust'
    > {
      const state = await currentState();
      const unregistered = unregisteredNightUtxos(state);
      if (unregistered.length === 0) {
        if ((state.unshielded.balances[nightTokenType] ?? 0n) === 0n) return 'no-night';
        return 'already-generating';
      }

      /* ledger-9 makes the registration pay its own fee out of the DUST the
         registered UTxOs are ALREADY projected to have generated — there is no
         other DUST on a fresh wallet to pay it with. So the fee has to be
         estimated first, and the transaction cannot be built until the
         projection covers it. On a freshly fauceted wallet that is a wait of
         minutes, not a failure, so it gets its own return value. */
      const { fee } = await facade.estimateRegistration(unregistered);
      try {
        await facade.waitForGeneratedDust(unregistered, fee, { timeoutMs: 60_000 });
      } catch {
        console.log(
          `[dust] the registration fee is ${fee} Specks and the registered NIGHT has not generated that much yet — will retry`,
        );
        return 'waiting-for-dust';
      }

      const recipe = await facade.registerNightUtxosForDustGeneration(
        unregistered,
        unshieldedKeystore.getPublicKey(),
        unshieldedKeystore.signDataAsync,
      );
      const finalized = await facade.finalizeRecipe(recipe);
      await facade.submitTransaction(finalized);
      console.log(
        `[dust] registered ${unregistered.length} NIGHT UTxO(s) for DUST generation (tx ${String(finalized.transactionHash())})`,
      );
      return 'registered';
    },

    isReserved: reservation.isReserved,
    isBusy: reservation.isBusy,

    exclusive,

    contractWalletProvider(): ContractWalletProvider {
      return {
        getCoinPublicKey: () => shieldedSecretKeys.coinPublicKey,
        getEncryptionPublicKey: () => shieldedSecretKeys.encryptionPublicKey,

        async balanceTx(tx: unknown, ttl?: Date): Promise<unknown> {
          const deadline = ttl ?? new Date(Date.now() + config.balanceTtlMs);

          /* Under ledger-9 the fee is DUST, and DUST accrues per block. A wallet
             a few Specks short is not broken, it is early — so the fee is
             estimated first and the estimate is retried rather than turned into
             a failed registration. `deploy-stagenet` needed exactly this to get
             its TLD on chain. */
          const budgetMs = 600_000;
          const startedAt = Date.now();
          for (;;) {
            try {
              await facade.estimateTransactionFee(tx as never, dustSecretKey, { ttl: deadline });
              break;
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause);
              if (
                !/insufficient funds|could not balance dust/i.test(message) ||
                Date.now() - startedAt > budgetMs
              ) {
                throw cause;
              }
              console.log(`[contract] waiting for DUST (${message.slice(0, 80)})`);
              await new Promise((settle) => setTimeout(settle, 10_000));
            }
          }

          let recipe: BalancingRecipe | null = null;
          try {
            /* `facade.validateTransaction` is NOT called here, and must not be.
               The beta SDK's validation service builds a BLANK ledger state
               (`LedgerState.blank(networkId)` with only the real parameters) and
               runs `wellFormed` against it, so any transaction that CALLS a
               deployed contract fails with
               `call to non-existant contract ContractAddress(…)` — measured on
               stagenet against a TLD that demonstrably existed, at block 157797.
               The check is sound for a self-contained transfer and structurally
               impossible for a contract call. */
            const balanced = await reserve(() =>
              facade.balanceUnboundTransaction(
                tx as never,
                { shieldedSecretKeys, dustSecretKey },
                { ttl: deadline },
              ),
              'contract balancing',
            );
            recipe = balanced;
            const signed = await reserve(
              () => facade.signRecipe(balanced, unshieldedKeystore.signDataAsync),
              'contract signing',
            );
            recipe = signed;
            /* Proving, and NOT under a claim. This is the long half of an mUSD
               grant — minutes, for a transaction carrying shielded legs — and it
               reads no wallet state: the coins it will spend were committed as
               spent by the balancing above, so a `/balance-only` arriving now
               selects different ones. Holding the claim through it is what made
               `/wallet-status` answer `available: 0` while a grant proved. */
            return await facade.finalizeRecipe(signed);
          } catch (cause) {
            const toRevert = recipe;
            if (toRevert) {
              try {
                await reserve(() => facade.revert(toRevert));
              } catch {
                // Reserved coins are released on restart anyway.
              }
            }
            throw cause;
          }
        },

        async submitTx(tx: unknown): Promise<string> {
          /* `facade.submitTransaction` is two steps welded together: it books
             the transaction as pending in this wallet's own state, and then it
             calls the submission service with `waitForStatus: 'Finalized'` —
             which does not return until the node has FINALISED the transaction.
             On stagenet that is 15 to 25 seconds, measured 2026/08/26, and only
             the first step touches the wallet.
             So the two are taken apart here, with the facade's own error path
             (revert the transaction if submission fails) preserved. Holding a
             claim across the finalisation wait refused every fee request for its
             duration, and refused it for a wallet that was doing nothing but
             waiting on somebody else's block. */
          const finalized = tx as ledger.FinalizedTransaction;
          await reserve(
            () => facade.pendingTransactionsService.addPendingTransaction(finalized),
            'contract submission booking',
          );
          try {
            await facade.submissionService.submitTransaction(finalized, 'Finalized');
          } catch (cause) {
            try {
              await reserve(() => facade.revert(finalized));
            } catch {
              // Best effort — the original submission failure is the real news.
            }
            throw cause;
          }
          return String(finalized.identifiers().at(-1));
        },
      };
    },

    async balanceOnly(transactionBytes: Uint8Array): Promise<BalanceOnlyResult> {
      if (closed) {
        throw new BalanceRefusal(503, 'WALLETS_UNAVAILABLE', 'The balancer wallet is closed.');
      }
      /* A claim on the wallet's coin state is outstanding — somebody is
         selecting, signing, or submitting coins this instant. That is seconds,
         not minutes, and `sponsor.ts` retries a 429 PENDING_TRANSACTION inside a
         20-second window, so coming back shortly is the right answer. A job that
         is merely PROVING is not a reason to refuse: it holds nothing. */
      if (reservation.isReserved()) {
        throw new BalanceRefusal(
          429,
          'PENDING_TRANSACTION',
          'This balancer wallet already has a transaction pending. Try again shortly.',
          { retryAfterMs: 2_000 },
        );
      }

      /* Deserialise BEFORE claiming the queue: a malformed body is the caller's
         mistake and must not lock anybody else out. The three markers say what
         kind of transaction is on the wire — a FINALIZED one, which is what a
         caller sends after it has signed and proved locally. */
      let incoming: ledger.FinalizedTransaction;
      try {
        incoming = ledger.Transaction.deserialize<
          ledger.SignatureEnabled,
          ledger.Proof,
          ledger.Binding
        >('signature', 'proof', 'binding', transactionBytes);
      } catch (cause) {
        throw new BalanceRefusal(
          400,
          'INVALID_TRANSACTION',
          'The request body is not a serialised finalized Midnight transaction.',
          { cause: cause instanceof Error ? cause.message : String(cause) },
        );
      }

      const state = await currentState();
      if (!state.isSynced) {
        throw new BalanceRefusal(
          503,
          'WALLET_SYNCING',
          'The balancer wallet is still syncing and cannot balance a transaction yet.',
        );
      }
      if ((await dustBalance(state)) <= 0n) {
        throw new BalanceRefusal(
          503,
          'INSUFFICIENT_DUST',
          'The balancer holds no spendable DUST, so it cannot pay this transaction’s fee.',
        );
      }

      /* Resolves instantly once warm, and a start-up preflight has normally
         warmed it already; this is the belt-and-braces path for a service whose
         first request beats its own preflight. */
      const proving = await warmProvingKeys();
      if (proving.state === 'failed') {
        throw new BalanceRefusal(
          503,
          'PROVER_UNAVAILABLE',
          'The balancer cannot prove a DUST fee leg: its proving key material could not be loaded.',
          { cause: proving.reason },
        );
      }

      const ttl = new Date(Date.now() + config.balanceTtlMs);
      let recipe: BalancingRecipe | null = null;
      try {
        /* `facade.validateTransaction` is deliberately NOT run on the incoming
           transaction — the same finding the registration path records above:
           the beta SDK validates against a BLANK ledger state, so any
           transaction that CALLS a deployed contract fails with `call to
           non-existant contract`. Transfers and deploys passed it, which is why
           this only surfaced on the first account withdrawal from the live app
           (2026/08/25: withdraw_night, refused as BALANCE_FAILED). The ledger's
           own deserialisation above is the structural guard; the node is the
           judge of validity, and it rejects what it rejects with a real reason. */

        /* DUST and nothing else. The caller balanced its own shielded and
           unshielded legs before it asked (`BALANCE_WITHOUT_DUST` in
           `sponsor.ts`); adding to those here would spend the balancer's NIGHT
           on somebody else's transfer. */
        const reserved = await reserve(
          () =>
            facade.balanceFinalizedTransaction(
              incoming,
              { shieldedSecretKeys, dustSecretKey },
              { ttl, tokenKindsToBalance: ['dust'] },
            ),
          'fee-leg balancing',
        );
        recipe = reserved;

        /* A DUST-only balancing leg has no signable segment, so this signs
           nothing today. It stays in the pipeline because it is the step that
           would sign one if a future balancing leg ever carried an unshielded
           input, and a silently missing signature is a node rejection with no
           useful error. */
        const signed = await reserve(
          () => facade.signRecipe(reserved, unshieldedKeystore.signDataAsync),
          'fee-leg signing',
        );
        recipe = signed;

        /* Proving happens here — the WASM prover or the configured server —
           and outside the claim, for the reason `./reservation.ts` gives: the
           DUST this leg spends is already booked as spent, so another caller's
           balancing in this window picks a different coin. */
        const balanced = await facade.finalizeRecipe(signed);

        /* `finalizeRecipe` books the merged transaction as pending so the
           wallet does not double-spend its DUST while it is in flight. The
           balancer never submits it, though: the caller does. Clearing the
           booking is the caller's submit reaching the chain, or this wallet
           re-syncing; neither is ours to wait for. */
        return {
          txHash: String(balanced.transactionHash()),
          txBytes: Buffer.from(balanced.serialize()).toString('hex'),
          expiresAt: ttl.toISOString(),
        };
      } catch (cause) {
        const toRevert = recipe;
        if (toRevert) {
          try {
            await reserve(() => facade.revert(toRevert));
          } catch {
            // Best effort — reserved coins are released on restart anyway.
          }
        }
        if (cause instanceof BalanceRefusal) throw cause;
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new BalanceRefusal(
          502,
          'BALANCE_FAILED',
          'The balancer could not add a fee leg to this transaction.',
          { cause: message },
        );
      }
    },

    saveSnapshot,

    async close(): Promise<void> {
      if (closed) return;
      clearInterval(snapshotTimer);
      snapshotSubscription.unsubscribe();
      await saveSnapshot();
      closed = true;
      await facade.stop();
    },
  };
}
