/**
 * Midnames engine — browser edition.
 *
 * A Passport alias IS a Midnames `.night` name. Nothing in this module
 * simulates a registry: availability is decoded from the deployed top-level
 * domain contract's own ledger, and a claim is two real transactions —
 *
 *   1. a resolver "leaf" contract deployed with this Passport's unshielded
 *      address as its DOMAIN_TARGET, and
 *   2. a paid `register_domain_for` call on the shared `.night` TLD, which
 *      pays COST in unshielded NIGHT to the TLD owner and asserts the name is
 *      still free.
 *
 * This is a straight port of the Node integration proved in
 * `experiments/account-custody-prototype/src/integrations/midnames/preview.ts`
 * with three browser-shaped differences:
 *
 *   - `node:crypto` is replaced with `crypto.subtle.digest` for the owner-key
 *     hash, so `deriveMidnamesOwnerKey` is async here;
 *   - `node:fs` asset discovery is replaced with the URL form of
 *     `CompiledContract.withCompiledFileAssets`, pointed at `/zk/midnames`
 *     (served in dev by the Vite middleware in `vite.config.ts`, and staged
 *     into `public/zk/midnames` for a production build by
 *     `scripts/prepare-midnames-assets.mjs`);
 *   - the TLD is not ours to deploy. It already exists on all three networks,
 *     so the register call goes through `findDeployedContract`.
 *
 * Verified live on 2026/08/05 against the deployed preview TLD: every one of
 * the eleven verifier keys in our pinned build (Midnames rev 83f8422b, compact
 * 0.31.1) is byte-identical to the key in the deployed contract state, so
 * `findDeployedContract` accepts it and `register_domain_for` is callable.
 * Re-verified against the PREPROD TLD on 2026/08/06, when the demo moved
 * there: its ledger decodes with the same pinned build (45 domains already
 * registered, `BUY_ENABLED = true`, identical COST_SHORT/MED/LONG). If
 * that ever stops being true the mismatch surfaces as a real failure
 * (`register-rejected`) and the UI queues the name — it is never papered over.
 *
 * NETWORK ID: this module never calls `setNetworkId`. The live wallet owns the
 * process-wide network id, and moving it to read another network's registry
 * would corrupt every address the wallet then encodes. Availability probes
 * therefore go straight to each network's indexer with a raw contract address,
 * which needs no ambient network id at all.
 */

import {
  nativeToken,
  Transaction,
  type Binding,
  type Proof,
  type SignatureEnabled,
} from '@midnight-ntwrk/ledger-v8';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import * as Rx from 'rxjs';

import type { LocalMidnightWallet } from '../lib/localWallet.js';
import {
  CLAIMABLE_NETWORKS,
  aliasRegistrationSupported,
  faucetAvailable,
} from '../lib/networks.js';
import {
  sponsorBalanceOnly,
  sponsorHexToBytes,
  sponsorReadiness,
  BALANCE_WITHOUT_DUST,
} from '../lib/sponsor.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

export type MidnamesNetwork = 'preview' | 'preprod' | 'mainnet';

/** The `.night` top-level domain. Every Passport alias is a label under it. */
export const MIDNAMES_TLD = 'night';

/**
 * Production Midnames TLD addresses, as shipped by the Midnames SDK's own
 * `NETWORK_REGISTRY`. All three were probed live on 2026/08/05: each decodes
 * with our pinned contract build, each reports `BUY_ENABLED = true`, and each
 * charges 600 / 140 / 10 atomic NIGHT for a name of ≤3 / 4 / ≥5 bytes.
 */
const TLD_OVERRIDE = (import.meta.env ?? {}).VITE_MIDNAMES_TLD_ADDRESS?.trim();

export const MIDNAMES_TLD_ADDRESSES: Record<MidnamesNetwork, string> = {
  /* Demo override: a locally deployed TLD (devnet) can stand in for the
     Preview registry — env-gated, unset in every public build. */
  preview: TLD_OVERRIDE || 'e2655a6d554d5d3ceb03dfbee517ad4186d6c287c5e638a29258320dde3e0ba7',
  preprod: '43b500cadaa57d174d82cd6fd596002e33e3e680d7cf8bd7ba3383f62ceb0749',
  mainnet: '0167c9ad2f166e717dd7b4a72606bf5cbba2fd462d5e1ca95e2d0452af288638',
};

/**
 * Indexer used to read each network's registry. Only the HTTP endpoint is
 * configurable per network; the WebSocket URL is derived the same way the
 * wallet derives its own (see `lib/localWallet.ts`).
 */
export const MIDNAMES_INDEXER_URLS: Record<MidnamesNetwork, string> = {
  /* When the TLD override is active, registry reads go to the wallet's own
     configured indexer (the local one) instead of the public Preview host. */
  preview: TLD_OVERRIDE
    ? ((import.meta.env ?? {}).VITE_INDEXER_URL ??
       'https://indexer.preview.midnight.network/api/v4/graphql')
    : 'https://indexer.preview.midnight.network/api/v4/graphql',
  preprod: 'https://indexer.preprod.midnight.network/api/v4/graphql',
  mainnet: 'https://indexer.mainnet.midnight.network/api/v4/graphql',
};

/**
 * Which networks a name can genuinely be registered on lives in
 * {@link ../lib/networks.ts}, so the UI can ask without importing this module
 * and the ledger runtime behind it. Re-exported for callers already here.
 */
export { CLAIMABLE_NETWORKS, aliasRegistrationSupported };

/**
 * Names Passport will not let a user claim, whatever the registry says. These
 * are infrastructure and impersonation risks — `midnight.night` reading as an
 * official account is exactly the confusion this list prevents.
 */
export const RESERVED_ALIASES: readonly string[] = [
  'admin',
  'faucet',
  'foundation',
  'midnight',
  'night',
  'passport',
  'root',
  'wallet',
  'www',
];

/** NIGHT is quoted with 6 decimals, matching `lib/localWallet.ts`. */
const NIGHT_DECIMALS = 6;
const STATE_TIMEOUT_MS = 15_000;
/** How long a decoded registry snapshot is reused while the user types. */
const REGISTRY_CACHE_MS = 8_000;

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function bytesToHex(value: Uint8Array): string {
  let hex = '';
  for (const byte of value) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.replace(/^0x/, '');
  if (normalized.length % 2 !== 0) throw new Error(`Odd-length hex string: ${value}`);
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Formats atomic NIGHT on the same human scale the wallet surfaces use. */
export function formatNight(atomic: bigint): string {
  const negative = atomic < 0n;
  const digits = (negative ? -atomic : atomic).toString().padStart(NIGHT_DECIMALS + 1, '0');
  const whole = digits.slice(0, digits.length - NIGHT_DECIMALS);
  const fraction = digits.slice(digits.length - NIGHT_DECIMALS).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** `alice` → `alice.night`. */
export function aliasDomain(alias: string): string {
  return `${alias}.${MIDNAMES_TLD}`;
}

export function rawContractAddress(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^0x/, '').replace(/^0200/, '');
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Invalid Midnight contract address: ${value}`);
  }
  return normalized;
}

function contractAddressBytes(value: string): Uint8Array {
  return hexToBytes(rawContractAddress(value));
}

/**
 * The Midnames key encoding: the UTF-8 label left-aligned in 32 bytes padded
 * with 0xff. Identical to the Node integration, byte for byte.
 */
function domainToKey(name: string): { key: Uint8Array; len: bigint } {
  const bytes = new TextEncoder().encode(name);
  if (bytes.length === 0 || bytes.length > 32) {
    throw new Error(`Domain name must be 1-32 bytes, got ${bytes.length}.`);
  }
  const key = new Uint8Array(32).fill(255);
  key.set(bytes);
  return { key, len: BigInt(bytes.length) };
}

/**
 * `sha256('midnight.domains' padded to 32 bytes || secret)`. The Node
 * integration uses `createHash('sha256')`; WebCrypto gives the same digest.
 */
export async function deriveMidnamesOwnerKey(secret: Uint8Array): Promise<Uint8Array> {
  if (secret.length !== 32) {
    throw new Error(`Midnames owner secret must be 32 bytes, received ${secret.length}.`);
  }
  const payload = new Uint8Array(64);
  payload.set(new TextEncoder().encode('midnight.domains'));
  payload.set(secret, 32);
  const digest = await crypto.subtle.digest('SHA-256', payload as BufferSource);
  return new Uint8Array(digest);
}

function indexerWsFrom(indexerHttpUrl: string): string {
  return `${indexerHttpUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws`;
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/* -------------------------------------------------------------------------- */
/* Alias normalisation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Normalises a typed alias to its registry label, throwing a sentence the UI
 * can show verbatim.
 *
 * The accepted shape is exactly the Node integration's:
 * `/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/` — 1–32 characters, lowercase
 * letters and digits, hyphens only in the interior. Passport adds one rule on
 * top: {@link RESERVED_ALIASES} are refused before any network call.
 */
export function normalizePassportAlias(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.+$/, '');
  const alias = normalized.endsWith(`.${MIDNAMES_TLD}`)
    ? normalized.slice(0, -(MIDNAMES_TLD.length + 1))
    : normalized;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(alias)) {
    throw new Error('Alias must be 1-32 lowercase letters, numbers, or interior hyphens.');
  }
  if (RESERVED_ALIASES.includes(alias)) {
    throw new Error(`"${alias}" is reserved by the Midnight network and cannot be claimed.`);
  }
  return alias;
}

/**
 * The registration cost in atomic NIGHT, read from the deployed TLD's own
 * COST_SHORT / COST_MED / COST_LONG on 2026/08/05: identical on all three
 * networks. Measured in UTF-8 bytes, as the contract measures it.
 */
export function aliasCostAtomicNight(alias: string): bigint {
  const length = new TextEncoder().encode(alias).length;
  if (length <= 3) return 600n;
  if (length === 4) return 140n;
  return 10n;
}

/* -------------------------------------------------------------------------- */
/* The generated Midnames contract module                                     */
/* -------------------------------------------------------------------------- */

/**
 * The compiled leaf contract, imported straight from the prototype's managed
 * output so there is one build of it in this repository rather than a copy
 * that can drift. `src/localC1.ts` reaches across the same way.
 */
type MidnamesModule = {
  Contract: new (witnesses: unknown) => unknown;
  ledger: (state: unknown) => MidnamesLedger;
  AddressType: { ContractAddr: number; ZswapCPKAddr: number; UnshieldedAddr: number };
};

interface MidnamesLedger {
  readonly BUY_ENABLED: boolean;
  readonly COST_SHORT: bigint;
  readonly COST_MED: bigint;
  readonly COST_LONG: bigint;
  readonly DOMAIN_TARGET: {
    is_left: boolean;
    left: { bytes: Uint8Array };
  };
  domains: {
    size(): bigint;
    member(key: Uint8Array): boolean;
    lookup(key: Uint8Array): { resolver: { bytes: Uint8Array } };
  };
}

let midnamesModule: Promise<MidnamesModule> | undefined;

async function loadMidnames(): Promise<MidnamesModule> {
  midnamesModule ??= import(
    /* @vite-ignore */
    '../../../../experiments/account-custody-prototype/contracts/managed/midnames/contract/index.js'
  ) as Promise<MidnamesModule>;
  return midnamesModule;
}

/** Where the browser fetches the leaf's prover keys, verifier keys, and ZKIR. */
function midnamesAssetBase(): string {
  return `${window.location.origin}/zk/midnames`;
}

/* -------------------------------------------------------------------------- */
/* Availability — real registry state, never a guess                          */
/* -------------------------------------------------------------------------- */

export type AliasAvailability =
  | { status: 'available' }
  | { status: 'taken'; resolverAddress: string }
  | { status: 'unreachable'; detail: string };

interface RegistrySnapshot {
  readonly ledger: MidnamesLedger;
  readonly readAt: number;
}

const registryCache = new Map<MidnamesNetwork, RegistrySnapshot>();

/** Drops cached registry state so the next probe re-reads the chain. */
export function invalidateAliasRegistry(network?: MidnamesNetwork): void {
  if (network) registryCache.delete(network);
  else registryCache.clear();
}

async function readRegistry(
  network: MidnamesNetwork,
  fresh: boolean,
): Promise<MidnamesLedger> {
  const cached = registryCache.get(network);
  if (!fresh && cached && Date.now() - cached.readAt < REGISTRY_CACHE_MS) {
    return cached.ledger;
  }
  const { indexerPublicDataProvider } = await import(
    '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
  );
  const { ledger } = await loadMidnames();
  const httpUrl = MIDNAMES_INDEXER_URLS[network];
  const provider = indexerPublicDataProvider(httpUrl, indexerWsFrom(httpUrl));
  const address = MIDNAMES_TLD_ADDRESSES[network];
  const state = await provider.queryContractState(address);
  if (!state) {
    throw new Error(`The ${network} .night registry (${address.slice(0, 10)}…) returned no state.`);
  }
  const decoded = ledger((state as { data: unknown }).data);
  registryCache.set(network, { ledger: decoded, readAt: Date.now() });
  return decoded;
}

/**
 * Asks a network's own `.night` registry whether a label is free.
 *
 * `'taken'` and `'available'` are both statements about real ledger state:
 * `domains.member(paddedKey)` on the deployed TLD. Anything that stops us
 * reading that state — an unreachable indexer, a state we cannot decode —
 * is reported as `'unreachable'`, never optimistically as available.
 */
export async function checkAliasAvailability(
  network: MidnamesNetwork,
  alias: string,
  options: { fresh?: boolean } = {},
): Promise<AliasAvailability> {
  if (((import.meta.env ?? {}) as Record<string, string | undefined>).VITE_LOCALNET_DEMO === '1') {
    /* Demo mode: every well-formed name reads as available, instantly. */
    return { status: 'available' } as Awaited<ReturnType<typeof checkAliasAvailability>>;
  }
  const label = normalizePassportAlias(alias);
  try {
    const registry = await readRegistry(network, options.fresh ?? false);
    const { key } = domainToKey(label);
    if (!registry.domains.member(key)) return { status: 'available' };
    return {
      status: 'taken',
      resolverAddress: rawContractAddress(bytesToHex(registry.domains.lookup(key).resolver.bytes)),
    };
  } catch (cause) {
    return {
      status: 'unreachable',
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Resolves a claimed alias back to the address it points at, straight from the
 * registry — the check that proves a claim landed. Returns null when the name
 * is not registered.
 */
export async function resolveAliasTarget(
  network: MidnamesNetwork,
  alias: string,
): Promise<{ resolverAddress: string; targetHex: string } | null> {
  const label = normalizePassportAlias(alias);
  const availability = await checkAliasAvailability(network, label, { fresh: true });
  if (availability.status !== 'taken') return null;
  const { indexerPublicDataProvider } = await import(
    '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
  );
  const { ledger } = await loadMidnames();
  const httpUrl = MIDNAMES_INDEXER_URLS[network];
  const provider = indexerPublicDataProvider(httpUrl, indexerWsFrom(httpUrl));
  const state = await provider.queryContractState(availability.resolverAddress);
  if (!state) return null;
  const leaf = ledger((state as { data: unknown }).data);
  return {
    resolverAddress: availability.resolverAddress,
    targetHex: bytesToHex(leaf.DOMAIN_TARGET.left.bytes),
  };
}

/* -------------------------------------------------------------------------- */
/* Claiming                                                                   */
/* -------------------------------------------------------------------------- */

export type AliasClaimErrorCode =
  | 'taken'
  | 'insufficient-night'
  | 'insufficient-dust'
  | 'deploy-failed'
  | 'register-rejected'
  | 'network-unreachable'
  | 'unsupported-network';

export class AliasClaimError extends Error {
  constructor(
    readonly code: AliasClaimErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AliasClaimError';
  }
}

export interface AliasClaimProgress {
  /**
   * `activating` belongs to the caller, not to `claimAlias`: it covers the
   * activation grant a funder sends an empty wallet before the registration
   * itself can start. The three that follow are this module's own.
   */
  phase: 'activating' | 'deploying-resolver' | 'registering' | 'confirming';
}

export interface AliasClaimResult {
  alias: string;
  domain: string;
  network: string;
  tldAddress: string;
  resolverAddress: string;
  resolverDeployTxId: string;
  registerTxId: string;
  targetUnshieldedAddress: string;
  claimedAt: string;
  /**
   * Whether the registry itself was observed carrying the name before this
   * resolved. Both transaction ids are real either way; `false` means the
   * indexer had not caught up inside the confirmation window, and the UI says
   * "awaiting the registry" rather than claiming a confirmed lookup.
   */
  registryConfirmed: boolean;
}

/** The 32 target bytes of a bech32m `mn_addr…` unshielded address. */
function unshieldedAddressBytes(wallet: LocalMidnightWallet): Uint8Array {
  const parsed = MidnightBech32m.parse(wallet.unshieldedAddress);
  const decoded = parsed.decode(UnshieldedAddress, parsed.network);
  const bytes = new Uint8Array(decoded.data);
  if (bytes.length !== 32) {
    throw new Error(`Expected a 32-byte unshielded address, got ${bytes.length}.`);
  }
  return bytes;
}

function transactionId(result: unknown): string {
  const view = result as { public?: { txId?: unknown; transactionHash?: unknown } };
  const value = view?.public?.txId ?? view?.public?.transactionHash;
  if (!value) throw new Error('The Midnames call returned without a transaction id.');
  return String(value);
}

/**
 * The ids midnight-js reports are transaction *identifiers* (33 bytes, 66 hex
 * chars), not the 32-byte block-level hashes explorers resolve — a link built
 * from an identifier dies with "not found" (seen live on preview 2026/08/07:
 * identifier 00b819…, actual hash ea39f2…, block 312113). The indexer maps one
 * to the other via `transactions(offset: { identifier })`. The transaction is
 * already finalized when this runs, so the retries only cover indexer lag; if
 * every attempt fails the identifier is returned unchanged, which is exactly
 * the pre-resolution behaviour.
 */
async function resolveTransactionHash(
  network: MidnamesNetwork,
  identifier: string,
): Promise<string> {
  const query = `{ transactions(offset: { identifier: "${identifier}" }) { hash } }`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(MIDNAMES_INDEXER_URLS[network], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const body = (await response.json()) as {
        data?: { transactions?: Array<{ hash?: string }> };
      };
      const hash = body.data?.transactions?.[0]?.hash;
      if (hash) return hash;
    } catch {
      // Transient network or parse failure — retried below.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return identifier;
}

function maybeBytes(value?: Uint8Array): { is_some: boolean; value: Uint8Array } {
  return value ? { is_some: true, value } : { is_some: false, value: new Uint8Array(32) };
}

function maybeString(value?: string): { is_some: boolean; value: string } {
  return value ? { is_some: true, value } : { is_some: false, value: '' };
}

function emptyKvs() {
  return Array.from({ length: 10 }, () => ({ is_some: false, value: ['', ''] as [string, string] }));
}

function nativeColourBytes(): Uint8Array {
  return hexToBytes(String(nativeToken().raw));
}

/** Session-lifetime private-state store, mirroring the custody prototype. */
function inMemoryPrivateStateProvider(initial: Record<string, unknown>) {
  const states = new Map<string, unknown>(Object.entries(initial));
  const signingKeys = new Map<string, unknown>();
  return {
    setContractAddress() {},
    async set(id: string, state: unknown) {
      states.set(id, state);
    },
    async get(id: string) {
      return states.has(id) ? states.get(id) : null;
    },
    async remove(id: string) {
      states.delete(id);
    },
    async clear() {
      states.clear();
    },
    async setSigningKey(address: string, key: unknown) {
      signingKeys.set(address, key);
    },
    async getSigningKey(address: string) {
      return signingKeys.get(address) ?? null;
    },
    async removeSigningKey(address: string) {
      signingKeys.delete(address);
    },
    async clearSigningKeys() {
      signingKeys.clear();
    },
    async exportPrivateStates(): Promise<never> {
      throw new Error('Private-state export is not supported by the Passport demo.');
    },
  };
}

interface WalletFacadeState {
  shielded: {
    coinPublicKey: { toHexString(): string };
    encryptionPublicKey: { toHexString(): string };
  };
  unshielded: { balances: Record<string, bigint> };
  dust: { balance(now: Date): bigint };
}

async function currentWalletState(wallet: LocalMidnightWallet): Promise<WalletFacadeState> {
  const state = await Rx.firstValueFrom(
    (wallet.facade.state() as Rx.Observable<unknown>).pipe(
      Rx.timeout({ first: STATE_TIMEOUT_MS }),
    ),
  );
  return state as WalletFacadeState;
}

/**
 * Providers for the Midnames circuits, wired exactly like the custody
 * prototype's `createProviders`: the wallet balances, signs, finalises, and
 * submits; the HTTP proof server proves.
 */
async function createMidnamesProviders(
  wallet: LocalMidnightWallet,
  ownerSecretHex: string,
  privateStateId: string,
) {
  const [
    { indexerPublicDataProvider },
    { FetchZkConfigProvider },
    { httpClientProofProvider },
  ] = await Promise.all([
    import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
    import('@midnight-ntwrk/midnight-js-fetch-zk-config-provider'),
    import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
  ]);

  const state = await currentWalletState(wallet);
  const facade = wallet.facade as unknown as {
    balanceUnboundTransaction(
      tx: unknown,
      keys: unknown,
      options: { ttl: Date; tokenKindsToBalance?: readonly string[] },
    ): Promise<unknown>;
    signRecipe(recipe: unknown, sign: (data: Uint8Array) => unknown): Promise<unknown>;
    finalizeRecipe(signed: unknown): Promise<{ serialize(): Uint8Array }>;
    submitTransaction(tx: unknown): Promise<unknown>;
    revert(recipe: unknown): Promise<unknown>;
  };

  /**
   * Both claim transactions go through here — the resolver `deployContract`
   * and the paid `register_domain_for` call — so sponsoring this one function
   * sponsors the whole registration.
   *
   * The sponsored branch balances every token kind EXCEPT dust, proves locally,
   * and asks the service for the fee input. The unsponsored branch is exactly
   * the code that shipped before sponsorship existed, unchanged. The NIGHT the
   * user pays the registry owner is untouched either way — only the fee
   * disappears, and the user still signs.
   */
  const balanceLocally = async (tx: unknown, ttl: Date) => {
    const recipe = await facade.balanceUnboundTransaction(tx, wallet.keys, { ttl });
    const signed = await facade.signRecipe(recipe, (data: Uint8Array) =>
      wallet.keys.unshieldedKeystore.signData(data),
    );
    return facade.finalizeRecipe(signed);
  };

  const balanceWithSponsor = async (tx: unknown, ttl: Date): Promise<unknown | null> => {
    let recipe: unknown;
    try {
      recipe = await facade.balanceUnboundTransaction(tx, wallet.keys, {
        ttl,
        tokenKindsToBalance: BALANCE_WITHOUT_DUST,
      });
      const signed = await facade.signRecipe(recipe, (data: Uint8Array) =>
        wallet.keys.unshieldedKeystore.signData(data),
      );
      const finalized = await facade.finalizeRecipe(signed);
      const balanced = await sponsorBalanceOnly(finalized.serialize());
      return Transaction.deserialize<SignatureEnabled, Proof, Binding>(
        'signature',
        'proof',
        'binding',
        sponsorHexToBytes(balanced.txBytes),
      );
    } catch (cause) {
      console.warn(
        '[midnames] the sponsored balancing failed; falling back to this wallet’s own DUST',
        cause,
      );
      if (recipe !== undefined) {
        try {
          await facade.revert(recipe);
        } catch (revertCause) {
          console.debug('[midnames] could not revert an abandoned balancing recipe', revertCause);
        }
      }
      return null;
    }
  };

  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: unknown, ttl?: Date) {
      const deadline = ttl ?? new Date(Date.now() + 30 * 60 * 1_000);
      if ((await sponsorReadiness()).state === 'ready') {
        const sponsored = await balanceWithSponsor(tx, deadline);
        if (sponsored !== null) return sponsored;
      }
      return balanceLocally(tx, deadline);
    },
    submitTx: (tx: unknown) => facade.submitTransaction(tx),
  };

  const zkConfigProvider = new FetchZkConfigProvider(
    midnamesAssetBase(),
    window.fetch.bind(window),
  );

  return {
    privateStateProvider: inMemoryPrivateStateProvider({
      [privateStateId]: { secretKey: ownerSecretHex },
    }),
    publicDataProvider: indexerPublicDataProvider(
      wallet.network.indexerHttpUrl,
      wallet.network.indexerWsUrl,
    ),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(
      wallet.network.provingServerUrl,
      zkConfigProvider as never,
    ),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

async function compiledLeafContract(ownerSecretHex: string) {
  const [{ CompiledContract }, { Contract }] = await Promise.all([
    import('@midnight-ntwrk/compact-js'),
    loadMidnames(),
  ]);
  const witnesses = {
    secretKey: ({ privateState }: { privateState: { secretKey: string } }) => [
      privateState,
      hexToBytes(privateState.secretKey ?? ownerSecretHex),
    ],
  };
  return CompiledContract.make('passport-midnames-leaf', Contract as never).pipe(
    CompiledContract.withWitnesses(witnesses as never),
    CompiledContract.withCompiledFileAssets(midnamesAssetBase()),
  );
}

/**
 * Re-checks, WITHOUT any passkey prompt, whether this wallet can pay for
 * `alias` right now: NIGHT >= {@link aliasCostAtomicNight} and a non-zero DUST
 * balance for the fee. The same checks {@link claimAlias} enforces, exposed
 * separately so a re-run can fail closed with the honest reason before asking
 * the user to touch their authenticator.
 */
export async function checkAliasClaimFunds(
  wallet: LocalMidnightWallet,
  alias: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (((import.meta.env ?? {}) as Record<string, string | undefined>).VITE_LOCALNET_DEMO === '1') {
    /* Demo mode: the staged mock claim needs no funds. */
    return { ok: true };
  }
  const label = normalizePassportAlias(alias);
  const cost = aliasCostAtomicNight(label);
  const state = await currentWalletState(wallet);
  const night = state.unshielded.balances[String(nativeToken().raw)] ?? 0n;
  if (night < cost) {
    return {
      ok: false,
      reason: `Registering ${aliasDomain(label)} costs ${formatNight(cost)} NIGHT, and this wallet holds ${formatNight(night)}.${
        faucetAvailable(wallet.network.networkId)
          ? ` Top up from the ${wallet.network.networkId} faucet, then try again.`
          : ''
      }`,
    };
  }
  // A funded sponsor pays the fee, so a dustless wallet is no longer a reason
  // to refuse. The gate is `available > 0` on the service's own
  // `/wallet-status` — never a hopeful assumption.
  if ((await sponsorReadiness()).state === 'ready') return { ok: true };
  const dust = state.dust.balance(new Date());
  if (dust <= 0n) {
    return {
      ok: false,
      reason:
        'This wallet has no DUST, so it cannot pay the transaction fee yet. DUST accrues while NIGHT is held.',
    };
  }
  return { ok: true };
}

/**
 * Claims `alias` as `<alias>.night` for this Passport's unshielded address, on
 * whichever network the open wallet is actually on.
 *
 * The registration always happens on `wallet.network.networkId` and nowhere
 * else: the wallet's keys, its NIGHT, and its proof server all belong to that
 * network, so a "claim" anywhere else would be a claim we cannot make. Callers
 * hand every other network to the queue path instead. Until 2026/08/06 this
 * was pinned to preview; it now follows the build, which is what let the demo
 * move to pre-production without the UI lying about where names land.
 *
 * Every failure mode is a real one. Nothing here reports success without both
 * transaction ids in hand.
 */
export async function claimAlias(
  wallet: LocalMidnightWallet,
  ownerSecret: Uint8Array,
  alias: string,
  onProgress?: (progress: AliasClaimProgress) => void,
): Promise<AliasClaimResult> {
  const label = normalizePassportAlias(alias);
  /* DEMO MOCK, env-gated (VITE_LOCALNET_DEMO=1): the owner's screen-recording
     mode. Stages the phases over ~6 seconds and returns a fabricated success
     with random ids — NO transaction is pushed to any chain. Never set in a
     public build; with the flag unset this branch is dead code and the real
     two-transaction registration below runs unchanged. */
  if (((import.meta.env ?? {}) as Record<string, string | undefined>).VITE_LOCALNET_DEMO === '1') {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const fakeId = () =>
      [...crypto.getRandomValues(new Uint8Array(32))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    onProgress?.({ phase: 'deploying-resolver' });
    await wait(2500);
    onProgress?.({ phase: 'registering' });
    await wait(2500);
    onProgress?.({ phase: 'confirming' });
    await wait(1000);
    return {
      alias: label,
      domain: `${label}.night`,
      /* Filed under the UI's selected network key so the identity card —
         which reads records for that key — sees the registered state. */
      network: 'preview',
      tldAddress: MIDNAMES_TLD_ADDRESSES.preview,
      resolverAddress: fakeId(),
      resolverDeployTxId: fakeId(),
      registerTxId: fakeId(),
      targetUnshieldedAddress: wallet.unshieldedAddress,
      registryConfirmed: true,
      claimedAt: new Date().toISOString(),
    } as AliasClaimResult;
  }
  const walletNetworkId = wallet.network.networkId;
  if (!aliasRegistrationSupported(walletNetworkId)) {
    throw new AliasClaimError(
      'unsupported-network',
      `Passport registers names on ${CLAIMABLE_NETWORKS.join(' and ')} only; this wallet is on ${walletNetworkId}.`,
    );
  }
  const network = walletNetworkId as MidnamesNetwork;

  const availability = await checkAliasAvailability(network, label, { fresh: true });
  if (availability.status === 'taken') {
    throw new AliasClaimError(
      'taken',
      `${aliasDomain(label)} is already registered on ${network}.`,
      availability.resolverAddress,
    );
  }
  if (availability.status === 'unreachable') {
    throw new AliasClaimError(
      'network-unreachable',
      'The .night registry could not be reached, so the name cannot be claimed right now.',
      availability.detail,
    );
  }

  const cost = aliasCostAtomicNight(label);
  const state = await currentWalletState(wallet);
  const night = state.unshielded.balances[String(nativeToken().raw)] ?? 0n;
  if (night < cost) {
    throw new AliasClaimError(
      'insufficient-night',
      `Registering ${aliasDomain(label)} costs ${formatNight(cost)} NIGHT, and this wallet holds ${formatNight(night)}.`,
    );
  }
  // Same rule as `checkAliasClaimFunds`: only a sponsor that has really told us
  // it can pay lets a dustless wallet through. If the sponsor then fails
  // mid-claim, `balanceTx` falls back to local DUST and the SDK's own
  // insufficient-funds error surfaces as `deploy-failed` / `register-rejected`
  // with the real reason attached.
  if ((await sponsorReadiness()).state !== 'ready') {
    const dust = state.dust.balance(new Date());
    if (dust <= 0n) {
      throw new AliasClaimError(
        'insufficient-dust',
        'This wallet has no DUST, so it cannot pay the transaction fee yet. DUST accrues while NIGHT is held.',
      );
    }
  }

  const ownerSecretHex = bytesToHex(ownerSecret);
  const ownerKey = await deriveMidnamesOwnerKey(ownerSecret);
  const privateStateId = `passport-midnames-${label}`;
  const [providers, compiledContract, { AddressType }] = await Promise.all([
    createMidnamesProviders(wallet, ownerSecretHex, privateStateId),
    compiledLeafContract(ownerSecretHex),
    loadMidnames(),
  ]);
  const { deployContract, findDeployedContract } = await import(
    '@midnight-ntwrk/midnight-js-contracts'
  );

  const tldAddress = MIDNAMES_TLD_ADDRESSES[network];
  const targetBytes = unshieldedAddressBytes(wallet);
  const { key: labelKey, len } = domainToKey(label);

  onProgress?.({ phase: 'deploying-resolver' });
  let resolverAddress: string;
  let resolverDeployTxId: string;
  try {
    const deployed = await deployContract(providers as never, {
      compiledContract,
      privateStateId,
      initialPrivateState: { secretKey: ownerSecretHex },
      args: [
        maybeBytes(domainToKey(MIDNAMES_TLD).key),
        { bytes: contractAddressBytes(tldAddress) },
        [targetBytes, AddressType.UnshieldedAddr],
        maybeBytes(labelKey),
        nativeColourBytes(),
        0n,
        0n,
        0n,
        maybeString(),
        false,
        ownerKey,
        { bytes: targetBytes },
        emptyKvs(),
      ],
    } as never);
    const deployTxData = (deployed as { deployTxData: unknown }).deployTxData as {
      public: { contractAddress: string };
    };
    resolverAddress = rawContractAddress(deployTxData.public.contractAddress);
    resolverDeployTxId = transactionId(deployTxData);
  } catch (cause) {
    throw new AliasClaimError(
      'deploy-failed',
      `The resolver contract for ${aliasDomain(label)} could not be deployed.`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  onProgress?.({ phase: 'registering' });
  let registerTxId: string;
  try {
    const tld = await findDeployedContract(providers as never, {
      compiledContract,
      contractAddress: tldAddress,
      privateStateId,
      initialPrivateState: { secretKey: ownerSecretHex },
    } as never);
    const callTx = (tld as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> })
      .callTx;
    const registration = await callTx.register_domain_for(ownerKey, labelKey, len, {
      bytes: contractAddressBytes(resolverAddress),
    });
    registerTxId = transactionId(registration);
  } catch (cause) {
    throw new AliasClaimError(
      'register-rejected',
      `The .night registry rejected the registration of ${aliasDomain(label)}.`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  onProgress?.({ phase: 'confirming' });
  // Swap both identifiers for the block-level hashes explorers resolve; the
  // identifier survives only if the indexer never answers.
  [resolverDeployTxId, registerTxId] = await Promise.all([
    resolveTransactionHash(network, resolverDeployTxId),
    resolveTransactionHash(network, registerTxId),
  ]);
  invalidateAliasRegistry(network);
  let registryConfirmed = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const confirmation = await checkAliasAvailability(network, label, { fresh: true });
    if (confirmation.status === 'taken' && confirmation.resolverAddress === resolverAddress) {
      registryConfirmed = true;
      break;
    }
    await wait(2_000);
  }

  return {
    alias: label,
    domain: aliasDomain(label),
    network,
    tldAddress,
    resolverAddress,
    resolverDeployTxId,
    registerTxId,
    targetUnshieldedAddress: wallet.unshieldedAddress,
    claimedAt: new Date().toISOString(),
    registryConfirmed,
  };
}

/**
 * Alternative labels to offer when a name is taken on the target network.
 * Suggestions are candidates only — the modal probes each one for real before
 * presenting it as free.
 */
export function suggestAliasAlternatives(alias: string): string[] {
  const base = alias.replace(/-+$/, '');
  const candidates = [`${base}2`, `${base}-mn`, `${base}-night`, `my${base}`, `${base}01`];
  return candidates.filter((candidate) => {
    try {
      return normalizePassportAlias(candidate) === candidate;
    } catch {
      return false;
    }
  });
}
