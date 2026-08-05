/**
 * Passkey-derived, in-browser Midnight wallet.
 *
 * This is a straight port of the working account-custody prototype path
 * (`experiments/account-custody-prototype/app/src/lib/providers.ts`,
 * `deriveKeys` + `createWallet`) into the Passport demo, with three deliberate
 * differences:
 *
 *   1. The seed comes from the Passport passkey's WebAuthn PRF output, not from
 *      a hard-coded genesis seed. There is no `GENESIS_SEED` here and there
 *      never should be — this module must be safe to point at Preview.
 *   2. Every network endpoint is configurable through `import.meta.env`, with
 *      Preview as the default rather than a localnet.
 *   3. The returned handle reports the same surfaces the Dynamic path reports
 *      (see `LocalWalletSurfaces` versus `DynamicSurfaceState` in
 *      `src/dynamic.ts`), so the Home screen can be fed from either source.
 *
 * Proving defaults to an HTTP proof server. The prototype's `?prover=browser`
 * in-tab zkir-v2 path is now ported as well (see `./wasmProver.ts`): it needs a
 * staged `/zk-params` asset tree, produced by `scripts/fetch-zk-params.mjs`.
 * When those assets are absent the browser prover fails loudly — it never
 * quietly falls back to the remote proof server, because a demo must not claim
 * local proving it did not do.
 *
 * Sync state is cached (see `./walletSnapshot.ts`) so a second session resumes
 * the chain walk from the last applied index instead of replaying it from zero.
 * A snapshot the SDK refuses is discarded and the wallet cold-starts;
 * `resumedFromSnapshot` reports which of the two actually happened.
 */

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  mainnet,
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import type { BalancingRecipe } from '@midnight-ntwrk/wallet-sdk-facade';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  PublicKey,
  type UnshieldedKeystore,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import * as Rx from 'rxjs';

import type { PassportStateScope, PassportWalletSeedProvider } from '../backend.js';
import { wasmWalletProvingService } from './wasmProver.js';
import {
  clearWalletSnapshots,
  deleteWalletSnapshot,
  loadWalletSnapshot,
  saveWalletSnapshot,
  WALLET_SNAPSHOT_VERSION,
  type WalletSnapshot,
} from './walletSnapshot.js';

/**
 * Re-exported so a "Reset local sync cache" control can clear the smart-sync
 * cache without importing the storage module directly.
 */
export { clearWalletSnapshots };

// ---------------------------------------------------------------------------
// Network configuration
// ---------------------------------------------------------------------------

export interface LocalWalletNetworkConfig {
  /** Midnight network identifier, e.g. `preview`, `mainnet`, `undeployed`. */
  networkId: string;
  /** Indexer GraphQL endpoint over HTTP. */
  indexerHttpUrl: string;
  /** Indexer GraphQL endpoint over WebSocket (the HTTP URL plus `/ws`). */
  indexerWsUrl: string;
  /** Node relay WebSocket URL used for transaction submission. */
  relayUrl: string;
  /** Proof server base URL used to prove balancing transactions. */
  provingServerUrl: string;
}

const DEFAULT_INDEXER_HTTP_URL = 'https://indexer.preview.midnight.network/api/v4/graphql';
const DEFAULT_NODE_URL = 'https://rpc.preview.midnight.network';
const DEFAULT_PROVING_SERVER_URL = 'https://proof-server.preview.midnight.network';
const DEFAULT_NETWORK_ID = 'preview';

/**
 * The indexer's WebSocket endpoint is its HTTP endpoint with `/ws` appended —
 * the bare GraphQL path refuses the upgrade. Verified against Preview on
 * 2026/08/04; see the header comment in `./indexerTx.ts`.
 */
function indexerWsFrom(indexerHttpUrl: string): string {
  return `${indexerHttpUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws`;
}

/** The submission relay speaks WebSocket, so an `http(s)` node URL is upgraded. */
function relayFrom(nodeUrl: string): string {
  return nodeUrl.replace(/^http/, 'ws');
}

function environment(): Record<string, string | undefined> {
  return import.meta.env as unknown as Record<string, string | undefined>;
}

/**
 * Resolves the network the local wallet talks to. Everything is overridable so
 * the same build can be pointed at a localnet, and nothing is pinned to one.
 *
 *   VITE_MIDNIGHT_NETWORK_ID    default `preview`
 *   VITE_INDEXER_URL            default the Preview indexer (shared with indexerTx)
 *   VITE_INDEXER_WS_URL         default derived from VITE_INDEXER_URL
 *   VITE_MIDNIGHT_NODE_URL      default the Preview RPC node
 *   VITE_MIDNIGHT_RELAY_URL     default derived from VITE_MIDNIGHT_NODE_URL
 *   VITE_MIDNIGHT_PROVING_URL   default the Preview proof server
 */
export function localWalletNetworkConfig(
  overrides: Partial<LocalWalletNetworkConfig> = {},
): LocalWalletNetworkConfig {
  const env = environment();
  const indexerHttpUrl =
    overrides.indexerHttpUrl ?? env.VITE_INDEXER_URL ?? DEFAULT_INDEXER_HTTP_URL;
  const nodeUrl = env.VITE_MIDNIGHT_NODE_URL ?? DEFAULT_NODE_URL;
  return {
    networkId: overrides.networkId ?? env.VITE_MIDNIGHT_NETWORK_ID ?? DEFAULT_NETWORK_ID,
    indexerHttpUrl,
    indexerWsUrl:
      overrides.indexerWsUrl ?? env.VITE_INDEXER_WS_URL ?? indexerWsFrom(indexerHttpUrl),
    relayUrl: overrides.relayUrl ?? env.VITE_MIDNIGHT_RELAY_URL ?? relayFrom(nodeUrl),
    provingServerUrl:
      overrides.provingServerUrl ?? env.VITE_MIDNIGHT_PROVING_URL ?? DEFAULT_PROVING_SERVER_URL,
  };
}

// ---------------------------------------------------------------------------
// Surfaces — structurally identical to DynamicSurfaceState in src/dynamic.ts
// ---------------------------------------------------------------------------

export type LocalWalletAddressStatus = 'loading' | 'ready' | 'partial';
export type LocalWalletBalanceStatus = 'loading' | 'ready' | 'syncing' | 'unavailable';

/**
 * Mirrors `DynamicSurfaceState` field for field so the Home screen can be fed
 * from either the Dynamic wallet or this local one. Keep the two in step.
 */
export interface LocalWalletSurfaces {
  unshieldedAddress: string;
  shieldedAddress: string | null;
  dustAddress: string | null;
  unshieldedBalance: string | null;
  shieldedTokenCount: number | null;
  dustBalance: string | null;
  /**
   * Formatted DUST generation cap, on the same human scale as `dustBalance`.
   * `null` means "not reported" — never substitute a zero here, because a zero
   * cap reads as a real, empty allowance.
   */
  dustCap: string | null;
  dustSyncing: boolean;
  addressStatus: LocalWalletAddressStatus;
  balanceStatus: LocalWalletBalanceStatus;
  balanceError: string | null;
}

/** The subset `getBalances()` refreshes — mirrors `refreshDynamicBalances`. */
export type LocalWalletBalances = Pick<
  LocalWalletSurfaces,
  | 'unshieldedBalance'
  | 'shieldedTokenCount'
  | 'dustBalance'
  | 'dustCap'
  | 'dustSyncing'
  | 'balanceStatus'
  | 'balanceError'
>;

// NIGHT is quoted with 6 decimals and DUST in Specks with 15, matching the
// scales Dynamic's `getFormattedBalances()` reports.
const NIGHT_DECIMALS = 6;
const DUST_DECIMALS = 15;
const STATE_TIMEOUT_MS = 15_000;
/** Upper bound on a snapshot write, so `close()` is never held open by one. */
const SNAPSHOT_TIMEOUT_MS = 5_000;

function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

// ---------------------------------------------------------------------------
// Seed derivation
// ---------------------------------------------------------------------------

const WALLET_SEED_BYTES = 32;

/**
 * Obtains the 32-byte Midnight wallet seed from the Passport passkey.
 *
 * The bytes come from the WebAuthn PRF output run through HKDF with a wallet
 * specific salt and info, so they are cryptographically separated from the
 * private-state encryption key the same assertion produces. See
 * `demo-backend/src/passkey.ts`.
 *
 * The caller owns the returned bytes. Pass them straight to
 * {@link createLocalMidnightWallet} and zero them afterwards; do not persist
 * them and do not log them.
 */
export async function deriveWalletSeed(
  provider: PassportWalletSeedProvider,
  scope: PassportStateScope,
): Promise<Uint8Array> {
  const seed = await provider.deriveWalletSeed(scope);
  if (seed.length !== WALLET_SEED_BYTES) {
    throw new Error(
      `Passport returned ${seed.length} bytes of wallet seed material; ${WALLET_SEED_BYTES} are required.`,
    );
  }
  return seed;
}

// ---------------------------------------------------------------------------
// Key derivation and wallet construction
// ---------------------------------------------------------------------------

export interface LocalWalletKeys {
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

/**
 * Account 0, index 0 of the Midnight HD tree — the same derivation the custody
 * prototype uses, so a seed produces the same addresses in both codebases.
 */
function deriveRoleKeys(seed: Uint8Array): Record<0 | 2 | 3, Uint8Array> {
  const wallet = HDWallet.fromSeed(seed);
  if (wallet.type !== 'seedOk') {
    throw new Error('The Passport wallet seed was rejected by the Midnight HD wallet.');
  }
  const derived = wallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  wallet.hdWallet.clear();
  if (derived.type !== 'keysDerived') {
    throw new Error('Midnight key derivation from the Passport wallet seed failed.');
  }
  return derived.keys;
}

/**
 * Transaction history is not a demo surface, so history is dropped rather than
 * stored. The SDK only requires that the four methods exist.
 */
function noopTxHistoryStorage() {
  return {
    upsert: async () => undefined,
    getAll: async () => [],
    get: async () => undefined,
    serialize: async () => '',
  };
}

/**
 * Ported from the custody prototype: ledger-v8 8.0.3 can panic inside
 * `MerkleTree::collapse` while applying a Zswap offer. Swallowing it leaves the
 * chain state untouched for that offer rather than tearing the wallet down.
 * Applied once per page, and only ever additive to the prototype's behaviour.
 */
let zswapApplyGuardInstalled = false;
function installZswapApplyGuard(): void {
  if (zswapApplyGuardInstalled) return;
  zswapApplyGuardInstalled = true;
  const prototype = ledger.ZswapChainState.prototype as unknown as Record<string, unknown>;
  const original = prototype.tryApply as (...args: unknown[]) => unknown;
  if (typeof original !== 'function') return;
  prototype.tryApply = function tryApply(this: unknown, ...args: unknown[]) {
    try {
      return original.apply(this, args);
    } catch {
      return [this, new Map()];
    }
  };
}

export type LocalWalletProvingMode = 'browser' | 'http';

export interface CreateLocalMidnightWalletOptions {
  /** Per-call overrides on top of the `import.meta.env` configuration. */
  network?: Partial<LocalWalletNetworkConfig>;
  /** Fee headroom in blocks. Matches the custody prototype's default. */
  feeBlocksMargin?: number;
  /**
   * Explicit proving service, e.g. a bespoke in-tab prover. Overrides
   * {@link CreateLocalMidnightWalletOptions.provingMode} when given.
   */
  provingService?: (configuration: unknown) => unknown;
  /**
   * `browser` proves in-tab with the zkir-v2 wasm prover and contacts no proof
   * server; `http` proves against `network.provingServerUrl`. Defaults to
   * `browser` when `?prover=browser` is in the URL or `VITE_BROWSER_PROVER=1`,
   * otherwise `http`.
   */
  provingMode?: LocalWalletProvingMode;
  /**
   * `auto` (the default) resumes the chain walk from the cached sync snapshot
   * for this network and address when one exists. `never` always cold-starts —
   * useful for reproducing a first-run sync.
   */
  resume?: 'auto' | 'never';
}

// ---------------------------------------------------------------------------
// Sending unshielded NIGHT
// ---------------------------------------------------------------------------

export type SendNightErrorCode =
  | 'invalid-recipient'
  | 'wrong-network'
  | 'insufficient-night'
  | 'insufficient-dust'
  | 'proving-failed'
  | 'submit-rejected'
  | 'wallet-closed';

/**
 * A refused or failed NIGHT transfer. Every instance describes something that
 * really happened: nothing is thrown to stand in for an unknown outcome, and a
 * submitted transaction never throws.
 */
export class SendNightError extends Error {
  readonly code: SendNightErrorCode;
  /** The underlying SDK or node message, when there is one. */
  readonly detail?: string;

  constructor(code: SendNightErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'SendNightError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export interface SendNightParams {
  recipientAddress: string;
  /** atomic NIGHT units, > 0 */
  amount: bigint;
  ttlMinutes?: number;
}

export interface SendNightResult {
  txId: string;
  recipientAddress: string;
  amount: bigint;
  submittedAt: string;
}

export interface LocalMidnightWallet {
  readonly network: LocalWalletNetworkConfig;
  /** Bech32m `mn_addr…` unshielded address. */
  readonly unshieldedAddress: string;
  /** Bech32m `mn_shield-addr…` shielded address. */
  readonly shieldedAddress: string;
  /** Bech32m `mn_dust-addr…` DUST address. */
  readonly dustAddress: string;
  /** The live facade, for callers that need to build or submit transactions. */
  readonly facade: WalletFacade;
  /** Secret keys and keystore, for balancing and signing. */
  readonly keys: LocalWalletKeys;
  /** Where proofs are computed for this wallet. */
  readonly provingMode: LocalWalletProvingMode;
  /**
   * `true` only when this wallet was built from a cached sync snapshot that the
   * SDK accepted, so its chain walk resumed mid-chain. `false` after a cold
   * start, including when a cached snapshot was found but rejected.
   */
  readonly resumedFromSnapshot: boolean;
  /**
   * Persists the current sync state for the next session. Called automatically
   * on first sync, once a minute while synced, and during `close()`. Never
   * throws: a cache write is a convenience, not a correctness requirement.
   */
  saveSnapshot(): Promise<void>;
  /**
   * Submits a real unshielded NIGHT transfer on this wallet's network and
   * resolves with the node's transaction identifier. Throws
   * {@link SendNightError} for every refusal it can name; balancing and signing
   * failures surface the SDK's own error unchanged.
   */
  sendUnshieldedNight(params: SendNightParams): Promise<SendNightResult>;
  /** Refreshes the balance surfaces. Never throws — failures land in `balanceError`. */
  getBalances(): Promise<LocalWalletBalances>;
  /** Addresses plus a balance refresh, in the shape the Home screen consumes. */
  surfaces(): Promise<LocalWalletSurfaces>;
  /** Resolves once the facade reports a fully synced state. */
  waitForSync(): Promise<void>;
  /**
   * Streams live sync progress, throttled to at most ~2 updates per second.
   * Returns an unsubscribe function. The listener may fire once more with the
   * update in flight when unsubscribed.
   */
  subscribeSyncProgress(listener: (progress: LocalWalletSyncProgress) => void): () => void;
  /** Stops sync and submission. Safe to call more than once. */
  close(): Promise<void>;
}

export interface LocalWalletSyncProgress {
  /**
   * 0–100 across the shielded, unshielded, and DUST components (the least
   * synced of the three), or null before the indexer has reported a target.
   */
  percent: number | null;
  synced: boolean;
  connected: boolean;
}

/**
 * The shielded and DUST wallets report `appliedIndex` (wallet-sdk-abstractions
 * SyncProgress) while the unshielded wallet ships its own shape with
 * `appliedId`/`highestTransactionId`. Which target field the indexer actually
 * populates varies by deployment — observed live against preview, only
 * `highestRelevantWalletIndex` carries the walk target (`highestIndex` and
 * `highestRelevantIndex` stay 0) — so the target is the largest index any of
 * them reports. A component with no target yet contributes nothing.
 */
function componentRatio(progress: {
  appliedIndex?: bigint;
  highestIndex?: bigint;
  highestRelevantIndex?: bigint;
  highestRelevantWalletIndex?: bigint;
  appliedId?: bigint;
  highestTransactionId?: bigint;
}): number | null {
  const candidates = [
    progress.highestRelevantWalletIndex,
    progress.highestRelevantIndex,
    progress.highestIndex,
    progress.highestTransactionId,
  ].filter((value): value is bigint => value !== undefined);
  const target = candidates.reduce((max, value) => (value > max ? value : max), 0n);
  const reported = progress.appliedIndex ?? progress.appliedId;
  if (reported === undefined || target <= 0n) return null;
  const applied = reported > target ? target : reported;
  return Number(applied) / Number(target);
}

// ---------------------------------------------------------------------------
// Funding honesty
// ---------------------------------------------------------------------------

/** The public Preview faucet. Probed 2026/08/04: `/api/health` reports SERVING. */
export const PREVIEW_FAUCET_URL = 'https://faucet.preview.midnight.network';

/**
 * Whether a public faucet exists for this network. Only Preview has one.
 *
 * NOTE — deliberately no automated drip. The faucet's `POST /drips` requires an
 * `X-Captcha-Token` header from a Cloudflare Turnstile challenge (probed
 * 2026/08/04), so no in-app code can honestly obtain a drip. The only truthful
 * funding flow is: copy the address, open the faucet, complete the captcha
 * there, and let the wallet's own sync report the arrival.
 */
export function faucetAvailable(networkId: string): boolean {
  return networkId === 'preview';
}

// ---------------------------------------------------------------------------
// Proving-mode selection
// ---------------------------------------------------------------------------

function defaultProvingMode(): LocalWalletProvingMode {
  if (environment().VITE_BROWSER_PROVER === '1') return 'browser';
  try {
    if (
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('prover') === 'browser'
    ) {
      return 'browser';
    }
  } catch {
    // A locked-down or non-browser context simply has no URL override.
  }
  return 'http';
}

// ---------------------------------------------------------------------------
// Error classification for sends
// ---------------------------------------------------------------------------

/**
 * The wallet SDK reports a balancing shortfall as an `effect` tagged error,
 * `{ _tag: 'Wallet.InsufficientFunds', tokenType }` (see
 * `wallet-sdk-unshielded-wallet/dist/v1/Transacting.js` and its DUST twin).
 * `Effect.runPromise` may wrap it, so up to three `cause` links are walked.
 * Anything that is not recognisably a shortfall returns `null` and the original
 * error is rethrown untouched — no invented codes.
 */
function balancingShortfall(cause: unknown): 'insufficient-night' | 'insufficient-dust' | null {
  const nightRaw = ledger.nativeToken().raw;
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const record = current as { _tag?: unknown; tokenType?: unknown; cause?: unknown };
    if (record._tag === 'Wallet.InsufficientFunds') {
      return record.tokenType === nightRaw ? 'insufficient-night' : 'insufficient-dust';
    }
    current = record.cause;
  }
  return null;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * `MidnightBech32m.parse` reports mainnet as the exported `mainnet` symbol (a
 * mainnet address carries no network segment), every other network as its
 * string. This is the SDK's own normalisation, so `mn_addr1…` compares
 * correctly against a `mainnet` network id instead of being misreported as a
 * wrong-network address.
 */
function parsedNetworkName(value: string | typeof mainnet): string {
  return value === mainnet ? 'mainnet' : value;
}

/**
 * Builds the in-browser Midnight wallet from a passkey-derived seed.
 *
 * Mirrors `createWallet(seedHex)` in the custody prototype: HD derivation, then
 * `ZswapSecretKeys.fromSeed` / `DustSecretKey.fromSeed` / `createKeystore`, then
 * `WalletFacade.init` with the shielded, unshielded, and DUST starters, then
 * `start`.
 *
 * The caller may zero `seed` as soon as this resolves; nothing retains it.
 */
export async function createLocalMidnightWallet(
  seed: Uint8Array,
  options: CreateLocalMidnightWalletOptions = {},
): Promise<LocalMidnightWallet> {
  if (seed.length !== WALLET_SEED_BYTES) {
    throw new Error(`A Midnight wallet seed must be ${WALLET_SEED_BYTES} bytes.`);
  }
  installZswapApplyGuard();

  const network = localWalletNetworkConfig(options.network);
  // The address codecs and the unshielded keystore read the process-wide
  // network id, so it must be set before any key or address is produced.
  setNetworkId(network.networkId);

  const roleKeys = deriveRoleKeys(seed);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(roleKeys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(roleKeys[Roles.Dust]);
  const nightExternalKey = roleKeys[Roles.NightExternal];
  const unshieldedKeystore = createKeystore(nightExternalKey, network.networkId);
  // The two ledger constructors above copy their seeds into wasm memory, so
  // those bytes can go immediately. `createKeystore` does the opposite: it
  // closes over its argument and re-reads it on every signature, so the
  // NightExternal key must stay live until `close()`.
  roleKeys[Roles.Zswap].fill(0);
  roleKeys[Roles.Dust].fill(0);

  const configuration = {
    networkId: network.networkId,
    indexerClientConnection: {
      indexerHttpUrl: network.indexerHttpUrl,
      indexerWsUrl: network.indexerWsUrl,
    },
    provingServerUrl: new URL(network.provingServerUrl),
    relayURL: new URL(network.relayUrl),
    costParameters: { feeBlocksMargin: options.feeBlocksMargin ?? 100 },
    txHistoryStorage: noopTxHistoryStorage(),
  };

  const provingMode = options.provingMode ?? defaultProvingMode();
  // An explicit service wins; otherwise browser mode injects the in-tab wasm
  // prover and http mode leaves the facade's default (network.provingServerUrl)
  // in place. There is deliberately no cross-over: a browser-mode wallet that
  // cannot find its /zk-params fails, it does not silently phone the server.
  const provingService =
    options.provingService ?? (provingMode === 'browser' ? () => wasmWalletProvingService() : undefined);

  const unshieldedPublicKey = PublicKey.fromKeyStore(unshieldedKeystore);
  // Available before the facade exists, which is what lets a snapshot be looked
  // up in time to build the facade with restore starters.
  const unshieldedAddress = unshieldedPublicKey.address;

  /**
   * Builds and starts a facade. With `snapshot` the three component wallets are
   * built through `restore()`, which deserialises the stored state and continues
   * the indexer subscription from its applied index; `facade.start` then
   * re-attaches the secret keys exactly as in the cold path. `restore()` throws
   * synchronously on a payload it cannot decode (`Either.getOrThrow` in
   * `ShieldedWallet.js`), so a bad snapshot fails here rather than corrupting a
   * running wallet.
   */
  const startFacade = async (snapshot: WalletSnapshot | null): Promise<WalletFacade> => {
    let started: WalletFacade | null = null;
    try {
      // The facade's `InitParams` generics are far stricter than the starters
      // need; the custody prototype casts here for the same reason.
      started = await (WalletFacade.init as (params: unknown) => Promise<WalletFacade>)({
        configuration,
        shielded: (config: unknown) =>
          snapshot
            ? ShieldedWallet(config as never).restore(snapshot.shielded)
            : ShieldedWallet(config as never).startWithSecretKeys(shieldedSecretKeys),
        unshielded: (config: unknown) =>
          snapshot
            ? UnshieldedWallet(config as never).restore(snapshot.unshielded)
            : UnshieldedWallet(config as never).startWithPublicKey(unshieldedPublicKey),
        dust: (config: unknown) =>
          snapshot
            ? DustWallet(config as never).restore(snapshot.dust)
            : DustWallet(config as never).startWithSecretKey(
                dustSecretKey,
                ledger.LedgerParameters.initialParameters().dust,
              ),
        ...(provingService ? { provingService } : {}),
      });
      await started.start(shieldedSecretKeys, dustSecretKey);
      return started;
    } catch (cause) {
      if (started) {
        try {
          await started.stop();
        } catch (stopCause) {
          console.debug('[localWallet] failed facade did not stop cleanly', stopCause);
        }
      }
      throw cause;
    }
  };

  const cached =
    (options.resume ?? 'auto') === 'auto'
      ? await loadWalletSnapshot(network.networkId, unshieldedAddress)
      : null;

  let facade: WalletFacade;
  let resumedFromSnapshot = false;
  if (cached) {
    try {
      facade = await startFacade(cached);
      resumedFromSnapshot = true;
      console.debug(
        `[localWallet] resumed sync from the snapshot saved at ${cached.savedAt} (${network.networkId})`,
      );
    } catch (cause) {
      // A snapshot must never be able to stop the wallet from opening: drop it
      // and cold-start. `resumedFromSnapshot` stays false so no caller can
      // mistake this for a resume.
      console.debug('[localWallet] cached sync state rejected; cold start', cause);
      await deleteWalletSnapshot(network.networkId, unshieldedAddress);
      facade = await startFacade(null);
    }
  } else {
    facade = await startFacade(null);
  }

  const [shieldedAddress, dustAddress] = await Promise.all([
    facade.shielded.getAddress(),
    facade.dust.getAddress(),
  ]);

  const keys: LocalWalletKeys = { shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
  const encoded = {
    shielded: MidnightBech32m.encode(network.networkId, shieldedAddress).asString(),
    dust: MidnightBech32m.encode(network.networkId, dustAddress).asString(),
  };

  let closed = false;
  let stopped = false;

  const currentState = () =>
    Rx.firstValueFrom(facade.state().pipe(Rx.timeout({ first: STATE_TIMEOUT_MS })));

  // -------------------------------------------------------------------------
  // Smart-sync snapshot lifecycle
  // -------------------------------------------------------------------------

  const saveSnapshot = async (): Promise<void> => {
    if (stopped) return;
    try {
      // Bounded so that `close()` — which awaits this — can never be held open
      // by a wedged facade or a blocked IndexedDB transaction.
      const [shielded, unshielded, dust] = await Promise.race([
        Promise.all([
          facade.shielded.serializeState(),
          facade.unshielded.serializeState(),
          facade.dust.serializeState(),
        ]),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('serializing the wallet state timed out')),
            SNAPSHOT_TIMEOUT_MS,
          ),
        ),
      ]);
      await saveWalletSnapshot({
        version: WALLET_SNAPSHOT_VERSION,
        networkId: network.networkId,
        unshieldedAddress,
        savedAt: new Date().toISOString(),
        shielded,
        unshielded,
        dust,
      });
      if (import.meta.env.DEV) console.debug('[localWallet] sync snapshot saved');
    } catch (cause) {
      // Losing the cache costs a longer sync next time and nothing else.
      console.debug('[localWallet] unable to save the sync snapshot', cause);
    }
  };

  let snapshotTimer: ReturnType<typeof setInterval> | null = null;
  let sawSynced = false;
  const snapshotSubscription = facade.state().subscribe({
    next: (state) => {
      if (closed) return;
      if (!state.isSynced) {
        sawSynced = false;
        return;
      }
      if (sawSynced) return;
      sawSynced = true;
      void saveSnapshot();
      if (snapshotTimer === null) {
        // Keep refreshing while synced so a long-lived tab does not leave a
        // stale offset behind if it is killed rather than closed.
        snapshotTimer = setInterval(() => {
          if (!closed && sawSynced) void saveSnapshot();
        }, 60_000);
      }
    },
    error: (cause) => {
      // Sync errors are surfaced through subscribeSyncProgress's `connected`
      // flag; here they only mean "stop trying to snapshot".
      console.debug('[localWallet] state stream error; snapshots paused', cause);
    },
  });

  const getBalances = async (): Promise<LocalWalletBalances> => {
    try {
      const state = await currentState();
      const now = new Date();

      const nightTokenType = ledger.nativeToken().raw;
      // A missing native token entry is a real zero balance, not an unknown one.
      const night = state.unshielded.balances[nightTokenType] ?? 0n;
      const shieldedTokenCount = Object.values(state.shielded.balances).filter(
        (value) => value > 0n,
      ).length;

      const dustCoins = state.dust.totalCoins;
      const dustCapSpecks = dustCoins.reduce((total, coin) => total + coin.maxCap, 0n);
      // No generating UTxO means Passport has no cap to report, which is not
      // the same statement as a cap of zero.
      const dustCap =
        dustCoins.length > 0 ? formatUnits(dustCapSpecks, DUST_DECIMALS) : null;
      const dustSyncing = !state.dust.progress.isCompleteWithin();

      return {
        unshieldedBalance: formatUnits(night, NIGHT_DECIMALS),
        shieldedTokenCount,
        dustBalance: formatUnits(state.dust.balance(now), DUST_DECIMALS),
        dustCap,
        dustSyncing,
        balanceStatus: dustSyncing ? 'syncing' : 'ready',
        balanceError: null,
      };
    } catch (cause) {
      return {
        unshieldedBalance: null,
        shieldedTokenCount: null,
        dustBalance: null,
        dustCap: null,
        dustSyncing: false,
        balanceStatus: 'unavailable',
        balanceError: cause instanceof Error ? cause.message : String(cause),
      };
    }
  };

  // -------------------------------------------------------------------------
  // Sending unshielded NIGHT
  // -------------------------------------------------------------------------

  const revertQuietly = async (recipe: BalancingRecipe): Promise<void> => {
    try {
      await facade.revert(recipe);
    } catch (cause) {
      console.debug('[localWallet] could not revert an abandoned transaction', cause);
    }
  };

  const sendUnshieldedNight = async (params: SendNightParams): Promise<SendNightResult> => {
    if (closed) {
      throw new SendNightError('wallet-closed', 'This Passport wallet has been closed.');
    }
    if (params.amount <= 0n) {
      // A programming error rather than a send outcome, so it gets no code.
      throw new RangeError('A NIGHT transfer amount must be greater than zero.');
    }

    // (1) Recipient. Parse, then require this wallet's own network, then require
    // that the payload really is an unshielded address.
    const candidate = params.recipientAddress.trim();
    let parsed: MidnightBech32m;
    try {
      parsed = MidnightBech32m.parse(candidate);
    } catch (cause) {
      throw new SendNightError(
        'invalid-recipient',
        'That is not a Midnight address.',
        messageOf(cause),
      );
    }
    const recipientNetwork = parsedNetworkName(parsed.network);
    if (recipientNetwork !== network.networkId) {
      throw new SendNightError(
        'wrong-network',
        `That address belongs to the ${recipientNetwork} network; this wallet is on ${network.networkId}.`,
      );
    }
    let recipient: UnshieldedAddress;
    try {
      recipient = parsed.decode(UnshieldedAddress, network.networkId);
    } catch (cause) {
      throw new SendNightError(
        'invalid-recipient',
        'That is a Midnight address, but not an unshielded (mn_addr…) one.',
        messageOf(cause),
      );
    }

    // (2) Pre-checks against real synced state, BEFORE anything is built. A
    // refusal here means no transaction was ever constructed.
    const nightTokenType = ledger.nativeToken().raw;
    const state = await currentState();
    const night = state.unshielded.balances[nightTokenType] ?? 0n;
    if (night < params.amount) {
      throw new SendNightError(
        'insufficient-night',
        `This wallet holds ${formatUnits(night, NIGHT_DECIMALS)} NIGHT; ${formatUnits(params.amount, NIGHT_DECIMALS)} is required.`,
      );
    }
    if (state.dust.balance(new Date()) === 0n) {
      throw new SendNightError(
        'insufficient-dust',
        'Fees are paid in DUST and this wallet has none yet. DUST is generated by registered NIGHT; wait for generation or register a NIGHT UTxO first.',
      );
    }

    // (3) Build. (4) Sign with the unshielded keystore.
    const ttl = new Date(Date.now() + (params.ttlMinutes ?? 30) * 60_000);
    let recipe: BalancingRecipe;
    try {
      recipe = await facade.transferTransaction(
        [
          {
            type: 'unshielded',
            outputs: [{ type: nightTokenType, receiverAddress: recipient, amount: params.amount }],
          },
        ],
        { shieldedSecretKeys, dustSecretKey },
        { ttl },
      );
    } catch (cause) {
      const shortfall = balancingShortfall(cause);
      if (shortfall === 'insufficient-night') {
        throw new SendNightError(
          'insufficient-night',
          'There is not enough NIGHT to cover this transfer once fees are balanced.',
          messageOf(cause),
        );
      }
      if (shortfall === 'insufficient-dust') {
        throw new SendNightError(
          'insufficient-dust',
          'There is not enough DUST to pay this transaction’s fee.',
          messageOf(cause),
        );
      }
      throw cause;
    }

    let signed: BalancingRecipe;
    try {
      signed = await facade.signRecipe(recipe, (data) => keys.unshieldedKeystore.signData(data));
    } catch (cause) {
      await revertQuietly(recipe);
      throw cause;
    }

    const releaseCoins = async () => {
      // Best effort: the coins this recipe reserved are released so the balance
      // does not stay locked behind a transaction that never went out.
      await revertQuietly(signed);
    };

    // (5) Prove. In browser mode a missing /zk-params tree surfaces here with
    // the fetch-zk-params instruction in `detail`, unmasked.
    let finalized: Awaited<ReturnType<typeof facade.finalizeRecipe>>;
    try {
      finalized = await facade.finalizeRecipe(signed);
    } catch (cause) {
      await releaseCoins();
      throw new SendNightError(
        'proving-failed',
        provingMode === 'browser'
          ? 'The in-browser prover could not prove this transaction.'
          : 'The proof server could not prove this transaction.',
        messageOf(cause),
      );
    }

    // (6) Submit. Only a real identifier from the node produces a result.
    let txId: string;
    try {
      txId = await facade.submitTransaction(finalized);
    } catch (cause) {
      await releaseCoins();
      throw new SendNightError(
        'submit-rejected',
        'The node rejected this transaction.',
        messageOf(cause),
      );
    }

    return {
      txId: String(txId),
      recipientAddress: parsed.asString(),
      amount: params.amount,
      submittedAt: new Date().toISOString(),
    };
  };

  return {
    network,
    unshieldedAddress,
    shieldedAddress: encoded.shielded,
    dustAddress: encoded.dust,
    facade,
    keys,
    provingMode,
    resumedFromSnapshot,
    saveSnapshot,
    sendUnshieldedNight,
    getBalances,
    async surfaces(): Promise<LocalWalletSurfaces> {
      return {
        unshieldedAddress,
        shieldedAddress: encoded.shielded,
        dustAddress: encoded.dust,
        // All three addresses are derived locally, so they are never partial.
        addressStatus: 'ready',
        ...(await getBalances()),
      };
    },
    async waitForSync(): Promise<void> {
      await Rx.firstValueFrom(facade.state().pipe(Rx.filter((state) => state.isSynced)));
    },
    subscribeSyncProgress(listener: (progress: LocalWalletSyncProgress) => void): () => void {
      const subscription = facade
        .state()
        .pipe(Rx.throttleTime(500, undefined, { leading: true, trailing: true }))
        .subscribe((state) => {
          if (import.meta.env.DEV) {
            const show = (p: unknown) => JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
            console.debug(
              `[localWallet sync] shielded=${show(state.shielded.progress)} unshielded=${show(state.unshielded.progress)} dust=${show(state.dust.progress)} synced=${state.isSynced}`,
            );
          }
          const ratios = [
            componentRatio(state.shielded.progress),
            componentRatio(state.unshielded.progress),
            componentRatio(state.dust.progress),
          ].filter((ratio): ratio is number => ratio !== null);
          const percent =
            ratios.length === 0
              ? null
              : Math.max(0, Math.min(100, Math.floor(Math.min(...ratios) * 100)));
          listener({
            // A synced facade is 100% regardless of index arithmetic.
            percent: state.isSynced ? 100 : percent,
            synced: state.isSynced,
            connected:
              state.shielded.progress.isConnected &&
              state.unshielded.progress.isConnected &&
              state.dust.progress.isConnected,
          });
        });
      return () => subscription.unsubscribe();
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (snapshotTimer !== null) {
        clearInterval(snapshotTimer);
        snapshotTimer = null;
      }
      snapshotSubscription.unsubscribe();
      // Last write wins: whatever this session reached is what the next one
      // resumes from, synced or not.
      await saveSnapshot();
      stopped = true;
      try {
        await facade.stop();
      } finally {
        // Safe only now that nothing will ask the keystore to sign again.
        nightExternalKey.fill(0);
      }
    },
  };
}
