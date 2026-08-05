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
 * in-tab zkir-v2 path is NOT ported: it depends on a staged `/zk-params`
 * asset tree that this app does not ship. The `provingService` option is the
 * seam for adding it later without touching this module.
 */

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
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

export interface CreateLocalMidnightWalletOptions {
  /** Per-call overrides on top of the `import.meta.env` configuration. */
  network?: Partial<LocalWalletNetworkConfig>;
  /** Fee headroom in blocks. Matches the custody prototype's default. */
  feeBlocksMargin?: number;
  /**
   * Optional replacement proving service, e.g. an in-tab wasm prover. When
   * omitted the wallet proves against `network.provingServerUrl`.
   */
  provingService?: (configuration: unknown) => unknown;
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

  // The facade's `InitParams` generics are far stricter than the starters need;
  // the custody prototype casts here for the same reason.
  const facade: WalletFacade = await (WalletFacade.init as (params: unknown) => Promise<WalletFacade>)({
    configuration,
    shielded: (config: unknown) =>
      ShieldedWallet(config as never).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (config: unknown) =>
      UnshieldedWallet(config as never).startWithPublicKey(
        PublicKey.fromKeyStore(unshieldedKeystore),
      ),
    dust: (config: unknown) =>
      DustWallet(config as never).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
    ...(options.provingService ? { provingService: options.provingService } : {}),
  });

  await facade.start(shieldedSecretKeys, dustSecretKey);

  const [shieldedAddress, dustAddress] = await Promise.all([
    facade.shielded.getAddress(),
    facade.dust.getAddress(),
  ]);

  const keys: LocalWalletKeys = { shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
  const unshieldedAddress = PublicKey.fromKeyStore(unshieldedKeystore).address;
  const encoded = {
    shielded: MidnightBech32m.encode(network.networkId, shieldedAddress).asString(),
    dust: MidnightBech32m.encode(network.networkId, dustAddress).asString(),
  };

  let closed = false;

  const currentState = () =>
    Rx.firstValueFrom(facade.state().pipe(Rx.timeout({ first: STATE_TIMEOUT_MS })));

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

  return {
    network,
    unshieldedAddress,
    shieldedAddress: encoded.shielded,
    dustAddress: encoded.dust,
    facade,
    keys,
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
      try {
        await facade.stop();
      } finally {
        // Safe only now that nothing will ask the keystore to sign again.
        nightExternalKey.fill(0);
      }
    },
  };
}
