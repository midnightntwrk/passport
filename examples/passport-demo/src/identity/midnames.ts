/**
 * Midnames engine — browser edition, READ SIDE.
 *
 * A Passport alias IS a Midnames `.night` name. Nothing in this module
 * simulates a registry: availability is decoded from the deployed top-level
 * domain contract's own ledger, and a name's target is decoded from the
 * resolver leaf that name points at.
 *
 * WHAT LEFT, AND WHY (2026/08/25)
 * ------------------------------
 * The self-paid `claimAlias` — a resolver-leaf deploy plus a paid
 * `register_domain_for`, both signed and funded by the passkey wallet — is
 * gone, along with the funds gate in front of it and its screen-recording
 * mock. Under the account ruling the wallet originates exactly one transaction
 * in its life, the account-custody deploy; a name it bought would be a second.
 * Registration now happens ONE way: the Passport service registers the name
 * for the user, from its own NIGHT, against the user's own Midnames owner key
 * and account contract (`./sponsoredAlias.ts`). With no service on offer the
 * name QUEUES — the wallet is never asked to buy it.
 *
 * What survives here is everything a sponsored claim and a resolver lookup
 * genuinely need: the registry snapshot and its availability probe, the
 * `DOMAIN_TARGET` decoder, the owner-key derivation the service is handed, the
 * published price table, and the naming rules.
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
 * deployed. The Midnames project publishes no stagenet registry, so ours was
 * deployed there with the preview registry's own parameters — see
 * {@link MIDNAMES_TLD_ADDRESSES}. Both the service's register call and this
 * module's reads address it exactly as they addressed a foreign one.
 *
 * The verifier-key agreement that makes the service's `findDeployedContract`
 * work is structural rather than a coincidence to re-verify: this app, the
 * service, and the harness that deployed the TLD ship the SAME artefacts, from
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

import { CLAIMABLE_NETWORKS, aliasRegistrationSupported } from '../lib/networks.js';
import {
  bytesToHex,
  indexerWsFrom,
  loadContractModule,
  rawContractAddress,
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
    /* The wording is the name step's own footnote, verbatim. This sentence is
       shown to the user, so it says "name" — the word the whole screen uses —
       rather than "alias", which is only what this module happens to call the
       label internally. */
    throw new Error(
      'Names are 1–32 characters: lowercase letters, numbers, and hyphens inside.',
    );
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

/**
 * Every way a claim can fail, and there is no longer a funding one among them.
 *
 * `insufficient-night` and `insufficient-dust` were the self-paid claim's
 * refusals; nothing has consulted the wallet's balance for a name since
 * 2026/08/25, so a code for "you cannot afford this" would name a state the
 * app cannot reach. A service that will not register right now is
 * `register-rejected` or `network-unreachable`, and the name queues.
 */
export type AliasClaimErrorCode =
  | 'taken'
  /**
   * The account-custody contract this name must bind to could not be
   * deployed. The claim STOPS here — a name is never registered against a
   * wallet address as a silent consolation prize for a failed contract.
   */
  | 'account-contract-failed'
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
   * The phases a claim really has, in the order they happen.
   *
   * `attaching-account` belongs to the CALLER rather than to this module: it
   * covers deploying this Passport's account-custody contract so the name has a
   * contract to bind to. It is named here because the button that narrates a
   * claim narrates all of it — a user watching one action should not be shown a
   * vocabulary that skips its longest step.
   *
   * There is no `activating` phase. It described a NIGHT grant sent to the
   * wallet address before a claim, and the wallet neither receives nor spends
   * anything for a name; the service registers it and, once the account exists,
   * funds the ACCOUNT (ruled 2026/08/25).
   *
   * `checking`, `preparing`, and `confirm-passkey` were added on 2026/08/26,
   * and they are the three that happen BEFORE the passkey prompt: re-reading
   * the registry, waiting on the sponsor's answer, and the ceremony itself.
   * They exist because a reviewer watched a claim sit on one unchanging label
   * for the whole of that stretch and could not tell a slow network from a
   * hung app. A phase vocabulary that starts at the account deploy describes
   * the part of a claim the user was never confused by.
   */
  phase:
    | 'checking'
    | 'preparing'
    | 'confirm-passkey'
    | 'attaching-account'
    | 'deploying-resolver'
    | 'registering'
    | 'confirming';
}

/**
 * What a resolver leaf points at.
 *
 * `contract` is the only shape Passport registers: the name resolves to this
 * Passport's account-custody contract, so "who is alice.night" and "which
 * account is alice.night" are the same answer. It sits in the LEFT branch of
 * the leaf's `DOMAIN_TARGET` — see {@link decodeDomainTarget}.
 *
 * `wallet` is the pre-2026/08/19 shape. Nothing writes it any more; it is kept
 * because it is what an already registered Passport name may carry, and a
 * resolver read has to be able to say so honestly rather than misreporting an
 * old name as pointing at an account.
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
