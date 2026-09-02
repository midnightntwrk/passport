/**
 * Sponsored `.night` registration on stagenet — the balancer registers a name
 * FOR a user and pays for all of it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The migrated PWA can deploy its account-custody contract on stagenet with
 * sponsored fees, and then it stops. `register_domain_for` makes the CALLER pay
 * the registry price — 10 atomic NIGHT for a name of five bytes or more — in
 * unshielded NIGHT through `receiveUnshielded`, and a brand-new passkey wallet
 * holds none. Stagenet's faucet is captcha-gated, so "just faucet it" is not a
 * flow a user can be walked through.
 *
 * The deployed TLD does not require any of that. Its registration entrypoint is
 *
 *     register_domain_for(owner, domain, len, resolver)
 *
 * and `owner` is an ARGUMENT, not the caller. The compiled circuit derives the
 * CALLER's public key from the `secretKey` witness, compares it with the TLD's
 * own `DOMAIN_OWNER`, and — when they differ, which for us they always do —
 * asserts `BUY_ENABLED` and takes COST from the caller. It then writes
 * `domains[domain] = { owner, resolver }` and adds the name to
 * `domains_owned[owner]`. So a third party can pay for a name the registry
 * records as belonging to somebody else.
 *
 * This module makes the balancer that third party:
 *
 *   1. it deploys the resolver leaf with `DOMAIN_TARGET = [contractAddress,
 *      AddressType.ContractAddr]` (the user's account-custody contract) and
 *      `DOMAIN_OWNER` = the owner key the caller supplied; then
 *   2. where the caller declared the target still pending, it waits for that
 *      contract to appear on chain — see `awaitTarget`, and the gate in
 *      `./server.ts` that decides when that is allowed; then
 *   3. it calls `register_domain_for` on the network's TLD with that same owner
 *      key, paying COST from the balancer's own NIGHT and the fee from the
 *      balancer's own DUST.
 *
 * The user's wallet signs nothing, spends nothing, and needs to hold nothing.
 * Ownership on the registry is the user's key: only a holder of the secret
 * behind it can later call `set_resolver` or `transfer_domain`.
 *
 * PROVENANCE
 * ----------
 * The policy, the vocabulary, and the confirmation rule are a port of
 * `examples/passport-funder/src/midnames.ts`, which does this on preview. The
 * CONTRACT HANDLING is `deploy-stagenet/src/deploy.mjs`'s, because that is the
 * code with a landed stagenet registration behind it (tx
 * `6fd842da3319c0b445f7527ecfc37e59684a2db5bf68b7f3d4525723870494d0`, block
 * 157865): the thirteen constructor arguments in their order, the four-argument
 * `register_domain_for` call, and the read-back through the registry. Where the
 * funder's v4 API and the beta diverge, this file follows the beta.
 *
 * The pure helpers — label normalisation, the reserved list, the cost table,
 * the owner-key hash, the padded-key encoding — are COPIED from the funder and
 * the PWA rather than imported, and they must stay byte-identical: a label the
 * browser normalises one way and the service another would register a name the
 * user never typed.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { withNodeRejectionRetry } from './account.js';
import type { BalancerConfig } from './config.js';
import {
  CONFIRM_INTERVAL_MS,
  bytesToHex,
  contractAddressBytes,
  contractProviders,
  createContractProofProvider,
  hexToBytes,
  managedBuildPath,
  nativeColourBytes,
  publicDataProviderFor,
  rawContractAddress,
  resolveTransactionHash,
  transactionIdentifier,
  wait,
  type ContractProvingMode,
} from './contractRuntime.js';
import { SpendPriority } from './reservation.js';
import {
  FEE_CAPABLE_SPECKS,
  deployTransactionReference,
  type PooledResolver,
} from './resolverPool.js';
import { isDustShortfall, withDustWait, type BalancerWallet } from './wallet.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** The `.night` top-level domain. Every Passport alias is a label under it. */
export const MIDNAMES_TLD = 'night';

/**
 * Names this service will not sponsor, whatever the registry says. Copied from
 * the funder's list, which is copied from the demo's `RESERVED_ALIASES`: these
 * are infrastructure and impersonation risks, and `midnight.night` reading as
 * an official account is exactly the confusion this list prevents. A sponsored
 * registration makes the risk worse, not better — it removes the only cost an
 * impersonator would have paid.
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

/** Attempts, {@link CONFIRM_INTERVAL_MS} apart, to watch the binding appear. */
const CONFIRM_ATTEMPTS = 180;

/**
 * How long a pending account contract gets to appear before the registration is
 * refused, as attempts times an interval: sixty seconds.
 *
 * Sized against what it is waiting for rather than picked round. The client
 * submits the account deploy and asks for the name within a second; the deploy
 * needs one block (6.000 s, measured over 15 consecutive intervals on
 * 2026/08/31) and then the indexer's own lag (13.2–14.1 s over 16 observations
 * the same day) before this read can answer — around twenty seconds, and the
 * resolver deploy above has already spent more than that. Sixty seconds is
 * therefore three times the expected wait, which is enough for a bad minute on
 * the indexer and short enough that a target which is never coming does not
 * hold the wallet's queue for long.
 *
 * Exceeding it refuses the registration with `target-missing`. The name stays
 * free, the user's client keeps it queued, and the only thing spent is the
 * resolver leaf — which the gate in `./server.ts` accounts for.
 */
const TARGET_ATTEMPTS = 120;
const TARGET_INTERVAL_MS = 500;

/* -------------------------------------------------------------------------- */
/* Pure helpers — copies of the funder's, and they must stay copies           */
/* -------------------------------------------------------------------------- */

/** `alice` -> `alice.night`. */
export function aliasDomain(alias: string): string {
  return `${alias}.${MIDNAMES_TLD}`;
}

/**
 * Normalises a requested alias to its registry label, throwing a sentence the
 * caller can show verbatim.
 *
 * The accepted shape is exactly the demo's and the funder's:
 * `/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/` — 1-32 characters, lowercase
 * letters and digits, hyphens only in the interior — plus the reserved list.
 */
export function normalisePassportAlias(value: string): string {
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
 * The registration cost in atomic NIGHT. Our stagenet TLD was deployed with the
 * preview registry's own COST_SHORT / COST_MED / COST_LONG — 600 / 140 / 10 —
 * so this table is the same one the funder uses. Measured in UTF-8 bytes, as
 * the contract measures it.
 */
export function aliasCostAtomicNight(alias: string): bigint {
  const length = new TextEncoder().encode(alias).length;
  if (length <= 3) return 600n;
  if (length === 4) return 140n;
  return 10n;
}

/**
 * The Midnames key encoding: the UTF-8 label left-aligned in 32 bytes padded
 * with 0xff. Identical to the funder, the browser port, and the deployment
 * harness, byte for byte — `register_domain_for` asserts the padding itself.
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
 * `sha256('midnight.domains' padded to 32 bytes || secret)` — the Midnames
 * owner-key derivation. The service never sees a user's secret; this exists so
 * a caller and this module can be checked against each other, and so a drill
 * can derive the key it posts.
 */
export function deriveMidnamesOwnerKey(secret: Uint8Array): Uint8Array {
  if (secret.length !== 32) {
    throw new Error(`Midnames owner secret must be 32 bytes, received ${secret.length}.`);
  }
  const payload = new Uint8Array(64);
  payload.set(new TextEncoder().encode('midnight.domains'));
  payload.set(secret, 32);
  return new Uint8Array(createHash('sha256').update(payload).digest());
}

/** A 64-hex Midnames owner key, as it arrives over HTTP. */
export function ownerKeyBytes(value: string): Uint8Array {
  const normalized = value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`A Midnames owner key must be 64 hex characters, got: ${value}`);
  }
  return hexToBytes(normalized);
}

/* -------------------------------------------------------------------------- */
/* Contract artefacts                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Where the compiled Midnames build's ZK ARTEFACTS live.
 * `BALANCER_MIDNAMES_ASSETS` overrides the search. See {@link managedBuildPath}
 * for the candidates and the liveness probe.
 */
function midnamesManagedPath(configured?: string): string {
  return managedBuildPath('midnames', {
    configured,
    remedy:
      'The build ships in examples/passport-balancer/contracts-stagenet/managed/midnames; set BALANCER_MIDNAMES_ASSETS to point elsewhere.',
  });
}

interface MidnamesModule {
  Contract: new (witnesses: unknown) => unknown;
  ledger: (state: unknown) => MidnamesLedger;
  AddressType: { ContractAddr: number; ZswapCPKAddr: number; UnshieldedAddr: number };
}

/**
 * The decoded shape this module reads. `DOMAIN_TARGET` is Compact's
 * `Either<ContractAddress, Either<ZswapCoinPublicKey, UserAddress>>`: only the
 * branch the constructor's `AddressType` tag selected carries real bytes, the
 * other two are 32 zeros. Reading `.left.bytes` unconditionally would report
 * zeros for every wallet-targeted name.
 */
export interface MidnamesLedger {
  readonly BUY_ENABLED: boolean;
  readonly COST_SHORT: bigint;
  readonly COST_MED: bigint;
  readonly COST_LONG: bigint;
  readonly DOMAIN_TARGET: {
    is_left: boolean;
    left: { bytes: Uint8Array };
    right: { is_left: boolean; left: { bytes: Uint8Array }; right: { bytes: Uint8Array } };
  };
  domains: {
    size(): bigint;
    member(key: Uint8Array): boolean;
    lookup(key: Uint8Array): { owner: Uint8Array; resolver: { bytes: Uint8Array } };
  };
}

/** What a resolver leaf points at, decoded from its `DOMAIN_TARGET`. */
export type ResolvedDomainTarget =
  | { kind: 'contract'; hex: string }
  | { kind: 'shielded'; hex: string }
  | { kind: 'wallet'; hex: string };

export function decodeDomainTarget(target: MidnamesLedger['DOMAIN_TARGET']): ResolvedDomainTarget {
  if (target.is_left) return { kind: 'contract', hex: bytesToHex(target.left.bytes) };
  if (target.right.is_left) return { kind: 'shielded', hex: bytesToHex(target.right.left.bytes) };
  return { kind: 'wallet', hex: bytesToHex(target.right.right.bytes) };
}

/* Constructor-argument shapes the generated contract expects. */
function maybeBytes(value?: Uint8Array): { is_some: boolean; value: Uint8Array } {
  return value ? { is_some: true, value } : { is_some: false, value: new Uint8Array(32) };
}

function maybeString(value?: string): { is_some: boolean; value: string } {
  return value ? { is_some: true, value } : { is_some: false, value: '' };
}

function emptyKvs() {
  return Array.from({ length: 10 }, () => ({ is_some: false, value: ['', ''] as [string, string] }));
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type AliasSponsorErrorCode =
  /** The label is already in the registry. */
  | 'name-taken'
  /** The registry could not be read, so nothing may be asserted about the name. */
  | 'registry-unreachable'
  /** The resolver leaf could not be deployed; nothing was registered. */
  | 'deploy-failed'
  /** The TLD refused the registration; the leaf is deployed but unnamed. */
  | 'register-rejected'
  /**
   * The name was registered against a pooled leaf, but pointing that leaf at
   * the account contract failed. The name exists and is the user's; it resolves
   * to nothing until the target is set, which is why this is a failure and not
   * a partial success.
   */
  | 'bind-failed'
  /** Both transactions landed, but the registry never showed the binding. */
  | 'confirmation-failed'
  /**
   * The account contract the name was to resolve to never appeared on chain
   * inside the window a pending target is given. The leaf was deployed and is
   * unused; nothing was registered and the name is still free.
   */
  | 'target-missing';

export class AliasSponsorError extends Error {
  constructor(
    readonly code: AliasSponsorErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AliasSponsorError';
  }
}

/* -------------------------------------------------------------------------- */
/* The sponsor                                                                */
/* -------------------------------------------------------------------------- */

export interface AliasRegistrationRequest {
  /** Already normalised through {@link normalisePassportAlias}. */
  label: string;
  /** The 32-byte Midnames owner key this name will belong to. */
  ownerKey: Uint8Array;
  /** Raw 64-hex account-custody contract address the name will resolve to. */
  contractAddress: string;
  /**
   * The owner's own 32 unshielded address bytes, when the caller supplied them.
   *
   * This becomes the leaf's `owner_address` half of `DOMAIN_OWNER`, which is
   * where a payment made TO the leaf would be sent. It is not the registry's
   * authority — `owner_pubkey` is, and that is always {@link ownerKey}. A
   * caller that does not send one gets 32 zero bytes, which is honest: the
   * balancer does not know the user's wallet address and must not substitute
   * its own, or a payment meant for the user would land on the balancer.
   */
  ownerAddressBytes?: Uint8Array;
  /**
   * Wait for {@link contractAddress} to appear on chain before calling
   * `register_domain_for`, rather than requiring it to be there already.
   *
   * Set by the server when its fourth gate found no state at the address AND
   * the client declared the deploy pending. It does not weaken the rule that a
   * name is never bound to a contract that does not exist — it moves where that
   * rule is enforced, from before the request to after the resolver leaf, which
   * is several proofs and at least one block later. See the gate itself in
   * `./server.ts` for the anti-spam reasoning and for what a target that never
   * appears costs.
   */
  awaitTarget?: boolean;
  /**
   * A leaf THIS registration already deployed on an earlier attempt.
   *
   * Not the same thing as {@link pooledResolver}, and the difference is
   * ownership. A pooled leaf is unbound and owned by this SERVICE, so binding
   * it takes `update_domain_target` and hands it over with `change_owner`. A
   * leaf deployed for this request is already built with this name's key, this
   * account as its target, and the USER as its owner — this service could not
   * call `update_domain_target` on it if it wanted to. All that is left for it
   * is `register_domain_for`.
   *
   * It exists because a registration that ran out of DUST between its two legs
   * used to throw the leaf away: the wait outside would rebuild from the top,
   * deploy a SECOND leaf, and so need two fee-capable coins where it needed
   * one. Measured on the live run at 20:39 on 2026/09/02 — two waits, 55 s then
   * 132 s, and a wasted leaf between them. See
   * {@link AliasRegistrationRequest.onResolverDeployed}, which is how a caller
   * gets hold of the address to send back.
   */
  deployedResolver?: { address: string; deployTx: string };
  /**
   * Called the moment a fresh leaf is on chain, before anything that could
   * fail after it. A caller that retries passes what it is given here back as
   * {@link deployedResolver}.
   */
  onResolverDeployed?: (leaf: { address: string; deployTx: string }) => void;
  /**
   * A leaf the sponsor deployed earlier and is holding for whoever asks next.
   *
   * When present the registration SKIPS its own deploy and binds this one
   * instead: `update_domain_target` on the leaf and `register_domain_for` on
   * the TLD, which do not depend on each other and therefore run together, and
   * `change_owner` afterwards to hand the leaf to the user. When absent the
   * path is exactly the one this service has always taken — deploy, then
   * register — so an empty shelf costs a user nothing but the wait they would
   * have had anyway. See `./resolverPool.ts`.
   */
  pooledResolver?: PooledResolver;
}

export interface AliasRegistration {
  alias: string;
  domain: string;
  network: string;
  tldAddress: string;
  resolverAddress: string;
  /** 64-hex ledger hash where the indexer resolved it, the identifier if not. */
  resolverDeployTx: string;
  registerTx: string;
  /** The blocks those two landed in, when the indexer knew them. */
  resolverDeployBlock: number | null;
  registerBlock: number | null;
  target: { kind: 'contract'; address: string };
  ownerKey: string;
  costAtomic: bigint;
  registeredAt: string;
  /** Whether the leaf came off the shelf or was deployed for this request. */
  fromPool: boolean;
}

export interface MidnamesSponsor {
  /** The TLD this service registers against. */
  readonly tldAddress: string;
  /**
   * The sponsor's OWN Midnames owner key — 32 bytes derived from the same
   * caller secret `register_domain_for` is paid under.
   *
   * A pooled leaf is deployed owned by this key, because a leaf nobody owns
   * cannot have its target set, and the user whose name it will carry is not
   * known yet. `change_owner` hands it over once the name is confirmed.
   */
  readonly poolOwnerKey: Uint8Array;
  /** Where the compiled build was found, for the start-up log. */
  readonly assetsPath: string;
  /** How contract circuits are proved — `'wasm'` needs no proof server. */
  readonly provingMode: ContractProvingMode;
  /** Is the label free right now? Reads the deployed registry, never a cache. */
  isAvailable(label: string): Promise<boolean>;
  /** Does the indexer serve contract state at this address? */
  contractExists(address: string): Promise<boolean>;
  /** What the name resolves to right now, or null when it is not registered. */
  resolve(label: string): Promise<{ resolverAddress: string; target: ResolvedDomainTarget } | null>;
  /**
   * Deploys the leaf, waits for the target where the caller asked it to, calls
   * `register_domain_for`, and reads the binding back. Resolves only when the
   * registry really reports the requested contract address.
   *
   * MUST be called inside `wallet.exclusive(...)`: it spends the balancer's
   * coins twice and would otherwise contend with a fee-sponsorship request.
   */
  register(request: AliasRegistrationRequest): Promise<AliasRegistration>;
  /**
   * Deploys ONE unbound resolver leaf for the shelf: no domain, a zero target,
   * and {@link poolOwnerKey} as its owner.
   *
   * MUST be called inside `wallet.exclusive(...)`, and only when the filler's
   * gate in `./resolverPool.ts` says every one of its preconditions holds —
   * this spends a fee-capable DUST coin and it is never a user's turn.
   */
  deployPoolLeaf(): Promise<{ address: string; deployTx: string; deployBlock: number | null }>;
}

/**
 * What became of a pooled registration's two legs.
 *
 * A result rather than an exception for the two legs' own failures, so the
 * caller can word each one for the person reading it. A DUST shortfall on the
 * REGISTER leg is the exception to that and is thrown: nothing was registered,
 * the caller's `withDustWait` is what has the budget to wait for a coin, and
 * rebuilding the whole registration is exactly the right thing to do.
 */
export type PooledLegOutcome<T> =
  | { kind: 'registered'; registerTx: T }
  | { kind: 'register-rejected'; cause: unknown }
  | { kind: 'bind-rejected'; registerTx: T; cause: unknown };

/**
 * Runs a pooled registration's register and bind legs — TOGETHER OR IN TURN.
 *
 * Together needs a fee-capable DUST coin for each of them, and nothing else:
 * neither leg reads the other's result, because the registry stores the leaf's
 * ADDRESS and never looks inside it while the leaf's target is its own state.
 *
 * With one coin free they must not both start. Two jobs against one coin is one
 * job plus one that spends fifteen seconds balancing before it fails and then
 * waits out the coin the first is spending — 22 s and 45 s of a 157-second
 * registration, measured on the deployed service on 2026/09/02 — and it is a
 * race this path can simply decline to enter. The register leg goes first,
 * because a bind against a name nobody registered is wasted either way.
 *
 * The bind's own failure is NEVER rethrown, whatever it was. By then the name
 * is registered, and handing a DUST shortfall back to a wait that rebuilds the
 * whole registration would send the caller to register a name it already owns.
 * `bindLeg` is expected to carry its own bounded wait for a coin; this is the
 * guard that holds even if it stops doing so.
 */
export async function runPooledLegs<T>(
  lanes: number,
  registerLeg: () => Promise<T>,
  bindLeg: () => Promise<unknown>,
): Promise<PooledLegOutcome<T>> {
  if (lanes >= 2) {
    /* `allSettled` rather than `all`: `all` rejects on the first failure and
       leaves the other leg's rejection unhandled, which on Node is a warning
       today and a killed process on a future default. */
    const [bind, registration] = await Promise.allSettled([bindLeg(), registerLeg()]);
    if (registration.status === 'rejected') {
      if (isDustShortfall(registration.reason)) throw registration.reason;
      return { kind: 'register-rejected', cause: registration.reason };
    }
    if (bind.status === 'rejected') {
      return { kind: 'bind-rejected', registerTx: registration.value, cause: bind.reason };
    }
    return { kind: 'registered', registerTx: registration.value };
  }
  let registerTx: T;
  try {
    registerTx = await registerLeg();
  } catch (cause) {
    if (isDustShortfall(cause)) throw cause;
    return { kind: 'register-rejected', cause };
  }
  try {
    await bindLeg();
  } catch (cause) {
    return { kind: 'bind-rejected', registerTx, cause };
  }
  return { kind: 'registered', registerTx };
}

/**
 * Builds the sponsor. Loading the compiled contract here rather than per
 * request means a broken or missing artefact set fails at start-up, where an
 * operator sees it, instead of on a user's first alias.
 */
export async function createMidnamesSponsor(
  config: BalancerConfig,
  wallet: BalancerWallet,
): Promise<MidnamesSponsor> {
  if (!config.midnamesTldAddress) {
    throw new Error('No .night registry is configured, so names cannot be sponsored.');
  }
  const managedPath = midnamesManagedPath(config.midnamesAssetsPath);
  /**
   * A LITERAL relative specifier, not a path computed from `managedPath`.
   *
   * That is not a style preference, it is the difference between working and
   * not. `contracts-stagenet` carries its own `node_modules`, so a runtime
   * `import()` of an absolute path inside that tree makes Node resolve
   * `@midnight-ntwrk/compact-runtime` from THERE, while the indexer provider
   * next to it resolves the copy this service declares. Two copies means two
   * `ChargedState` classes, and decoding a contract state dies on
   * `expected instance of ChargedState`. A literal specifier is bundled by
   * esbuild into this service, so there is exactly one runtime in play — the
   * same reasoning the funder records on its own import.
   */
  const midnames = (await import(
    '../contracts-stagenet/managed/midnames/contract/index.js'
  )) as unknown as MidnamesModule;
  const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
  const { NodeZkConfigProvider } = await import(
    '@midnight-ntwrk/midnight-js-node-zk-config-provider'
  );
  const { deployContract, findDeployedContract } = await import(
    '@midnight-ntwrk/midnight-js-contracts'
  );

  const tldAddress = rawContractAddress(config.midnamesTldAddress);

  /**
   * The balancer's caller identity inside the circuits.
   *
   * `register_domain_for` derives the caller's public key from this witness and
   * compares it with the TLD's own owner: matching would register the name for
   * free, differing takes COST. This secret is deliberately NOT the one
   * `deploy-stagenet` used for the TLD's `DOMAIN_OWNER`, so a registration
   * through our own instance pays exactly as it would through the Midnames
   * team's. Deriving it from the balancer seed rather than randomising keeps one
   * stable caller identity across restarts; the bytes never leave this process
   * and are not the user's anything.
   */
  const callerSecret = new Uint8Array(
    createHash('sha256')
      .update('midnight.passport.stagenet.midnames.caller')
      .update(Buffer.from(config.seedHex, 'hex'))
      .digest(),
  );
  const callerSecretHex = bytesToHex(callerSecret);

  const zkConfigProvider = new NodeZkConfigProvider(managedPath);
  const { mode: provingMode, proofProvider } = await createContractProofProvider(
    config,
    zkConfigProvider as never,
  );

  const reader = await publicDataProviderFor(config);

  const readLedger = async (address: string): Promise<MidnamesLedger | null> => {
    const state = await reader.queryContractState(address);
    if (!state) return null;
    return midnames.ledger((state as { data: unknown }).data);
  };

  const compiledContract = CompiledContract.make(
    'passport-midnames-leaf',
    midnames.Contract as never,
  ).pipe(
    CompiledContract.withWitnesses({
      secretKey: ({ privateState }: { privateState: { secretKey: string } }) => [
        privateState,
        hexToBytes(privateState.secretKey ?? callerSecretHex),
      ],
    } as never),
    CompiledContract.withCompiledFileAssets(managedPath),
  );

  /**
   * The sponsor's own owner key, and the identity a pooled leaf is deployed
   * under. `derive_public_key` inside the circuits is this same hash, which is
   * why `update_domain_target` and `change_owner` on a pooled leaf accept the
   * `secretKey` witness this module already carries.
   */
  const sponsorOwnerKey = deriveMidnamesOwnerKey(callerSecret);

  /**
   * The catch-up wait inside `withNodeRejectionRetry`, spent off the lane.
   *
   * Re-entered at `Registration`, because that is what every leg here is a leg
   * of: a job that gave its lane back to a poll must not then queue behind the
   * grants it let past. See `yieldLane` in `./reservation.ts`.
   */
  const yieldSpendLane = <T>(work: () => Promise<T>): Promise<T> =>
    wallet.yieldLane(work, SpendPriority.Registration);

  const zeroBytes = (): Uint8Array => new Uint8Array(32);

  /**
   * `DOMAIN_TARGET` as `update_domain_target` takes it: the full nested
   * `Either`, contract branch selected. The two unselected branches carry 32
   * zeros — the same convention the constructor's `AddressType` tag produces,
   * and the one {@link decodeDomainTarget} reads back.
   */
  const contractTargetEither = (
    bytes: Uint8Array,
  ): {
    is_left: boolean;
    left: { bytes: Uint8Array };
    right: { is_left: boolean; left: { bytes: Uint8Array }; right: { bytes: Uint8Array } };
  } => ({
    is_left: true,
    left: { bytes },
    right: { is_left: true, left: { bytes: zeroBytes() }, right: { bytes: zeroBytes() } },
  });

  /**
   * The thirteen constructor arguments, in `deploy.mjs`'s order — the order the
   * leaf behind `passport-771a3f.night` was deployed with. `cost_*` are zero and
   * `buy_enabled` is false because a LEAF sells nothing; only the TLD does.
   *
   * Shared by both paths deliberately. A pooled leaf and a per-request leaf
   * differ in exactly three arguments — target, domain, and owner — and writing
   * the list twice is how those three quietly become four.
   */
  const leafArgs = (fields: {
    targetBytes: Uint8Array;
    domainKey?: Uint8Array;
    ownerKey: Uint8Array;
    ownerAddressBytes?: Uint8Array;
  }): unknown[] => [
    maybeBytes(domainToKey(MIDNAMES_TLD).key),
    { bytes: contractAddressBytes(tldAddress) },
    [fields.targetBytes, midnames.AddressType.ContractAddr],
    maybeBytes(fields.domainKey),
    nativeColourBytes(),
    0n,
    0n,
    0n,
    maybeString(),
    false,
    fields.ownerKey,
    { bytes: fields.ownerAddressBytes ?? zeroBytes() },
    emptyKvs(),
  ];

  /**
   * Has this wallet caught up with the chain that refused a transaction?
   * `isSynced` and `dust.complete` together, for the reason
   * `withNodeRejectionRetry` sets out: the rejection is about the DUST the
   * balancing selected.
   */
  const caughtUp = async (): Promise<boolean> => {
    const walked = await wallet.progress();
    return walked.isSynced && walked.dust.complete;
  };

  const isAvailable = async (label: string): Promise<boolean> => {
    const registry = await readLedger(tldAddress);
    if (!registry) {
      throw new AliasSponsorError(
        'registry-unreachable',
        `The ${config.networkId} .night registry (${tldAddress.slice(0, 10)}…) returned no state, so availability cannot be established.`,
      );
    }
    return !registry.domains.member(domainToKey(label).key);
  };

  const resolveAlias = async (
    label: string,
  ): Promise<{ resolverAddress: string; target: ResolvedDomainTarget } | null> => {
    const registry = await readLedger(tldAddress);
    if (!registry) return null;
    const { key } = domainToKey(label);
    if (!registry.domains.member(key)) return null;
    const resolverAddress = rawContractAddress(
      bytesToHex(registry.domains.lookup(key).resolver.bytes),
    );
    const leaf = await readLedger(resolverAddress);
    if (!leaf) return null;
    return { resolverAddress, target: decodeDomainTarget(leaf.DOMAIN_TARGET) };
  };

  return {
    tldAddress,
    assetsPath: managedPath,
    provingMode,

    isAvailable,

    async contractExists(address: string): Promise<boolean> {
      return Boolean(await reader.queryContractState(rawContractAddress(address)));
    },

    resolve: resolveAlias,

    poolOwnerKey: sponsorOwnerKey,

    async deployPoolLeaf(): Promise<{ address: string; deployTx: string; deployBlock: number | null }> {
      /* ONE private-state id for every pooled leaf, not one per leaf. The
         private state here is a single constant — the caller secret — so a
         fresh id per deploy would grow the store without ever holding anything
         two leaves did not share. */
      const privateStateId = 'passport-balancer-resolver-pool';
      const providers = await contractProviders(config, {
        privateStateId,
        initialPrivateState: { secretKey: callerSecretHex },
        zkConfigProvider: zkConfigProvider as never,
        proofProvider,
        walletProvider: wallet.contractWalletProvider(),
      });
      /* An unbound leaf: no domain, a zero target, owned by this service. All
         three are settable or bindable later — `DOMAIN` is sealed but is never
         read by `register_domain_for`, which keys the registry on the label it
         is given and stores only `{ owner, resolver }`. */
      const deployed = await withNodeRejectionRetry(
        () =>
          deployContract(providers as never, {
            compiledContract,
            privateStateId,
            initialPrivateState: { secretKey: callerSecretHex },
            args: leafArgs({ targetBytes: zeroBytes(), ownerKey: sponsorOwnerKey }),
          } as never),
        { label: 'resolver leaf for the pool', synced: caughtUp, outsideLane: yieldSpendLane },
      );
      const deployTxData = (deployed as { deployTxData: unknown }).deployTxData as {
        public: { contractAddress: string };
      };
      const address = rawContractAddress(deployTxData.public.contractAddress);
      const identifier = transactionIdentifier(deployTxData);
      const resolved = await resolveTransactionHash(config.indexerHttpUrl, identifier);
      return { address, deployTx: resolved.hash, deployBlock: resolved.block };
    },

    async register(request: AliasRegistrationRequest): Promise<AliasRegistration> {
      const label = request.label;
      const contractAddress = rawContractAddress(request.contractAddress);
      const { key: labelKey, len } = domainToKey(label);
      const privateStateId = `passport-balancer-midnames-${label}`;
      const providers = await contractProviders(config, {
        privateStateId,
        initialPrivateState: { secretKey: callerSecretHex },
        zkConfigProvider: zkConfigProvider as never,
        proofProvider,
        walletProvider: wallet.contractWalletProvider(),
      });

      /* The leaf's TARGET is the user's account-custody contract:
         `AddressType.ContractAddr` puts those 32 bytes in the LEFT branch of
         `DOMAIN_TARGET`, which is what `decodeDomainTarget` reads back as
         `kind: 'contract'`. Nothing here can silently fall back to a wallet
         address — the caller supplies a contract address or the request was
         already refused. */
      const targetBytes = contractAddressBytes(contractAddress);

      const pooled = request.pooledResolver;

      let resolverAddress: string;
      let resolverDeployTx: string;
      const alreadyDeployed = request.deployedResolver;
      if (alreadyDeployed) {
        /* This registration's OWN leaf, from an attempt that ran out of DUST
           before it could register. It already carries this name's key, this
           target, and the user as its owner, so the deploy below is skipped and
           the binding legs are skipped with it — `register_domain_for` is all
           that was ever left. */
        resolverAddress = rawContractAddress(alreadyDeployed.address);
        resolverDeployTx = alreadyDeployed.deployTx;
      } else if (pooled) {
        /* Already on chain, already paid for, already owned by this service.
           The whole of the deploy below happened minutes or hours ago in a
           quiet gap — see `./resolverPool.ts` for the gate that found one. */
        resolverAddress = rawContractAddress(pooled.address);
        resolverDeployTx = pooled.deployTx;
      } else {
        try {
          /* Thirteen arguments, in `deploy.mjs`'s order — the order the leaf
             that backs `passport-771a3f.night` was deployed with. */
          const deployed = await withNodeRejectionRetry(
            () => deployContract(providers as never, {
            compiledContract,
            privateStateId,
            initialPrivateState: { secretKey: callerSecretHex },
            args: leafArgs({
              targetBytes,
              domainKey: labelKey,
              ownerKey: request.ownerKey,
              ...(request.ownerAddressBytes
                ? { ownerAddressBytes: request.ownerAddressBytes }
                : {}),
            }),
            } as never),
            /* A refused leaf deploy is the worst of the rejections to give up on:
               it is the FIRST of the name path's two dependent proofs, and the
               client's answer to a 502 here is to start the whole registration
               again. Rebuilt once the wallet is current instead. */
            { label: `resolver deploy for ${aliasDomain(label)}`, synced: caughtUp, outsideLane: yieldSpendLane },
          );
          const deployTxData = (deployed as { deployTxData: unknown }).deployTxData as {
            public: { contractAddress: string };
          };
          resolverAddress = rawContractAddress(deployTxData.public.contractAddress);
          resolverDeployTx = transactionIdentifier(deployTxData);
          /* Announced before anything downstream can fail, so a caller that
             waits for a coin and asks again does not pay for a second leaf. */
          request.onResolverDeployed?.({ address: resolverAddress, deployTx: resolverDeployTx });
        } catch (cause) {
          /* A DUST shortfall is NOT the registry refusing anything, and must
             not be dressed up as one. It travels out untouched so `./server.ts`
             can wait for a coin and rebuild — and so the sentence a user is
             shown stops saying the registry rejected their name when what
             happened is that this service had no coin free. Nothing has landed
             at this point, so the rebuild is clean. */
          if (isDustShortfall(cause)) throw cause;
          throw new AliasSponsorError(
            'deploy-failed',
            `The resolver contract for ${aliasDomain(label)} could not be deployed, so nothing was registered.`,
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      }

      /* THE TARGET GATE, ASKED HERE RATHER THAN AT THE DOOR. By now the leaf
         has been built, proved, balanced, signed, submitted, and — because
         `deployContract` waits on the indexer — served back, which on stagenet
         is a block plus the indexer's own 13.2–14.1 s. A client that submitted
         its account deploy just before asking will have had all of that to
         land. Nothing is registered until this passes; the only thing the
         earlier gate bought that this does not is the resolver deploy above,
         and the ceilings around this call are what cap that. */
      if (request.awaitTarget) {
        let appeared = false;
        for (let attempt = 0; attempt < TARGET_ATTEMPTS && !appeared; attempt += 1) {
          if (attempt > 0) await wait(TARGET_INTERVAL_MS);
          try {
            appeared = Boolean(await reader.queryContractState(contractAddress));
          } catch {
            // Indexer lag or a transient failure; asked again below.
          }
        }
        if (!appeared) {
          throw new AliasSponsorError(
            'target-missing',
            `No contract state is served at ${contractAddress}, so there is nothing for ${aliasDomain(label)} to resolve to. The account contract was reported as being deployed, but it has not appeared.`,
            `resolver ${resolverAddress} was deployed and is unused; deploy ${resolverDeployTx}`,
          );
        }
      }

      /* And the second of the two. A rejection here leaves a deployed,
         unregistered resolver behind, so it is worth a rebuild rather than a
         refusal — the alternative costs the user their name and this service
         the fee it already paid for the leaf. */
      const registerLeg = (): Promise<string> =>
        withNodeRejectionRetry(
          async () => {
            const tld = await findDeployedContract(providers as never, {
              compiledContract,
              contractAddress: tldAddress,
              privateStateId,
              initialPrivateState: { secretKey: callerSecretHex },
            } as never);
            const callTx = (
              tld as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> }
            ).callTx;
            /* The paid call. `request.ownerKey` — the USER's key — is argument
               one, so the registry records the user as owner while the
               balancer's own NIGHT covers COST and the balancer's own DUST
               covers the fee. */
            const registration = await callTx.register_domain_for(request.ownerKey, labelKey, len, {
              bytes: contractAddressBytes(resolverAddress),
            });
            return transactionIdentifier(registration);
          },
          { label: `register_domain_for ${aliasDomain(label)}`, synced: caughtUp, outsideLane: yieldSpendLane },
        );

      /**
       * The pooled leaf's own half: point it at this account contract.
       *
       * A SECOND private-state id, and that is load-bearing. This runs at the
       * same time as the registration above, and midnight-js writes the private
       * state of every call it makes; two concurrent calls sharing one id would
       * be two writers on one record. They carry the same secret, so nothing is
       * lost by giving each its own.
       */
      const leafPrivateStateId = `passport-balancer-midnames-${label}-leaf`;
      const targetLeg = async (): Promise<string> => {
        const leafProviders = await contractProviders(config, {
          privateStateId: leafPrivateStateId,
          initialPrivateState: { secretKey: callerSecretHex },
          zkConfigProvider: zkConfigProvider as never,
          proofProvider,
          walletProvider: wallet.contractWalletProvider(),
        });
        return withNodeRejectionRetry(
          async () => {
            const leaf = await findDeployedContract(leafProviders as never, {
              compiledContract,
              contractAddress: resolverAddress,
              privateStateId: leafPrivateStateId,
              initialPrivateState: { secretKey: callerSecretHex },
            } as never);
            const callTx = (
              leaf as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> }
            ).callTx;
            /* Gated on `derive_public_key(secret) == DOMAIN_OWNER[0]`, which
               holds because the leaf was deployed under this service's own key
               and has not been handed over yet. */
            const update = await callTx.update_domain_target(contractTargetEither(targetBytes));
            return transactionIdentifier(update);
          },
          { label: `update_domain_target for ${aliasDomain(label)}`, synced: caughtUp, outsideLane: yieldSpendLane },
        );
      };

      /**
       * The bind leg, WAITING for a coin of its own rather than refusing.
       *
       * It cannot be left to the caller's `withDustWait` the way the register
       * leg is, and the asymmetry is the whole reason this exists. The
       * caller's wait rebuilds the WHOLE registration, which is right while
       * nothing has been registered and catastrophic once it has: a bind that
       * ran out of coins after `register_domain_for` landed would send the
       * caller back to register a name it already owns. So the bind waits
       * here, where the only thing rebuilt is the bind.
       *
       * Rebuilding it is safe by construction. `update_domain_target` sets the
       * leaf's target to one value; running it twice sets the same value
       * twice, and a run that failed on a DUST shortfall never reached the
       * node at all. The hold is a registration's, because that is what this
       * is a leg of — somebody is watching a screen for it.
       */
      const bindLeg = (): Promise<string> =>
        withDustWait(targetLeg, {
          label: `pointing the resolver for ${aliasDomain(label)} at ${contractAddress}`,
          windowMs: config.dustWaitMs,
          holdWhileWaiting: () => wallet.hold(SpendPriority.Registration),
          awaitFreeCoin: (maxMs) =>
            wallet.awaitFreeDustCoin(maxMs, { minSpecks: FEE_CAPABLE_SPECKS }),
        });

      let registerTx: string;
      if (pooled) {
        const outcome = await runPooledLegs(wallet.spendLanes(), registerLeg, bindLeg);
        if (outcome.kind === 'register-rejected') {
          throw new AliasSponsorError(
            'register-rejected',
            `The .night registry rejected the registration of ${aliasDomain(label)}.`,
            outcome.cause instanceof Error ? outcome.cause.message : String(outcome.cause),
          );
        }
        if (outcome.kind === 'bind-rejected') {
          throw new AliasSponsorError(
            'bind-failed',
            `${aliasDomain(label)} was registered but its resolver could not be pointed at ${contractAddress}.`,
            `resolver ${resolverAddress}, register ${outcome.registerTx}; ${
              outcome.cause instanceof Error ? outcome.cause.message : String(outcome.cause)
            }`,
          );
        }
        registerTx = outcome.registerTx;
      } else {
        try {
          registerTx = await registerLeg();
        } catch (cause) {
          if (isDustShortfall(cause)) throw cause;
          throw new AliasSponsorError(
            'register-rejected',
            `The .night registry rejected the registration of ${aliasDomain(label)}.`,
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      }

      /* Confirmation is the decisive step, and it is not "the name exists": it
         is the name pointing at THIS contract. A registration that landed on a
         different target is a failure, not a slow success. */
      let confirmed = false;
      for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
        try {
          const resolved = await resolveAlias(label);
          if (
            resolved &&
            resolved.resolverAddress === resolverAddress &&
            resolved.target.kind === 'contract' &&
            resolved.target.hex === contractAddress
          ) {
            confirmed = true;
            break;
          }
        } catch {
          // Indexer lag or a transient failure; asked again below.
        }
        await wait(CONFIRM_INTERVAL_MS);
      }
      if (!confirmed) {
        throw new AliasSponsorError(
          'confirmation-failed',
          `${aliasDomain(label)} was submitted but the registry has not shown it resolving to ${contractAddress} yet.`,
          `resolver ${resolverAddress}, deploy ${resolverDeployTx}, register ${registerTx}`,
        );
      }

      /* THE HAND-OVER, AND IT IS DELIBERATELY NOT AWAITED.
         A pooled leaf is still owned by this service, and the user's ownership
         is what lets them later call `set_resolver` or move the name. But the
         name resolves correctly the instant the two legs above confirmed, and
         nobody is watching a screen for `change_owner`. Making the request wait
         for a third proof would hand back the whole saving the pool exists to
         make. So it is queued as its own spend job, behind everything, and its
         failure is a log line rather than a refused registration — the name is
         already the user's on the registry either way, and a leaf still owned
         here can be handed over again by hand. */
      if (pooled) {
        void wallet
          .exclusive(() =>
            withNodeRejectionRetry(
              async () => {
                const leafProviders = await contractProviders(config, {
                  privateStateId: leafPrivateStateId,
                  initialPrivateState: { secretKey: callerSecretHex },
                  zkConfigProvider: zkConfigProvider as never,
                  proofProvider,
                  walletProvider: wallet.contractWalletProvider(),
                });
                const leaf = await findDeployedContract(leafProviders as never, {
                  compiledContract,
                  contractAddress: resolverAddress,
                  privateStateId: leafPrivateStateId,
                  initialPrivateState: { secretKey: callerSecretHex },
                } as never);
                const callTx = (
                  leaf as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> }
                ).callTx;
                const handover = await callTx.change_owner(request.ownerKey, {
                  bytes: request.ownerAddressBytes ?? zeroBytes(),
                });
                return transactionIdentifier(handover);
              },
              { label: `change_owner for ${aliasDomain(label)}`, synced: caughtUp, outsideLane: yieldSpendLane },
            ),
          )
          .then((handoverTx) =>
            console.log(
              `[alias] handed resolver ${resolverAddress} to the owner of ${aliasDomain(label)} (${handoverTx})`,
            ),
          )
          .catch((cause: unknown) =>
            console.warn(
              `[alias] ${aliasDomain(label)} resolves correctly but its resolver ${resolverAddress} is still owned by this service: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
          );
      }

      /* A pooled leaf's deploy transaction was resolved to the indexer's hash
         when the filler deployed it, so it is read rather than looked up: the
         lookup takes an IDENTIFIER, finds nothing for a hash, and would spend
         its whole retry budget doing it. See `deployTransactionReference`. */
      const [deploy, register] = await Promise.all([
        deployTransactionReference(pooled, resolverDeployTx, (identifier) =>
          resolveTransactionHash(config.indexerHttpUrl, identifier),
        ),
        resolveTransactionHash(config.indexerHttpUrl, registerTx),
      ]);

      return {
        alias: label,
        domain: aliasDomain(label),
        network: config.networkId,
        tldAddress,
        resolverAddress,
        resolverDeployTx: deploy.hash,
        registerTx: register.hash,
        resolverDeployBlock: deploy.block,
        registerBlock: register.block,
        target: { kind: 'contract', address: contractAddress },
        ownerKey: bytesToHex(request.ownerKey),
        costAtomic: aliasCostAtomicNight(label),
        registeredAt: new Date().toISOString(),
        fromPool: pooled !== undefined,
      };
    },
  };
}
