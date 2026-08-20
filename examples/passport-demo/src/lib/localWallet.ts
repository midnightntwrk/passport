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
 *   3. The returned handle reports the surfaces the Home screen reads
 *      (see `LocalWalletSurfaces` below).
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
 *
 * HOW A WALLET GETS ITS FIRST CHAIN POSITION (2026/08/06)
 * ------------------------------------------------------
 * Two ways, and the handle says which happened:
 *
 *   1. `resumedFromSnapshot` — a cached snapshot for this (network, address)
 *      was accepted, so the walk continues from where it stopped.
 *   2. Otherwise, a walk from genesis — but only where one can finish. Above
 *      {@link DEEP_CHAIN_BLOCK_THRESHOLD} blocks it is refused outright with a
 *      {@link WalletBootstrapError} rather than started, because in a browser
 *      tab it does not finish: measured on Pre-production (~1.98M blocks) the
 *      heap climbs ~25 MB/s and the tab dies at ~4.2 GB. Refusing is honest;
 *      crashing is not.
 *
 * There is deliberately no third way. Starting a brand-new wallet at the chain
 * tip was implemented and measured on 2026/08/06 and does not work — the
 * ledger's zswap and DUST commitment trees must be filled from genesis in
 * index order, and no public indexer endpoint can fast-forward them. The
 * evidence, and the code that would do it if that ever changes, is in the
 * tip-bootstrap section of `./walletSnapshot.ts`. Nothing here calls it.
 */

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  mainnet,
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import type { BalancingRecipe, FacadeState } from '@midnight-ntwrk/wallet-sdk-facade';
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
import {
  sponsorBalanceOnly,
  sponsorHexToBytes,
  sponsorReadiness,
  BALANCE_WITHOUT_DUST,
} from './sponsor.js';
import { wasmWalletProvingService } from './wasmProver.js';
import {
  clearWalletSnapshots,
  deleteWalletSnapshot,
  fetchChainHeight,
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

/**
 * Vite replaces `import.meta.env` at build time. Under plain Node — which is
 * how this module's sync behaviour gets measured against a real indexer before
 * anything is shipped — there is no such object, so an absent one reads as
 * "nothing configured" rather than throwing.
 */
function environment(): Record<string, string | undefined> {
  return (
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
  );
}

/** `import.meta.env.DEV`, safe to read outside Vite. See {@link environment}. */
function devMode(): boolean {
  return (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
}

/**
 * Networks with public infrastructure. A wallet on one of these whose endpoint
 * points at a loopback address is almost always carrying a stale localnet
 * override, and the failure it produces later reaches the user as a nameless
 * "the proof server could not prove this" — so the mismatch is called out at
 * assembly time, naming the variable and both values.
 */
const PUBLIC_NETWORK_IDS = new Set(['preview', 'preprod', 'mainnet']);

function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    );
  } catch {
    // An unparseable URL fails on its own terms soon enough.
    return false;
  }
}

/** See {@link PUBLIC_NETWORK_IDS}. Warns; never blocks, because a developer may genuinely be proxying. */
function warnOnLoopbackEndpoints(config: LocalWalletNetworkConfig): void {
  if (!PUBLIC_NETWORK_IDS.has(config.networkId)) return;
  const endpoints: Array<[variable: string, url: string]> = [
    ['VITE_MIDNIGHT_PROVING_URL', config.provingServerUrl],
    ['VITE_INDEXER_URL', config.indexerHttpUrl],
    ['VITE_INDEXER_WS_URL', config.indexerWsUrl],
    ['VITE_MIDNIGHT_RELAY_URL (or the VITE_MIDNIGHT_NODE_URL it derives from)', config.relayUrl],
  ];
  for (const [variable, url] of endpoints) {
    if (!isLoopbackUrl(url)) continue;
    console.error(
      `[localWallet] ${variable} is ${url}, but VITE_MIDNIGHT_NETWORK_ID is "${config.networkId}" — a public network served from a loopback endpoint. This looks like a stale localnet override: unset ${variable} or change VITE_MIDNIGHT_NETWORK_ID to match.`,
    );
  }
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
  const config: LocalWalletNetworkConfig = {
    networkId: overrides.networkId ?? env.VITE_MIDNIGHT_NETWORK_ID ?? DEFAULT_NETWORK_ID,
    indexerHttpUrl,
    indexerWsUrl:
      overrides.indexerWsUrl ?? env.VITE_INDEXER_WS_URL ?? indexerWsFrom(indexerHttpUrl),
    relayUrl: overrides.relayUrl ?? env.VITE_MIDNIGHT_RELAY_URL ?? relayFrom(nodeUrl),
    provingServerUrl:
      overrides.provingServerUrl ?? env.VITE_MIDNIGHT_PROVING_URL ?? DEFAULT_PROVING_SERVER_URL,
  };
  warnOnLoopbackEndpoints(config);
  return config;
}

// ---------------------------------------------------------------------------
// Surfaces — what every shared consumer reads off the open wallet
// ---------------------------------------------------------------------------

export type LocalWalletAddressStatus = 'loading' | 'ready' | 'partial';
export type LocalWalletBalanceStatus = 'loading' | 'ready' | 'syncing' | 'unavailable';

/** Everything the Home screen, the address sheet, and the consent bridges
    read off an open wallet. */
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

/** The subset `getBalances()` refreshes. */
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

// NIGHT is quoted with 6 decimals and DUST in Specks with 15.
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

/**
 * The honest refusal a wallet with no DUST of its own receives. Declared once
 * so the authoritative send refusal and the advisory
 * {@link LocalMidnightWallet.feeReadiness} cannot drift into saying different
 * things about the same situation.
 */
const NO_DUST_SENTENCE =
  'Fees are paid in DUST and are normally covered by the fee sponsor. No sponsor is covering this one, and this wallet holds no DUST of its own, so it cannot pay a fee yet.';

/** Default floor between {@link LocalMidnightWallet.subscribeBalances} calls. */
const DEFAULT_BALANCE_MIN_INTERVAL_MS = 4_000;

/**
 * How often {@link LocalMidnightWallet.subscribeBalances} re-projects the DUST
 * balance while the chain is quiet. DUST accrues against the wall clock, and
 * accrual is deliberately outside the change fingerprint (see
 * {@link projectBalances}), so without this an idle wallet's displayed DUST
 * would freeze at whatever the last chain-driven emission carried.
 */
const DUST_HEARTBEAT_INTERVAL_MS = 45_000;

// ---------------------------------------------------------------------------
// Balance derivation
// ---------------------------------------------------------------------------

/**
 * Projects one facade state onto the balance surfaces, plus a fingerprint of
 * the facts those surfaces are made of.
 *
 * Pure and synchronous: it reads an already-emitted `FacadeState` and touches
 * no network. `getBalances()` uses it for a one-shot read and
 * `subscribeBalances()` for every emission of the same stream, so the two can
 * never report a different number for the same state.
 *
 * On the fingerprint. DUST is generated continuously against registered NIGHT,
 * so `state.dust.balance(now)` is a function of the wall clock as much as of
 * the chain: it grows between two emissions that carry identical chain state.
 * Putting that value in the fingerprint would therefore make every sync
 * progress tick "a change" and defeat the filter entirely. The fingerprint
 * instead carries the chain-visible DUST facts — the generation cap, how many
 * DUST coins exist, and whether the balance is spendable at all (the 0 → >0
 * transition that decides whether this wallet can pay its own fee) — alongside
 * the NIGHT balance, the unshielded coin count, the shielded token count, and
 * both sync flags. Every field of the returned {@link LocalWalletBalances} is
 * covered except the DUST balance's continuous accrual, which is why the
 * emitted `dustBalance` is always evaluated at `now`: when a call does happen,
 * the figure it carries is current, not a replay of the one that changed. The
 * accrual itself reaches an idle listener through `subscribeBalances`'s slow
 * heartbeat, never through this fingerprint.
 */
function projectBalances(
  state: FacadeState,
  now: Date,
): { balances: LocalWalletBalances; fingerprint: string } {
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
  const dustCap = dustCoins.length > 0 ? formatUnits(dustCapSpecks, DUST_DECIMALS) : null;
  const dustSyncing = !state.dust.progress.isCompleteWithin();
  const dust = state.dust.balance(now);
  const unshieldedCoinCount = (state.unshielded.availableCoins ?? []).length;

  return {
    balances: {
      unshieldedBalance: formatUnits(night, NIGHT_DECIMALS),
      shieldedTokenCount,
      dustBalance: formatUnits(dust, DUST_DECIMALS),
      dustCap,
      dustSyncing,
      balanceStatus: dustSyncing ? 'syncing' : 'ready',
      balanceError: null,
    },
    fingerprint: [
      night,
      dustCapSpecks,
      dustCoins.length,
      dust > 0n,
      unshieldedCoinCount,
      shieldedTokenCount,
      dustSyncing,
      state.isSynced,
    ].join('|'),
  };
}

/**
 * What the balance surfaces say when the state could not be read. `unavailable`
 * with the reason attached — never a zero, which would read as a real, empty
 * wallet.
 */
function unavailableBalances(cause: unknown): LocalWalletBalances {
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
  /**
   * Overrides {@link DEEP_CHAIN_BLOCK_THRESHOLD} for this call. Exists so the
   * guard can be exercised against a real network without waiting for one to
   * grow; production callers should leave it alone.
   */
  deepChainBlockThreshold?: bigint;
}

// ---------------------------------------------------------------------------
// First-sync bootstrap
// ---------------------------------------------------------------------------

const DEFAULT_DEEP_CHAIN_BLOCK_THRESHOLD = 1_000_000n;

/**
 * `VITE_DEEP_CHAIN_BLOCK_THRESHOLD`, when set, overrides the default ceiling —
 * a deployment can lift it without a code change. A value `BigInt` cannot
 * parse, and any value that is not positive, is ignored rather than allowed to
 * turn the guard off by accident.
 */
function resolveDeepChainBlockThreshold(): bigint {
  const raw = environment().VITE_DEEP_CHAIN_BLOCK_THRESHOLD?.trim();
  if (!raw) return DEFAULT_DEEP_CHAIN_BLOCK_THRESHOLD;
  try {
    const parsed = BigInt(raw);
    return parsed > 0n ? parsed : DEFAULT_DEEP_CHAIN_BLOCK_THRESHOLD;
  } catch {
    return DEFAULT_DEEP_CHAIN_BLOCK_THRESHOLD;
  }
}

/**
 * Above this many blocks, a from-genesis walk is refused rather than started.
 *
 * Chosen from measurement, not taste. Preview (~296k blocks) completes in a tab
 * in ~75 s at a steady ~90 MB heap; Pre-production (~1.98M) reached 3 % in
 * 150 s with the heap climbing ~25 MB/s until the tab died at ~4.2 GB.
 *
 * The default is 1M because the chain moves and a fixed ceiling rots: Preview's
 * tip was 303,932 on 2026/08/06 and grows ~14,400 blocks/day, so the previous
 * 500k default would have started refusing every fresh Preview onboarding
 * around 2026/08/20. 1M keeps Preview onboardable until roughly 2026/09/23
 * while still sitting at about half the only measured failure point (1.98M),
 * and `VITE_DEEP_CHAIN_BLOCK_THRESHOLD` can lift it further once a deeper walk
 * has been measured to survive. It remains a ceiling on a browser tab — not a
 * statement about the SDK, which walks these chains happily in Node.
 */
export const DEEP_CHAIN_BLOCK_THRESHOLD = resolveDeepChainBlockThreshold();

export type WalletBootstrapErrorCode = 'chain-too-deep';

/**
 * A wallet that could not be opened because the only remaining option was a
 * chain walk this environment cannot finish. Carries the numbers so the UI can
 * say what actually happened instead of "sync failed".
 */
export class WalletBootstrapError extends Error {
  readonly code: WalletBootstrapErrorCode;
  readonly networkId: string;
  readonly blockHeight: bigint | null;
  readonly threshold: bigint;
  /** What was tried first, when something was. */
  readonly detail?: string;

  constructor(params: {
    code: WalletBootstrapErrorCode;
    message: string;
    networkId: string;
    blockHeight: bigint | null;
    threshold: bigint;
    detail?: string;
  }) {
    super(params.message);
    this.name = 'WalletBootstrapError';
    this.code = params.code;
    this.networkId = params.networkId;
    this.blockHeight = params.blockHeight;
    this.threshold = params.threshold;
    if (params.detail !== undefined) this.detail = params.detail;
  }
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
  /**
   * `true` only when the transaction that was actually submitted came back
   * from the sponsor with its fee input attached, so this transfer cost the
   * user nothing in DUST. `false` on every other path, including a sponsored
   * attempt that failed and fell back to the user's own DUST.
   *
   * Nothing may tell a user a fee was covered on the strength of anything but
   * this flag.
   */
  sponsored: boolean;
  /** The sponsor's own hash for the balanced transaction, when sponsored. */
  sponsorTxHash?: string;
}

/**
 * How the next transfer's fee would be paid, as far as can be told *before* one
 * is built.
 *
 *   `sponsored` — a fee sponsor answered and holds a wallet that can pay. Held
 *                 to exactly the standard {@link SendNightResult.sponsored} is
 *                 held to: `sponsorReadiness()` reporting `ready`, which itself
 *                 gates on the service's own `available > 0`. Nothing weaker
 *                 earns this word.
 *   `own-dust`  — no sponsor, but this wallet holds DUST and can pay its own
 *                 fee. Carries the formatted balance it would pay from.
 *   `no-dust`   — no sponsor and no DUST, with the reason a send would give.
 *
 * When a sponsor URL is configured but the service is not ready, the fallback
 * modes carry `sponsorUnavailableReason` — the reason `sponsorReadiness()`
 * gave — so a surface can say "fee sponsor unavailable (reason), paying from
 * your own DUST" instead of silently pretending sponsorship never existed.
 * Absent when sponsorship is simply not configured. Additive: the three modes
 * and their existing fields are unchanged.
 *
 * Advisory only. It is a *prediction*, made from a state that may be a block
 * old by the time a transfer is built, so `sendUnshieldedNight` re-checks
 * everything itself and its refusals remain the authority. A surface may use
 * this to explain what is about to happen; nothing may use it to skip a check.
 */
export type FeeReadiness =
  | { mode: 'sponsored' }
  | { mode: 'own-dust'; dustBalance: string; sponsorUnavailableReason?: string }
  | { mode: 'no-dust'; reason: string; sponsorUnavailableReason?: string };

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
  /**
   * Streams the balance surfaces, so incoming funds appear without anyone
   * asking. Returns an unsubscribe function.
   *
   * Push, not poll. This subscribes to the very stream that already drives the
   * live sync percentage — `facade.state()`, a `combineLatest` over the
   * shielded, unshielded, and DUST wallets — and derives the balances from each
   * emission through the same {@link projectBalances} that `getBalances()` uses.
   * When the unshielded wallet applies a transaction that pays this wallet, its
   * state emits, the facade re-combines, and the listener is called with the new
   * NIGHT balance. No `getBalances()` call is involved.
   *
   * Cost. The SDK's indexer subscription runs whether or not anything listens
   * here, so this adds *zero* network traffic: it is one more subscriber to an
   * observable that is already live. Per emission it costs a few array reduces
   * and one DUST balance evaluation; per unchanged emission (a progress tick)
   * it costs that much and then stops at `distinctUntilChanged`, calling
   * nothing. Genuine changes are throttled to at most one listener call per
   * `minIntervalMs`, 4 s by default, leading and trailing — so a burst of
   * blocks cannot turn into a burst of renders, and the last state of the burst
   * is never dropped. One slow timer accompanies the push path: every 45 s the
   * latest state is re-projected at the current wall clock, and the listener is
   * called only when the continuously accruing DUST balance — deliberately
   * outside the change fingerprint — has moved since the last delivery. That is
   * how an idle wallet's DUST keeps rising on screen; the heartbeat touches no
   * network, costs one projection per tick, and is cleared by the returned
   * unsubscribe function.
   *
   * The listener is called once on subscribe with the current state, provided
   * all three component wallets have emitted (they have, once the facade has
   * started). If the state stream errors, the listener receives one final
   * `unavailable` reading carrying the reason and the subscription ends; it
   * does not resubscribe or retry behind the caller's back.
   */
  subscribeBalances(
    listener: (balances: LocalWalletBalances) => void,
    options?: {
      /** Floor between listener calls, in ms. Default 4 000. */
      minIntervalMs?: number;
    },
  ): () => void;
  /**
   * How the next transfer's fee would be paid — see {@link FeeReadiness}.
   * Advisory: `sendUnshieldedNight` keeps its own authoritative checks.
   *
   * Throws if this wallet's state cannot be read at all, because "we could not
   * tell" must not be reported as `no-dust`.
   */
  feeReadiness(): Promise<FeeReadiness>;
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

/**
 * Which networks have a public faucet, and where, now lives in
 * {@link ./networks.ts} so the wallet, the claim screen, and the explorer
 * links all read the same table. Re-exported here because this module is the
 * one every funding surface already imports.
 */
export { faucetAvailable, faucetUrlFor } from './networks.js';

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

  const threshold = options.deepChainBlockThreshold ?? DEEP_CHAIN_BLOCK_THRESHOLD;

  /**
   * The last resort: a walk from genesis, but only where one can finish. Above
   * {@link DEEP_CHAIN_BLOCK_THRESHOLD} blocks it refuses instead of starting
   * something that would take the tab down with it. An unreadable height counts
   * as too deep — "we could not check" is not "it is shallow".
   */
  const startFromGenesis = async (attempted?: string): Promise<WalletFacade> => {
    const height = await fetchChainHeight(network.indexerHttpUrl);
    if (height === null || height > threshold) {
      throw new WalletBootstrapError({
        code: 'chain-too-deep',
        message:
          height === null
            ? `This Passport has no cached sync state for ${network.networkId}, and the indexer would not say how deep that chain is. Syncing a wallet with existing history from scratch is not something this browser demo can do without knowing that.`
            : `This Passport has no cached sync state for ${network.networkId}, and that chain is ${height.toLocaleString('en-GB')} blocks deep. A first sync on a chain this deep is not supported in a browser demo — it exhausts the tab long before it finishes, and the ledger offers no way to skip the walk. Sign in on the device that already holds this Passport's sync state, or use a shallower network.`,
        networkId: network.networkId,
        blockHeight: height,
        threshold,
        ...(attempted !== undefined ? { detail: attempted } : {}),
      });
    }
    return startFacade(null);
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
      facade = await startFromGenesis(messageOf(cause));
    }
  } else {
    facade = await startFromGenesis();
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
      if (devMode()) console.debug('[localWallet] sync snapshot saved');
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
      return projectBalances(await currentState(), new Date()).balances;
    } catch (cause) {
      return unavailableBalances(cause);
    }
  };

  /**
   * Push-based balances. The whole of the "live auto-resync" behaviour is this
   * pipeline; see {@link LocalMidnightWallet.subscribeBalances} for the contract
   * and {@link projectBalances} for why the fingerprint is shaped as it is.
   */
  const subscribeBalances = (
    listener: (balances: LocalWalletBalances) => void,
    options: { minIntervalMs?: number } = {},
  ): () => void => {
    const minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_BALANCE_MIN_INTERVAL_MS);
    // For the heartbeat: the newest state seen (null once the stream has
    // errored, so a dead subscription cannot keep reporting fresh numbers) and
    // the last balances actually handed to the listener.
    let latestState: FacadeState | null = null;
    let lastDelivered: LocalWalletBalances | null = null;
    const deliver = (balances: LocalWalletBalances) => {
      lastDelivered = balances;
      listener(balances);
    };
    const subscription = facade
      .state()
      .pipe(
        Rx.tap((state) => {
          latestState = state;
        }),
        Rx.map((state) => projectBalances(state, new Date())),
        Rx.distinctUntilChanged((before, after) => before.fingerprint === after.fingerprint),
        // Exists solely to hold the trailing emission of a burst.
        Rx.throttleTime(minIntervalMs, undefined, { leading: true, trailing: true }),
      )
      .subscribe({
        next: ({ balances }) => {
          if (closed) return;
          deliver(balances);
        },
        error: (cause) => {
          // Same treatment `getBalances()` gives a failed read: say it is
          // unavailable and why, rather than reporting a zero or going quiet.
          latestState = null;
          if (closed) return;
          listener(unavailableBalances(cause));
        },
      });
    // The heartbeat. The fingerprint filter above deliberately ignores DUST
    // accrual, so while the chain is quiet nothing re-emits — but the balance
    // keeps growing against the wall clock. Every 45 s the latest state is
    // re-projected at `now`, and the listener is called only when the DUST
    // figure it would see has actually moved. No network is touched, and the
    // push path keeps sole custody of every chain-visible fact.
    const heartbeat = setInterval(() => {
      if (closed || latestState === null) return;
      const { balances } = projectBalances(latestState, new Date());
      if (balances.dustBalance !== lastDelivered?.dustBalance) deliver(balances);
    }, DUST_HEARTBEAT_INTERVAL_MS);
    return () => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
    };
  };

  const feeReadiness = async (): Promise<FeeReadiness> => {
    if (closed) throw new Error('This Passport wallet has been closed.');
    // Exactly the gate the send path uses, and for the same reason: readiness
    // means the service said it holds a wallet that can pay, not that
    // sponsorship is configured.
    const sponsorship = await sponsorReadiness();
    if (sponsorship.state === 'ready') return { mode: 'sponsored' };
    // `unavailable` means a sponsor URL is configured but the service cannot
    // pay right now; that fact travels with the fallback mode so the UI can
    // name it. `disabled` carries nothing — there is no sponsor to miss.
    const sponsorUnavailableReason =
      sponsorship.state === 'unavailable' ? sponsorship.reason : undefined;
    const dust = (await currentState()).dust.balance(new Date());
    if (dust > 0n) {
      return {
        mode: 'own-dust',
        dustBalance: formatUnits(dust, DUST_DECIMALS),
        ...(sponsorUnavailableReason !== undefined ? { sponsorUnavailableReason } : {}),
      };
    }
    return {
      mode: 'no-dust',
      reason: NO_DUST_SENTENCE,
      ...(sponsorUnavailableReason !== undefined ? { sponsorUnavailableReason } : {}),
    };
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

  /**
   * One attempt at a *sponsored* transfer: everything except the fee is built,
   * balanced, signed, and proved here; the fee input comes from the sponsor.
   *
   *   transferTransaction(payFees: false)
   *     → balanceUnprovenTransaction(without DUST)
   *     → signRecipe            ← the user's approval still happens
   *     → finalizeRecipe        ← proved on this device, as always
   *     → POST /balance-only    ← the sponsor attaches and proves the DUST leg
   *     → submitTransaction     ← this wallet submits, not the service
   *
   * Returns `null` — never a throw — when the sponsor could not be used
   * *before* anything was submitted, having first released every coin it
   * reserved so the caller's unsponsored path can build the same transfer again
   * from a clean slate. Once `submitTransaction` has been called the
   * transaction may have reached the chain even when the call throws (a
   * timeout, a transient error after acceptance), so from that point every
   * failure propagates as a `submit-rejected` {@link SendNightError} and
   * nothing falls back — a second, unsponsored send against an uncertain first
   * one is how a user pays twice.
   */
  const trySponsoredTransfer = async (
    outputs: Parameters<typeof facade.transferTransaction>[0],
    ttl: Date,
  ): Promise<{ txId: string; sponsorTxHash: string } | null> => {
    const reserved: BalancingRecipe[] = [];
    let balancedTransaction: ledger.Transaction<
      ledger.SignatureEnabled,
      ledger.Proof,
      ledger.Binding
    >;
    let sponsorTxHash: string;
    try {
      const base = await facade.transferTransaction(
        outputs,
        { shieldedSecretKeys, dustSecretKey },
        { ttl, payFees: false },
      );
      reserved.push(base);

      let recipe: BalancingRecipe = base;
      try {
        recipe = await facade.balanceUnprovenTransaction(
          base.transaction,
          { shieldedSecretKeys, dustSecretKey },
          { ttl, tokenKindsToBalance: BALANCE_WITHOUT_DUST },
        );
        reserved.push(recipe);
      } catch (cause) {
        // `payFees: false` already balanced the unshielded leg, so there can be
        // nothing left to add locally. That is not a failure — it is the whole
        // point of handing the DUST leg to the sponsor.
        if (!/No balancing transaction was created/i.test(messageOf(cause))) throw cause;
      }

      const signed = await facade.signRecipe(recipe, (data) =>
        keys.unshieldedKeystore.signData(data),
      );
      const finalized = await facade.finalizeRecipe(signed);
      const balanced = await sponsorBalanceOnly(finalized.serialize());
      // The sponsor stamps an expiry on the balanced transaction. An already
      // expired one is refused here, while falling back is still safe; an empty
      // or unparseable stamp reads as "no expiry given", matching
      // `validateSponsorBalanceResult`.
      const expiresAtMs = Date.parse(balanced.expiresAt);
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
        throw new Error(
          `the sponsor's balanced transaction expired at ${balanced.expiresAt} before it could be submitted`,
        );
      }
      balancedTransaction = ledger.Transaction.deserialize<
        ledger.SignatureEnabled,
        ledger.Proof,
        ledger.Binding
      >('signature', 'proof', 'binding', sponsorHexToBytes(balanced.txBytes));
      sponsorTxHash = balanced.txHash;
    } catch (cause) {
      // Loud in the console, invisible in the UI: the user gets the ordinary
      // transfer, and no copy anywhere claims a fee that was not covered.
      console.warn(
        '[localWallet] the sponsored transfer failed; falling back to this wallet’s own DUST',
        cause,
      );
      for (const recipe of [...reserved].reverse()) await revertQuietly(recipe);
      return null;
    }

    // Past this line the transaction may land whether or not the call resolves,
    // so a throw ends the send — same rule as the unsponsored submit below.
    try {
      await facade.submitTransaction(balancedTransaction);
      // The submit call answers with a transaction *identifier* (33 bytes),
      // which no explorer resolves — links built from it die with "not found"
      // (seen live 2026/08/07). The ledger's own hash is the one the indexer
      // and explorers key on.
      return { txId: String(balancedTransaction.transactionHash()), sponsorTxHash };
    } catch (cause) {
      for (const recipe of [...reserved].reverse()) await revertQuietly(recipe);
      throw new SendNightError(
        'submit-rejected',
        'The node rejected this sponsored transaction.',
        messageOf(cause),
      );
    }
  };

  // `registerDust()` stood here until the wallet-core review: on a sponsored
  // network it is a dead user step, so asking a Passport holder to register
  // their own NIGHT for DUST generation was removed from the demo. The
  // reference implementation survives where it is genuinely operational — the
  // funder service registers its own NIGHT (`examples/passport-funder/src/
  // wallet.ts`, `registerDustIfNeeded`) — and that is where to start from if
  // self-paid fees ever come back as a user-facing option.

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
    // The DUST pre-check is skipped only when a sponsor has really told us it
    // can pay: `sponsorReadiness` gates on `available > 0`, never on a wallet
    // that is merely synced. If sponsorship is off, unreachable, or dustless,
    // this refusal stands exactly as it did before sponsorship existed.
    const sponsorship = await sponsorReadiness();
    if (sponsorship.state !== 'ready') {
      if (devMode() && sponsorship.state === 'unavailable') {
        console.debug('[localWallet] fees are not sponsored:', sponsorship.reason);
      }
      if (state.dust.balance(new Date()) === 0n) {
        throw new SendNightError('insufficient-dust', NO_DUST_SENTENCE);
      }
    }

    // (3) Build. (4) Sign with the unshielded keystore.
    const ttl = new Date(Date.now() + (params.ttlMinutes ?? 30) * 60_000);
    const transferOutputs = [
      {
        type: 'unshielded' as const,
        outputs: [{ type: nightTokenType, receiverAddress: recipient, amount: params.amount }],
      },
    ];

    if (sponsorship.state === 'ready') {
      const sponsoredOutcome = await trySponsoredTransfer(transferOutputs, ttl);
      if (sponsoredOutcome) {
        return {
          txId: sponsoredOutcome.txId,
          recipientAddress: parsed.asString(),
          amount: params.amount,
          submittedAt: new Date().toISOString(),
          sponsored: true,
          sponsorTxHash: sponsoredOutcome.sponsorTxHash,
        };
      }
      // The sponsor was reachable but could not finish. Below is the ordinary
      // path, real fees and all — including its honest refusal when this
      // wallet has no DUST of its own.
      if (state.dust.balance(new Date()) === 0n) {
        throw new SendNightError(
          'insufficient-dust',
          'The fee sponsor could not cover this transaction, and this wallet has no DUST of its own to pay the fee with.',
        );
      }
    }

    let recipe: BalancingRecipe;
    try {
      recipe = await facade.transferTransaction(
        transferOutputs,
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
          : `The proof server at ${network.provingServerUrl} (network ${network.networkId}) could not prove this transaction.`,
        messageOf(cause),
      );
    }

    // (6) Submit. The node must accept it, but the submit call's return value
    // is a transaction *identifier* (33 bytes), which no explorer resolves —
    // the ledger's own hash is what the indexer and explorers key on.
    try {
      await facade.submitTransaction(finalized);
    } catch (cause) {
      await releaseCoins();
      throw new SendNightError(
        'submit-rejected',
        'The node rejected this transaction.',
        messageOf(cause),
      );
    }

    return {
      txId: String(finalized.transactionHash()),
      recipientAddress: parsed.asString(),
      amount: params.amount,
      submittedAt: new Date().toISOString(),
      // This wallet paid its own fee. Saying otherwise would be a lie.
      sponsored: false,
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
    subscribeBalances,
    feeReadiness,
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
          if (devMode()) {
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
