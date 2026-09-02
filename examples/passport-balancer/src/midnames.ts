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
import type { BalancerWallet } from './wallet.js';

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
}

export interface MidnamesSponsor {
  /** The TLD this service registers against. */
  readonly tldAddress: string;
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

      let resolverAddress: string;
      let resolverDeployTx: string;
      try {
        /* Thirteen arguments, in `deploy.mjs`'s order — the order the leaf that
           backs `passport-771a3f.night` was deployed with. `cost_*` are zero and
           `buy_enabled` is false because a LEAF sells nothing; only the TLD
           does. */
        const deployed = await withNodeRejectionRetry(
          () => deployContract(providers as never, {
          compiledContract,
          privateStateId,
          initialPrivateState: { secretKey: callerSecretHex },
          args: [
            maybeBytes(domainToKey(MIDNAMES_TLD).key),
            { bytes: contractAddressBytes(tldAddress) },
            [targetBytes, midnames.AddressType.ContractAddr],
            maybeBytes(labelKey),
            nativeColourBytes(),
            0n,
            0n,
            0n,
            maybeString(),
            false,
            request.ownerKey,
            { bytes: request.ownerAddressBytes ?? new Uint8Array(32) },
            emptyKvs(),
          ],
          } as never),
          /* A refused leaf deploy is the worst of the rejections to give up on:
             it is the FIRST of the name path's two dependent proofs, and the
             client's answer to a 502 here is to start the whole registration
             again. Rebuilt once the wallet is current instead. */
          { label: `resolver deploy for ${aliasDomain(label)}`, synced: caughtUp },
        );
        const deployTxData = (deployed as { deployTxData: unknown }).deployTxData as {
          public: { contractAddress: string };
        };
        resolverAddress = rawContractAddress(deployTxData.public.contractAddress);
        resolverDeployTx = transactionIdentifier(deployTxData);
      } catch (cause) {
        throw new AliasSponsorError(
          'deploy-failed',
          `The resolver contract for ${aliasDomain(label)} could not be deployed, so nothing was registered.`,
          cause instanceof Error ? cause.message : String(cause),
        );
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

      let registerTx: string;
      try {
        /* And the second of the two. A rejection here leaves a deployed,
           unregistered resolver behind, so it is worth a rebuild rather than a
           refusal — the alternative costs the user their name and this service
           the fee it already paid for the leaf. */
        registerTx = await withNodeRejectionRetry(
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
          { label: `register_domain_for ${aliasDomain(label)}`, synced: caughtUp },
        );
      } catch (cause) {
        throw new AliasSponsorError(
          'register-rejected',
          `The .night registry rejected the registration of ${aliasDomain(label)}.`,
          cause instanceof Error ? cause.message : String(cause),
        );
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

      const [deploy, register] = await Promise.all([
        resolveTransactionHash(config.indexerHttpUrl, resolverDeployTx),
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
      };
    },
  };
}
