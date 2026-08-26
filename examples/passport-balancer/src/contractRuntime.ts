/**
 * The ledger-9 plumbing every contract call this service makes needs: where a
 * compiled build lives, the provider set a circuit call runs against, how those
 * circuits are proved, and the handful of encodings that cross the boundary
 * between HTTP and Compact.
 *
 * It is `examples/passport-funder/src/contractRuntime.ts` rewritten against the
 * stack the stagenet compatibility matrix names — the same stack
 * `deploy-stagenet/src/chain.mjs` deployed the `.night` TLD and called
 * `register_domain_for` with:
 *
 *   compact compiler 0.33.0-rc.2  →  runtime 0.18.0-rc.1
 *   compact.js       2.5.5-rc.7
 *   midnight.js      5.0.0-beta.6
 *   wallet SDK       2.0.0-beta.2   (@midnightntwrk/ledger-v9, hyphenless)
 *
 * Where the funder's v4 API and the beta diverge, `deploy-stagenet`'s shapes
 * win: they are the ones with a landed transaction behind them.
 *
 * Nothing here knows about either contract. Everything contract-specific stays
 * in the module that owns it — `./midnames.ts` and `./account.ts`.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ledger from '@midnightntwrk/ledger-v9';
import type { ZKConfigProvider } from '@midnight-ntwrk/midnight-js-types';

import type { BalancerConfig } from './config.js';
import type { ContractWalletProvider } from './wallet.js';

/** Attempts, {@link CONFIRM_INTERVAL_MS} apart, to resolve an identifier to a hash. */
const TX_HASH_ATTEMPTS = 15;

/** The poll interval every confirmation loop in this service uses. */
export const CONFIRM_INTERVAL_MS = 2_000;

/**
 * How long one contract-circuit proof may take.
 *
 * The default in `httpClientProofProvider` is five minutes. A Midnames
 * registration proved through the local 9.0.0-rc.6 image inside that, but the
 * in-process WASM prover is a Node worker rather than a tuned Rust binary, and
 * the worker's own ceiling is ten minutes — so this matches it rather than
 * timing out at five and leaving the worker running.
 */
export const CONTRACT_PROOF_TIMEOUT_MS = 10 * 60 * 1_000;

export const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

/* -------------------------------------------------------------------------- */
/* Encodings                                                                  */
/* -------------------------------------------------------------------------- */

export function bytesToHex(value: Uint8Array): string {
  let hex = '';
  for (const byte of value) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function hexToBytes(value: string): Uint8Array {
  const normalized = value.replace(/^0x/, '');
  if (normalized.length % 2 !== 0) throw new Error(`Odd-length hex string: ${value}`);
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Normalises a Midnight contract address to the raw 64-hex form. */
export function rawContractAddress(value: string): string {
  const normalized = String(value).trim().toLowerCase().replace(/^0x/, '').replace(/^0200/, '');
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Invalid Midnight contract address: ${value}`);
  }
  return normalized;
}

/** The same address as the 32 bytes a Compact `ContractAddress` argument takes. */
export function contractAddressBytes(value: string): Uint8Array {
  return hexToBytes(rawContractAddress(value));
}

/** The native NIGHT colour, as a Compact `Bytes<32>` argument takes it. */
export function nativeColourBytes(): Uint8Array {
  return hexToBytes(String(ledger.nativeToken().raw));
}

/**
 * The transaction *identifier* a midnight-js call reports. Not the ledger hash
 * an explorer resolves — see {@link resolveTransactionHash}.
 */
export function transactionIdentifier(result: unknown): string {
  const view = result as { public?: { txId?: unknown; transactionHash?: unknown } };
  const value = view?.public?.txId ?? view?.public?.transactionHash;
  if (!value) throw new Error('The contract call returned without a transaction id.');
  return String(value);
}

/**
 * midnight-js reports transaction *identifiers* (33 bytes, 66 hex chars), not
 * the 32-byte ledger hashes explorers resolve — a link built from an identifier
 * dies with "not found". The indexer maps one to the other, and it also knows
 * the block, which is what makes a drill result checkable by somebody else.
 *
 * The transaction has already landed by the time this runs, so the retries only
 * cover indexer lag; an identifier that never resolves is returned unchanged
 * rather than replaced by a plausible-looking lie.
 */
export async function resolveTransactionHash(
  indexerHttpUrl: string,
  identifier: string,
): Promise<{ hash: string; block: number | null }> {
  const query = `{ transactions(offset: { identifier: "${identifier}" }) { hash block { height } } }`;
  for (let attempt = 0; attempt < TX_HASH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(indexerHttpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const body = (await response.json()) as {
        data?: { transactions?: Array<{ hash?: string; block?: { height?: number } }> };
      };
      const found = body.data?.transactions?.[0];
      if (found?.hash) return { hash: found.hash, block: found.block?.height ?? null };
    } catch {
      // Transient network or parse failure — retried below.
    }
    await wait(CONFIRM_INTERVAL_MS);
  }
  return { hash: identifier, block: null };
}

/* -------------------------------------------------------------------------- */
/* Compiled builds                                                            */
/* -------------------------------------------------------------------------- */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where a compiled contract's ZK ARTEFACTS live — the prover keys, verifier
 * keys, and ZKIR that `NodeZkConfigProvider` reads. The compiled contract
 * MODULE itself is bundled from a literal relative specifier by the module that
 * uses it, never imported from the path this returns; see the note on that
 * import in `./midnames.ts` for why the difference matters.
 *
 * The builds are `contracts-stagenet/managed/`, compiled by compactc 0.33.0
 * against runtime 0.18.0-rc.1 — the artefacts `deploy-stagenet` put the TLD, the
 * resolver leaf, and one account-custody contract on chain with. The preview
 * service's `experiments/account-custody-prototype` builds are compiled against
 * an older runtime and MUST NOT be substituted: `checkRuntimeVersion` in the
 * generated module refuses them, and a build that slipped past it would prove
 * against verifier keys the deployed contracts do not have.
 *
 * The candidates cover running from `dist/` (what `npm start` does) and from
 * `src/`, plus the current working directory for a harness started elsewhere.
 * `options.configured` — an environment override — replaces all of it.
 * `contract/index.js` is the liveness probe because a directory without it is
 * not a build at all.
 */
export function managedBuildPath(
  build: string,
  options: { configured?: string; remedy: string },
): string {
  const candidates = options.configured
    ? [options.configured]
    : [
        resolve(HERE, '..', 'contracts-stagenet', 'managed', build),
        resolve(HERE, '..', '..', 'contracts-stagenet', 'managed', build),
        resolve(process.cwd(), 'contracts-stagenet', 'managed', build),
      ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'contract', 'index.js'))) return candidate;
  }
  throw new Error(
    `The compiled ${build} build was not found (looked in: ${candidates.join(', ')}). ${options.remedy}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Proving                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How a contract circuit gets proved, and whether it can be.
 *
 * `'server'` is `BALANCER_PROVER_URL` — a 9.0.0-rc.6 proof server, which is
 * what `deploy-stagenet` used and is the faster path. `'wasm'` is this process,
 * and it is the DEFAULT, because the droplet has no proof server and a service
 * that needed one would not be deployable there at all.
 */
export type ContractProvingMode = 'server' | 'wasm';

/**
 * Builds the proof provider for contract circuits.
 *
 * SERVER MODE is `deploy-stagenet`'s: `httpClientProofProvider` reads the
 * circuit's prover key, verifier key, and ZKIR off disk through the
 * `zkConfigProvider` and posts them with the preimage, so the server needs no
 * knowledge of our contracts.
 *
 * WASM MODE proves the same circuits here. It exists because the funder's
 * preview deployment can lean on a hosted proof server and the stagenet droplet
 * cannot: a `/register-alias` that required Docker on the droplet would be a
 * new operational dependency for the one endpoint that is supposed to remove
 * dependencies. The wallet SDK already ships the prover — `WasmProver` runs
 * `@midnight-ntwrk/zkir-v2` in a worker thread, which is also what keeps a
 * multi-second proof from blocking `/wallet-status` — and midnight-js already
 * ships the adapter, `createProofProvider`, that turns a ledger `ProvingProvider`
 * into the `ProofProvider` a contract call wants.
 *
 * The join is the KEY MATERIAL. The wallet SDK's default provider serves the
 * four PUBLISHED ledger circuits (`midnight/zswap/{spend,output,sign}`,
 * `midnight/dust/spend`) from S3 and knows nothing about `register_domain_for`
 * or `deposit_night`; our `zkConfigProvider` is the reverse. So the provider
 * below is the union of the two, resolved in the same order
 * `httpClientProofProvider` resolves them — the registry's verifier-key join
 * first, the flat provider second, the published circuits last. BLS parameters
 * always come from the published source: they are a property of the circuit
 * size, not of the contract.
 */
export async function createContractProofProvider(
  config: BalancerConfig,
  zkConfigProvider: ZKConfigProvider<string>,
): Promise<{ mode: ContractProvingMode; proofProvider: unknown }> {
  if (config.provingServerUrl) {
    const { httpClientProofProvider } = await import(
      '@midnight-ntwrk/midnight-js-http-client-proof-provider'
    );
    return {
      mode: 'server',
      proofProvider: httpClientProofProvider({
        url: config.provingServerUrl,
        zkConfigProvider,
        timeout: CONTRACT_PROOF_TIMEOUT_MS,
      } as never),
    };
  }

  const { createProofProvider, ZKConfigRegistry, zkConfigToProvingKeyMaterial } = await import(
    '@midnight-ntwrk/midnight-js-types'
  );
  const { WasmProver } = await import('@midnight-ntwrk/wallet-sdk/prover-client/effect');
  const { Effect } = await import('effect');

  const published = WasmProver.makeDefaultKeyMaterialProvider();
  const registry = new ZKConfigRegistry([zkConfigProvider]);

  const keyMaterialProvider = {
    async lookupKey(keyLocation: string) {
      /* A canonical contract key location — contract address, circuit, and the
         verifier-key hash the DEPLOYED contract carries. The registry's join
         refuses an artefact set whose verifier key does not match what is on
         chain, which is exactly the check that catches a stale build before it
         produces a proof the node will reject. */
      const resolved = await registry.resolveKeyLocation(keyLocation);
      if (resolved !== undefined) return zkConfigToProvingKeyMaterial(resolved);
      try {
        /* A bare circuit name — what a DEPLOY preimage carries, since there is
           no address yet to hash a deployed verifier key against. */
        return zkConfigToProvingKeyMaterial(await zkConfigProvider.get(keyLocation));
      } catch {
        /* Not one of ours: a protocol builtin (`midnight/...`). */
      }
      return published.lookupKey(keyLocation);
    },
    getParams: (k: number) => published.getParams(k),
  };

  const prover = Effect.runSync(WasmProver.create({ keyMaterialProvider }));
  return { mode: 'wasm', proofProvider: createProofProvider(prover.asProvingProvider()) };
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

/** Session-lifetime private-state store, mirroring the funder's. */
export function inMemoryPrivateStateProvider(initial: Record<string, unknown>) {
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
      throw new Error('Private-state export is not supported by the balancer.');
    },
  };
}

/** The indexer reader, in the beta's object-argument form. */
export async function publicDataProviderFor(config: BalancerConfig) {
  const { indexerPublicDataProvider } = await import(
    '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
  );
  return indexerPublicDataProvider({
    queryURL: config.indexerHttpUrl,
    subscriptionURL: config.indexerWsUrl,
  });
}

/**
 * The provider set one contract job runs against.
 *
 * Build it PER JOB, not once per process: the wallet provider snapshots the
 * wallet's shielded keys at construction, and a long-lived balancer outlives any
 * one snapshot. The wallet provider is both `walletProvider` and
 * `midnightProvider` because the balancer balances, signs, and submits its own
 * sponsored transactions — the DUST-sponsorship leg in `/balance-only` is the
 * other direction entirely and shares nothing with this path.
 */
export async function contractProviders(
  config: BalancerConfig,
  options: {
    privateStateId: string;
    initialPrivateState: unknown;
    zkConfigProvider: ZKConfigProvider<string>;
    proofProvider: unknown;
    walletProvider: ContractWalletProvider;
  },
) {
  return {
    privateStateProvider: inMemoryPrivateStateProvider({
      [options.privateStateId]: options.initialPrivateState,
    }),
    publicDataProvider: await publicDataProviderFor(config),
    zkConfigProvider: options.zkConfigProvider,
    proofProvider: options.proofProvider,
    walletProvider: options.walletProvider,
    midnightProvider: options.walletProvider,
  };
}
