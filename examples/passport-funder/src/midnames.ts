/**
 * Sponsored `.night` registration — the funder registers a name FOR a user and
 * pays for all of it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now a Passport user paid for their own alias: the funder dripped them
 * activation-sized NIGHT and their wallet then spent 10 atomic NIGHT on the
 * registration. That still means the user's wallet has to hold NIGHT, and a
 * wallet that has to hold NIGHT has to be funded, watched, and settled first.
 *
 * The deployed `.night` TLD does not require any of that. Its registration
 * entrypoint is
 *
 *     register_domain_for(owner, domain, len, resolver)
 *
 * and `owner` is an ARGUMENT, not the caller. The compiled circuit (see
 * `_register_domain_for_0` in the pinned build) derives the CALLER's public key
 * from the `secretKey` witness, compares it with the TLD's own `DOMAIN_OWNER`,
 * and — when they differ, which for us they always do — asserts `BUY_ENABLED`
 * and takes `COST` in unshielded NIGHT from the caller. It then writes
 * `domains[domain] = { owner, resolver }` and adds the name to
 * `domains_owned[owner]`. So a third party can pay for a name that the registry
 * records as belonging to somebody else, which is exactly the shape of
 * sponsorship the Midnames team would run themselves.
 *
 * This module makes the funder that third party:
 *
 *   1. it deploys the resolver leaf with `DOMAIN_TARGET = [contractAddress,
 *      AddressType.ContractAddr]` (the user's account-custody contract) and
 *      `DOMAIN_OWNER` = the owner key the caller supplied; then
 *   2. it calls `register_domain_for` on the network's TLD with that same owner
 *      key, paying COST from the funder's own NIGHT and the fee from the
 *      funder's own DUST.
 *
 * The user's wallet signs nothing, spends nothing, and needs to hold nothing.
 * Ownership on the registry is the user's key: only a holder of the secret
 * behind it can later call `set_resolver` or `transfer_domain`.
 *
 * NO SPONSOR SERVICE HERE
 * -----------------------
 * The demo's browser path hands its fee leg to the ProofStation gateway,
 * because a passkey wallet holds no DUST. The funder is the opposite case: it
 * registers its NIGHT for DUST generation at start-up and owns its fees. Asking
 * a sponsor to pay for the service that pays for everyone else would add a
 * dependency and a failure mode for nothing.
 *
 * PROVENANCE
 * ----------
 * The contract handling is a server-side port of
 * `experiments/account-custody-prototype/src/integrations/midnames/preview.ts`
 * (Midnames rev 83f8422b, compact 0.31.1) — the original Node integration. The
 * pure helpers (label normalisation, the reserved list, the cost table, the
 * owner-key hash, the padded-key encoding) are COPIED from
 * `examples/passport-demo/src/identity/midnames.ts` rather than imported, so
 * the service has no build-time dependency on the PWA. They must stay
 * byte-identical: a label the browser normalises one way and the service
 * another would register a name the user never typed.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nativeToken } from '@midnight-ntwrk/ledger-v8';
import {
  ZKConfigProvider,
  createProverKey,
  createVerifierKey,
  createZKIR,
  type ProverKey,
  type VerifierKey,
  type ZKIR,
} from '@midnight-ntwrk/midnight-js-types';

import type { FunderConfig } from './config.js';
import type { ContractWalletProvider, FunderWallet } from './wallet.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** The `.night` top-level domain. Every Passport alias is a label under it. */
export const MIDNAMES_TLD = 'night';

/**
 * Names the funder will not sponsor, whatever the registry says. Copied from
 * the demo's `RESERVED_ALIASES`: these are infrastructure and impersonation
 * risks, and `midnight.night` reading as an official account is exactly the
 * confusion this list prevents. A sponsored registration makes the risk worse,
 * not better — it removes the only cost an impersonator would have paid.
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

/** Attempts, two seconds apart, to watch the binding appear in the registry. */
const CONFIRM_ATTEMPTS = 45;
const CONFIRM_INTERVAL_MS = 2_000;
/** Attempts, two seconds apart, to resolve a transaction identifier to a hash. */
const TX_HASH_ATTEMPTS = 8;

/* -------------------------------------------------------------------------- */
/* Pure helpers — copies of the demo's, and they must stay copies             */
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

const wait = (milliseconds: number) =>
  new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));

/** `alice` -> `alice.night`. */
export function aliasDomain(alias: string): string {
  return `${alias}.${MIDNAMES_TLD}`;
}

/**
 * Normalises a requested alias to its registry label, throwing a sentence the
 * caller can show verbatim.
 *
 * The accepted shape is exactly the demo's and the Node integration's:
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

/** Normalises a Midnight contract address to the raw 64-hex form. */
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
 * with 0xff. Identical to the browser port and the Node integration, byte for
 * byte — `register_domain_for` asserts the padding itself.
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
 * a caller and this module can be checked against each other, and so the
 * drill can derive the key it posts.
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

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the pinned Midnames build's ZK ARTEFACTS live — the prover keys,
 * verifier keys, and ZKIR that {@link DirectoryZkConfigProvider} reads. The
 * compiled contract itself is bundled, not read from here; see the note at its
 * import.
 *
 * The repository stages exactly one copy of the build —
 * `experiments/account-custody-prototype/contracts/managed/midnames`, produced
 * by that prototype's `midnames:prepare` — and every consumer reaches it rather
 * than keeping a copy that can drift.
 *
 * The candidates cover running from `dist/` (what `npm start` does) and from
 * `src/`, plus the current working directory for a harness started elsewhere.
 * `FUNDER_MIDNAMES_ASSETS` overrides all of it. `contract/index.js` is the
 * liveness probe because a directory without it is not a build at all.
 */
function midnamesManagedPath(configured?: string): string {
  const candidates = configured
    ? [configured]
    : [
        resolve(HERE, '..', '..', '..', 'experiments', 'account-custody-prototype', 'contracts', 'managed', 'midnames'),
        resolve(HERE, '..', '..', '..', '..', 'experiments', 'account-custody-prototype', 'contracts', 'managed', 'midnames'),
        resolve(process.cwd(), 'experiments', 'account-custody-prototype', 'contracts', 'managed', 'midnames'),
      ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'contract', 'index.js'))) return candidate;
  }
  throw new Error(
    `The pinned Midnames build was not found (looked in: ${candidates.join(', ')}). Run \`npm run midnames:prepare\` in experiments/account-custody-prototype, or set FUNDER_MIDNAMES_ASSETS.`,
  );
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

/**
 * Reads the compiled artefacts straight off disk.
 *
 * The repository has no `@midnight-ntwrk/midnight-js-node-zk-config-provider`
 * installed and the browser's `FetchZkConfigProvider` refuses anything but
 * http(s), so the twenty lines it would have supplied live here. The layout is
 * the compiler's own and the same one `FetchZkConfigProvider` assumes:
 * `keys/<circuit>.prover`, `keys/<circuit>.verifier`, `zkir/<circuit>.bzkir`.
 */
class DirectoryZkConfigProvider extends ZKConfigProvider<string> {
  constructor(private readonly base: string) {
    super();
  }

  private async read(directory: string, circuitId: string, extension: string): Promise<Uint8Array> {
    const { readFile } = await import('node:fs/promises');
    const path = resolve(this.base, directory, `${circuitId}${extension}`);
    return new Uint8Array(await readFile(path));
  }

  async getProverKey(circuitId: string): Promise<ProverKey> {
    return createProverKey(await this.read('keys', circuitId, '.prover'));
  }

  async getVerifierKey(circuitId: string): Promise<VerifierKey> {
    return createVerifierKey(await this.read('keys', circuitId, '.verifier'));
  }

  async getZKIR(circuitId: string): Promise<ZKIR> {
    return createZKIR(await this.read('zkir', circuitId, '.bzkir'));
  }
}

/** Session-lifetime private-state store, mirroring the demo's. */
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
      throw new Error('Private-state export is not supported by the funder.');
    },
  };
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

function nativeColourBytes(): Uint8Array {
  return hexToBytes(String(nativeToken().raw));
}

function transactionIdentifier(result: unknown): string {
  const view = result as { public?: { txId?: unknown; transactionHash?: unknown } };
  const value = view?.public?.txId ?? view?.public?.transactionHash;
  if (!value) throw new Error('The Midnames call returned without a transaction id.');
  return String(value);
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
  | 'confirmation-failed';

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
   * funder does not know the user's wallet address and must not substitute its
   * own, or a payment meant for the user would land on the funder.
   */
  ownerAddressBytes?: Uint8Array;
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
  target: { kind: 'contract'; address: string };
  ownerKey: string;
  costAtomic: bigint;
  registeredAt: string;
}

export interface MidnamesSponsor {
  /** The TLD this funder registers against. */
  readonly tldAddress: string;
  /** Is the label free right now? Reads the deployed registry, never a cache. */
  isAvailable(label: string): Promise<boolean>;
  /** Does the indexer serve contract state at this address? */
  contractExists(address: string): Promise<boolean>;
  /** What the name resolves to right now, or null when it is not registered. */
  resolve(label: string): Promise<{ resolverAddress: string; target: ResolvedDomainTarget } | null>;
  /**
   * Deploys the leaf, registers the name, and reads the binding back. Resolves
   * only when the registry really reports the requested contract address.
   *
   * MUST be called inside `wallet.exclusive(...)`: it spends the funder's coins
   * twice and would otherwise contend with a drip.
   */
  register(request: AliasRegistrationRequest): Promise<AliasRegistration>;
}

/**
 * Builds the sponsor. Loading the compiled contract here rather than per
 * request means a broken or missing artefact set fails at start-up, where an
 * operator sees it, instead of on a user's first alias.
 */
export async function createMidnamesSponsor(
  config: FunderConfig,
  wallet: FunderWallet,
): Promise<MidnamesSponsor> {
  const managedPath = midnamesManagedPath(config.midnamesAssetsPath);
  /**
   * A LITERAL relative specifier, not a path computed from `managedPath`.
   *
   * That is not a style preference, it is the difference between working and
   * not. `experiments/account-custody-prototype` carries its own
   * `node_modules`, so a runtime `import()` of an absolute path inside that
   * tree makes Node resolve `@midnight-ntwrk/compact-runtime` from THERE, while
   * the indexer provider next to it resolves the copy at the repository root.
   * Two copies means two `ChargedState` classes, and decoding a contract state
   * dies on `expected instance of ChargedState` (measured on preview,
   * 2026/08/20, first drill run). A literal specifier is bundled by esbuild
   * into this service, so there is exactly one runtime in play — the same thing
   * Vite does for the browser port.
   */
  const midnames = (await import(
    '../../../experiments/account-custody-prototype/contracts/managed/midnames/contract/index.js'
  )) as unknown as MidnamesModule;
  const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
  const { indexerPublicDataProvider } = await import(
    '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
  );
  const { httpClientProofProvider } = await import(
    '@midnight-ntwrk/midnight-js-http-client-proof-provider'
  );
  const { deployContract, findDeployedContract } = await import(
    '@midnight-ntwrk/midnight-js-contracts'
  );

  const tldAddress = rawContractAddress(config.midnamesTldAddress);

  /**
   * The funder's caller identity inside the circuits.
   *
   * `register_domain_for` derives the caller's public key from this witness and
   * compares it with the TLD's own owner: matching would register the name for
   * free, differing takes COST. The funder is not the TLD owner, so it pays —
   * which is the whole point. Deriving it from the funder seed rather than
   * randomising keeps one stable caller identity across restarts; the bytes
   * never leave this process and are not the user's anything.
   */
  const funderWitnessSecret = new Uint8Array(
    createHash('sha256')
      .update(Buffer.from('midnight.passport.funder.midnames'))
      .update(Buffer.from(config.seedHex, 'hex'))
      .digest(),
  );
  const funderWitnessSecretHex = bytesToHex(funderWitnessSecret);

  const zkConfigProvider = new DirectoryZkConfigProvider(managedPath);

  const reader = indexerPublicDataProvider(config.indexerHttpUrl, config.indexerWsUrl);

  const readLedger = async (address: string): Promise<MidnamesLedger | null> => {
    const state = await reader.queryContractState(address);
    if (!state) return null;
    return midnames.ledger((state as { data: unknown }).data);
  };

  const compiledContract = CompiledContract.make('passport-midnames-leaf', midnames.Contract as never).pipe(
    CompiledContract.withWitnesses({
      secretKey: ({ privateState }: { privateState: { secretKey: string } }) => [
        privateState,
        hexToBytes(privateState.secretKey ?? funderWitnessSecretHex),
      ],
    } as never),
    CompiledContract.withCompiledFileAssets(managedPath),
  );

  /**
   * Providers for one registration. Rebuilt per call because the wallet
   * provider snapshots the wallet's shielded keys at construction, and a
   * long-lived funder outlives any one snapshot.
   */
  const providersFor = async (
    privateStateId: string,
    walletProvider: ContractWalletProvider,
  ) => ({
    privateStateProvider: inMemoryPrivateStateProvider({
      [privateStateId]: { secretKey: funderWitnessSecretHex },
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexerHttpUrl, config.indexerWsUrl),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.provingServerUrl, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  });

  /**
   * midnight-js reports transaction *identifiers* (33 bytes, 66 hex chars), not
   * the 32-byte ledger hashes explorers resolve — a link built from an
   * identifier dies with "not found". The indexer maps one to the other. The
   * transaction has already landed by the time this runs, so the retries only
   * cover indexer lag; an identifier that never resolves is returned unchanged
   * rather than replaced by a plausible-looking lie.
   */
  const resolveTransactionHash = async (identifier: string): Promise<string> => {
    const query = `{ transactions(offset: { identifier: "${identifier}" }) { hash } }`;
    for (let attempt = 0; attempt < TX_HASH_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(config.indexerHttpUrl, {
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
      await wait(CONFIRM_INTERVAL_MS);
    }
    return identifier;
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

    isAvailable,

    async contractExists(address: string): Promise<boolean> {
      return Boolean(await reader.queryContractState(rawContractAddress(address)));
    },

    resolve: resolveAlias,

    async register(request: AliasRegistrationRequest): Promise<AliasRegistration> {
      const label = request.label;
      const contractAddress = rawContractAddress(request.contractAddress);
      const { key: labelKey, len } = domainToKey(label);
      const privateStateId = `passport-funder-midnames-${label}`;
      const walletProvider = await wallet.contractWalletProvider();
      const providers = await providersFor(privateStateId, walletProvider);

      /* The leaf's TARGET is the user's account-custody contract:
         `AddressType.ContractAddr` puts those 32 bytes in the LEFT branch of
         `DOMAIN_TARGET`, which is what `decodeDomainTarget` reads back as
         `kind: 'contract'`. Nothing here can silently fall back to a wallet
         address — the caller supplies a contract address or the request was
         already refused. */
      const targetBytes = contractAddressBytes(contractAddress);

      let resolverAddress: string;
      let resolverDeployTx: string;
      try {
        const deployed = await deployContract(providers as never, {
          compiledContract,
          privateStateId,
          initialPrivateState: { secretKey: funderWitnessSecretHex },
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
        } as never);
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

      let registerTx: string;
      try {
        const tld = await findDeployedContract(providers as never, {
          compiledContract,
          contractAddress: tldAddress,
          privateStateId,
          initialPrivateState: { secretKey: funderWitnessSecretHex },
        } as never);
        const callTx = (tld as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> })
          .callTx;
        /* The paid call. `request.ownerKey` — the USER's key — is argument one,
           so the registry records the user as owner while the funder's own
           NIGHT covers COST and the funder's own DUST covers the fee. */
        const registration = await callTx.register_domain_for(request.ownerKey, labelKey, len, {
          bytes: contractAddressBytes(resolverAddress),
        });
        registerTx = transactionIdentifier(registration);
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

      const [deployHash, registerHash] = await Promise.all([
        resolveTransactionHash(resolverDeployTx),
        resolveTransactionHash(registerTx),
      ]);

      return {
        alias: label,
        domain: aliasDomain(label),
        network: config.networkId,
        tldAddress,
        resolverAddress,
        resolverDeployTx: deployHash,
        registerTx: registerHash,
        target: { kind: 'contract', address: contractAddress },
        ownerKey: bytesToHex(request.ownerKey),
        costAtomic: aliasCostAtomicNight(label),
        registeredAt: new Date().toISOString(),
      };
    },
  };
}
