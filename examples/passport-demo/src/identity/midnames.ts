/**
 * Midnames engine — browser edition.
 *
 * A Passport alias IS a Midnames `.night` name. Nothing in this module
 * simulates a registry: availability is decoded from the deployed top-level
 * domain contract's own ledger, and a claim is two real transactions —
 *
 *   1. a resolver "leaf" contract deployed with this Passport's DOMAIN_TARGET —
 *      since 2026/08/19 the account-custody contract's ADDRESS where the caller
 *      supplies one, and the wallet's unshielded address only where it does
 *      not (see {@link AliasResolverTarget}) — and
 *   2. a paid `register_domain_for` call on the shared `.night` TLD, which
 *      pays COST in unshielded NIGHT to the TLD owner and asserts the name is
 *      still free.
 *
 * This is a browser port of the Node integration first proved against preview,
 * with two browser-shaped differences that survive every stack change:
 *
 *   - `node:crypto` is replaced with `crypto.subtle.digest` for the owner-key
 *     hash, so `deriveMidnamesOwnerKey` is async here;
 *   - `node:fs` asset discovery is replaced with the URL form of
 *     `CompiledContract.withCompiledFileAssets`, pointed at `/zk/midnames` and
 *     staged into `public/zk/midnames` by `scripts/prepare-zk-assets.mjs`.
 *
 * ON STAGENET, THE TLD IS OURS (2026/08/24)
 * -----------------------------------------
 * On preview and pre-production the `.night` TLD was somebody else's, already
 * deployed, and the register call simply went through `findDeployedContract`.
 * The Midnames project publishes no stagenet registry, so ours was deployed
 * there with the preview registry's own parameters — see
 * {@link MIDNAMES_TLD_ADDRESSES}. Nothing in the claim path changes as a
 * result: `findDeployedContract` is still how the register call reaches it,
 * and the leaf is still ours to deploy per name.
 *
 * The verifier-key agreement that makes `findDeployedContract` work is now
 * structural rather than a coincidence to re-verify: this app and the harness
 * that deployed the TLD ship the SAME artefacts, from
 * `examples/passport-balancer/contracts-stagenet` (compactc 0.33.0-rc.2). If
 * that ever stops being true the mismatch surfaces as a real failure
 * (`register-rejected`) and the UI queues the name — it is never papered over.
 *
 * NETWORK ID: this module never calls `setNetworkId`. The live wallet owns the
 * process-wide network id, and moving it to read another network's registry
 * would corrupt every address the wallet then encodes. Availability probes
 * therefore go straight to each network's indexer with a raw contract address,
 * which needs no ambient network id at all.
 */

import { nativeToken } from '@midnightntwrk/ledger-v9';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk/address-format';
import * as Rx from 'rxjs';

import type { LocalMidnightWallet } from '../lib/localWallet.js';
import {
  CLAIMABLE_NETWORKS,
  aliasRegistrationSupported,
  faucetAvailable,
} from '../lib/networks.js';
import { sponsorReadiness } from '../lib/sponsor.js';
import {
  bytesToHex,
  contractAddressBytes,
  createContractProviders,
  compiledContractFor,
  feeWitness,
  hexToBytes,
  indexerWsFrom,
  loadContractModule,
  nativeColourBytes,
  rawContractAddress,
  resolveTransactionHash,
  transactionId,
  wait,
} from './contractRuntime.js';

/** Re-exported: every caller that stores an address normalises through this. */
export { rawContractAddress };

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

export type MidnamesNetwork = 'stagenet' | 'preview' | 'preprod' | 'mainnet';

/** The `.night` top-level domain. Every Passport alias is a label under it. */
export const MIDNAMES_TLD = 'night';

/**
 * Midnames TLD addresses, by network.
 *
 * Preview, Pre-production, and mainnet are the production registries shipped by
 * the Midnames SDK's own `NETWORK_REGISTRY`, probed live on 2026/08/05. They
 * remain here so an already-claimed name on one of them can still be READ back
 * and shown; this build cannot register on them, because its ledger cannot
 * speak their protocol (see `../lib/networks.ts`).
 *
 * Stagenet is OURS. The Midnames project publishes no stagenet registry, so the
 * `.night` TLD was deployed on 2026/08/24 by the stagenet deployment harness
 * with the preview registry's own parameters read off chain the same day —
 * `DOMAIN` "night", `COST` 600 / 140 / 10, `BUY_ENABLED` true, no parent — and
 * only the two fields that MUST differ changed: the owner key, and the address
 * `COST` is paid to. It is at block 157797, transaction
 * 49e4c2398a92760a15afbc7d6a89945160c472d85263e339a543bdd81a66e710.
 */
const TLD_OVERRIDE = (import.meta.env ?? {}).VITE_MIDNAMES_TLD_ADDRESS?.trim();

export const MIDNAMES_TLD_ADDRESSES: Record<MidnamesNetwork, string> = {
  /* Demo override: a locally deployed TLD (devnet) can stand in for the
     stagenet registry — env-gated, unset in every public build. */
  stagenet: TLD_OVERRIDE || '29be1e64846cff4600c5297fa54b27d4c9296b3ccc2cdba190eaba1d64c5f116',
  preview: 'e2655a6d554d5d3ceb03dfbee517ad4186d6c287c5e638a29258320dde3e0ba7',
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
     configured indexer (the local one) instead of the public stagenet host. */
  stagenet: TLD_OVERRIDE
    ? ((import.meta.env ?? {}).VITE_INDEXER_URL ??
       'https://indexer.stagenet.shielded.tools/api/v4/graphql')
    : 'https://indexer.stagenet.shielded.tools/api/v4/graphql',
  preview: 'https://indexer.preview.midnight.network/api/v4/graphql',
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
 * The compiled leaf contract, staged from the stagenet build by
 * `scripts/prepare-zk-assets.mjs` so there is one build of it in this
 * repository rather than a copy that can drift. See `./contractRuntime.ts` for
 * why it is staged inside this workspace rather than imported from where it was
 * built.
 */
type MidnamesModule = {
  Contract: new (witnesses: unknown) => unknown;
  ledger: (state: unknown) => MidnamesLedger;
  AddressType: { ContractAddr: number; ZswapCPKAddr: number; UnshieldedAddr: number };
};

export interface MidnamesLedger {
  readonly BUY_ENABLED: boolean;
  readonly COST_SHORT: bigint;
  readonly COST_MED: bigint;
  readonly COST_LONG: bigint;
  /**
   * The leaf's target, as the generated module decodes it:
   * `Either<ContractAddress, Either<ZswapCoinPublicKey, UserAddress>>`.
   * Which of the three it is decides which `bytes` mean anything — see
   * {@link decodeDomainTarget}. Reading `.left.bytes` unconditionally (as this
   * module did until 2026/08/19) reports 32 zero bytes for every
   * wallet-targeted name, because that branch is the CONTRACT one.
   */
  readonly DOMAIN_TARGET: {
    is_left: boolean;
    left: { bytes: Uint8Array };
    right: {
      is_left: boolean;
      left: { bytes: Uint8Array };
      right: { bytes: Uint8Array };
    };
  };
  domains: {
    size(): bigint;
    member(key: Uint8Array): boolean;
    lookup(key: Uint8Array): { resolver: { bytes: Uint8Array } };
  };
}

async function loadMidnames(): Promise<MidnamesModule> {
  return (await loadContractModule('midnames')) as unknown as MidnamesModule;
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
  const provider = indexerPublicDataProvider({
    queryURL: httpUrl,
    subscriptionURL: indexerWsFrom(httpUrl),
  });
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
 * What a resolver leaf points at, decoded from its `DOMAIN_TARGET`.
 *
 * The Compact type is `Either<ContractAddress, Either<ZswapCoinPublicKey,
 * UserAddress>>` — a three-way tagged union flattened into nested `Either`s,
 * built by the leaf's constructor from the `[bytes, AddressType]` pair it is
 * deployed with (`ContractAddr = 0`, `ZswapCPKAddr = 1`, `UnshieldedAddr = 2`;
 * see the generated `contracts/managed/midnames/contract/index.js`). Only the
 * branch the tag selects carries real bytes; the other two are 32 zeros.
 */
export type ResolvedDomainTarget =
  | { kind: 'contract'; hex: string }
  | { kind: 'shielded'; hex: string }
  | { kind: 'wallet'; hex: string };

/** Reads the selected branch of a leaf's `DOMAIN_TARGET`, and only that one. */
export function decodeDomainTarget(
  target: MidnamesLedger['DOMAIN_TARGET'],
): ResolvedDomainTarget {
  if (target.is_left) return { kind: 'contract', hex: bytesToHex(target.left.bytes) };
  if (target.right.is_left) {
    return { kind: 'shielded', hex: bytesToHex(target.right.left.bytes) };
  }
  return { kind: 'wallet', hex: bytesToHex(target.right.right.bytes) };
}

/**
 * Resolves a claimed alias back to what it points at, straight from the
 * registry — the check that proves a claim landed AND that it landed on the
 * right kind of target. Returns null when the name is not registered.
 */
export async function resolveAliasTarget(
  network: MidnamesNetwork,
  alias: string,
): Promise<{ resolverAddress: string; target: ResolvedDomainTarget } | null> {
  const label = normalizePassportAlias(alias);
  const availability = await checkAliasAvailability(network, label, { fresh: true });
  if (availability.status !== 'taken') return null;
  const { indexerPublicDataProvider } = await import(
    '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
  );
  const { ledger } = await loadMidnames();
  const httpUrl = MIDNAMES_INDEXER_URLS[network];
  const provider = indexerPublicDataProvider({
    queryURL: httpUrl,
    subscriptionURL: indexerWsFrom(httpUrl),
  });
  const state = await provider.queryContractState(availability.resolverAddress);
  if (!state) return null;
  const leaf = ledger((state as { data: unknown }).data);
  return {
    resolverAddress: availability.resolverAddress,
    target: decodeDomainTarget(leaf.DOMAIN_TARGET),
  };
}

/* -------------------------------------------------------------------------- */
/* Claiming                                                                   */
/* -------------------------------------------------------------------------- */

export type AliasClaimErrorCode =
  | 'taken'
  /**
   * The account-custody contract this name must bind to could not be
   * deployed. The claim STOPS here — a name is never registered against a
   * wallet address as a silent consolation prize for a failed contract.
   */
  | 'account-contract-failed'
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
   * `activating` and `attaching-account` both belong to the CALLER, not to
   * `claimAlias`: the first covers the activation grant a funder sends an empty
   * wallet, the second covers deploying this Passport's account-custody
   * contract so the name has a contract to bind to. They are named here because
   * the button that narrates a claim narrates all of it — a user watching one
   * action should not be shown a vocabulary that skips two of its steps. The
   * three that follow are this module's own.
   */
  phase:
    | 'activating'
    | 'attaching-account'
    | 'deploying-resolver'
    | 'registering'
    | 'confirming';
}

/**
 * What the resolver leaf this claim deploys will point at.
 *
 * `contract` is the shape Passport ships: the name resolves to this Passport's
 * account-custody contract, so "who is alice.night" and "which account is
 * alice.night" are the same answer. It is expressed in the leaf's constructor
 * as `[address, AddressType.ContractAddr]`, which the generated contract turns
 * into the LEFT branch of `DOMAIN_TARGET` — see {@link decodeDomainTarget}.
 *
 * `wallet` is the pre-2026/08/19 shape, kept because it is what every already
 * registered Passport name carries and because a claim must still be possible
 * (and honest) on a Passport with no contract. Nothing in this module picks
 * between them: the caller says which, so a name can never be bound to a
 * contract address that the caller did not watch land on chain.
 */
export type AliasResolverTarget =
  | { kind: 'contract'; contractAddress: string }
  | { kind: 'wallet' };

export interface AliasClaimResult {
  alias: string;
  domain: string;
  network: string;
  tldAddress: string;
  resolverAddress: string;
  resolverDeployTxId: string;
  registerTxId: string;
  /** This Passport's unshielded address — the leaf's DOMAIN_OWNER, always. */
  targetUnshieldedAddress: string;
  /** Which kind of address the resolver leaf was actually deployed pointing at. */
  resolverTarget: AliasResolverTarget['kind'];
  /**
   * The raw 64-hex bytes that target resolves to: the account-custody contract
   * address for `'contract'`, the unshielded address's 32 target bytes for
   * `'wallet'`. Not a restatement of the request — it is the value that was put
   * into the constructor argument.
   */
  resolverTargetHex: string;
  claimedAt: string;
  /**
   * Whether the WHOLE binding was observed on chain before this resolved: the
   * TLD mapping `<alias>` to this resolver, AND that resolver's own
   * `DOMAIN_TARGET` reporting {@link resolverTargetHex}. Both halves, because
   * a name confirmed to exist but pointing somewhere else is not a confirmed
   * claim. Both transaction ids are real either way; `false` means the indexer
   * had not caught up inside the confirmation window, and the UI says
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

/**
 * The registry's own indexer, which is the one that can map this network's
 * transaction identifiers to ledger hashes. See
 * `./contractRuntime.ts#resolveTransactionHash` for why the mapping is needed
 * at all.
 */
async function resolveRegistryTxHash(
  network: MidnamesNetwork,
  identifier: string,
): Promise<string> {
  return resolveTransactionHash(MIDNAMES_INDEXER_URLS[network], identifier);
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

interface WalletFacadeState {
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
 * Providers for the Midnames circuits.
 *
 * Both claim transactions go through one wallet provider — the resolver
 * `deployContract` and the paid `register_domain_for` call — so sponsoring that
 * one function sponsors the whole registration. Its sponsored and unsponsored
 * balancing paths, and the rule that a covered fee is only ever reported once
 * the service has actually answered, live in `./contractRuntime.ts`.
 *
 * The NIGHT the user pays the registry owner is untouched either way: the
 * sponsor adds a DUST fee input and nothing else, so `COST` still comes out of
 * the caller's own unshielded balance, and the user still signs.
 */
async function createMidnamesProviders(
  wallet: LocalMidnightWallet,
  ownerSecretHex: string,
  privateStateId: string,
  witness: ReturnType<typeof feeWitness>,
) {
  return createContractProviders(wallet, {
    contract: 'midnames',
    privateStateId,
    initialPrivateState: { secretKey: ownerSecretHex },
    witness,
  });
}

async function compiledLeafContract(ownerSecretHex: string) {
  /* The leaf's one witness. It reads the secret out of the private state rather
     than closing over `ownerSecretHex`, so the proof is always over the key the
     provider is actually holding for this claim; the argument is the fall-back
     for a private state that arrived without one. */
  const witnesses = {
    secretKey: ({ privateState }: { privateState: { secretKey: string } }) => [
      privateState,
      hexToBytes(privateState.secretKey ?? ownerSecretHex),
    ],
  };
  return compiledContractFor('midnames', 'passport-midnames-leaf', witnesses);
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
        'This wallet cannot pay the transaction fee yet: fees are normally covered by the fee sponsor, and this wallet holds no DUST of its own.',
    };
  }
  return { ok: true };
}

/**
 * Claims `alias` as `<alias>.night` on whichever network the open wallet is
 * actually on, resolving to whatever `target` names.
 *
 * `target` is REQUIRED and has no default. The caller decides — and can only
 * decide `{ kind: 'contract' }` by holding a contract address the chain gave
 * it — so this function can never quietly bind a name to a wallet address
 * because a contract deploy went missing.
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
  target: AliasResolverTarget,
  onProgress?: (progress: AliasClaimProgress) => void,
): Promise<AliasClaimResult> {
  const label = normalizePassportAlias(alias);
  /* DEMO MOCK, env-gated (VITE_LOCALNET_DEMO=1): the owner's screen-recording
     mode. Stages the phases over ~6 seconds and returns a fabricated success
     with random ids — NO transaction is pushed to any chain. Never set in a
     public build; with the flag unset this branch is dead code and the real
     two-transaction registration below runs unchanged. */
  if (((import.meta.env ?? {}) as Record<string, string | undefined>).VITE_LOCALNET_DEMO === '1') {
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
      network: 'stagenet',
      tldAddress: MIDNAMES_TLD_ADDRESSES.stagenet,
      resolverAddress: fakeId(),
      resolverDeployTxId: fakeId(),
      registerTxId: fakeId(),
      targetUnshieldedAddress: wallet.unshieldedAddress,
      resolverTarget: target.kind,
      resolverTargetHex:
        target.kind === 'contract' ? rawContractAddress(target.contractAddress) : fakeId(),
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
        'This wallet cannot pay the transaction fee yet: fees are normally covered by the fee sponsor, and this wallet holds no DUST of its own.',
      );
    }
  }

  const ownerSecretHex = bytesToHex(ownerSecret);
  const ownerKey = await deriveMidnamesOwnerKey(ownerSecret);
  const privateStateId = `passport-midnames-${label}`;
  const witness = feeWitness();
  const [providers, compiledContract, { AddressType }] = await Promise.all([
    createMidnamesProviders(wallet, ownerSecretHex, privateStateId, witness),
    compiledLeafContract(ownerSecretHex),
    loadMidnames(),
  ]);
  const { deployContract, findDeployedContract } = await import(
    '@midnight-ntwrk/midnight-js-contracts'
  );

  const tldAddress = MIDNAMES_TLD_ADDRESSES[network];
  /* The leaf's OWNER address stays this wallet's, always: `DOMAIN_OWNER` is who
     may later call `set_resolver` / `transfer_domain`, and that authority
     belongs to the passkey wallet whichever way the name resolves. */
  const ownerAddressBytes = unshieldedAddressBytes(wallet);
  /* The leaf's TARGET is what the name RESOLVES to, and is the caller's
     choice. `AddressType.ContractAddr` puts the account-custody contract's
     address in the LEFT branch of `DOMAIN_TARGET`; `UnshieldedAddr` puts the
     wallet's 32 target bytes in the innermost RIGHT branch. Both are real
     constructor arguments to a contract we deploy ourselves — the deployed
     `.night` TLD is never asked to represent either, it only records which
     leaf address a name points at. */
  const [targetBytes, targetType] =
    target.kind === 'contract'
      ? ([contractAddressBytes(target.contractAddress), AddressType.ContractAddr] as const)
      : ([ownerAddressBytes, AddressType.UnshieldedAddr] as const);
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
        [targetBytes, targetType],
        maybeBytes(labelKey),
        nativeColourBytes(),
        0n,
        0n,
        0n,
        maybeString(),
        false,
        ownerKey,
        { bytes: ownerAddressBytes },
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
    resolveRegistryTxHash(network, resolverDeployTxId),
    resolveRegistryTxHash(network, registerTxId),
  ]);
  invalidateAliasRegistry(network);
  const expectedTargetHex = bytesToHex(targetBytes);
  let registryConfirmed = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const confirmation = await checkAliasAvailability(network, label, { fresh: true });
    if (confirmation.status === 'taken' && confirmation.resolverAddress === resolverAddress) {
      /* The name is in the registry. The decisive question is what it points
         at, so the leaf is read back too — the same decode any resolver would
         run. A mismatch is not "not yet": it leaves `registryConfirmed` false
         rather than asserting a binding we did not observe. */
      let resolved: Awaited<ReturnType<typeof resolveAliasTarget>> = null;
      try {
        resolved = await resolveAliasTarget(network, label);
      } catch {
        /* An indexer hiccup during the read-back is not a verdict on the
           registration. The transaction has already landed — refusing the
           claim here would report a failure for a name that is genuinely in
           the registry, purely because one query out of thirty did not
           answer. So a throw means only "not confirmed on THIS attempt": the
           loop waits and asks again, exactly as it does for a leaf that has
           not caught up yet, and if every attempt is spent the caller gets
           `registryConfirmed: false` — the same honest "landed, not yet
           verified" the lag path returns. */
        resolved = null;
      }
      const expectedKind = target.kind === 'contract' ? 'contract' : 'wallet';
      if (
        resolved &&
        resolved.target.kind === expectedKind &&
        resolved.target.hex === expectedTargetHex
      ) {
        registryConfirmed = true;
        break;
      }
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
    resolverTarget: target.kind,
    resolverTargetHex: bytesToHex(targetBytes),
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
