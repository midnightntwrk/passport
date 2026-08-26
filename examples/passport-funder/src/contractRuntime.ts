/**
 * The plumbing every contract call this service makes needs: where a compiled
 * build lives, how its ZK artefacts are read off disk, the provider set a
 * circuit call runs against, and the handful of encodings that cross the
 * boundary between HTTP and Compact.
 *
 * It exists because there are now two callers. `./midnames.ts` sponsors a
 * `.night` registration on the shared registry; `./account.ts` deposits an
 * activation grant into a user's own account-custody contract. Neither is a
 * special case of the other, but the provider set, the artefact reader, the
 * transaction-identifier handling, and the hex are the same in both — and a
 * second copy of any of it would be a second thing to keep in step.
 *
 * Nothing here knows about either contract. Everything contract-specific stays
 * in the module that owns it.
 */

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
import type { ContractWalletProvider } from './wallet.js';

/** Attempts, {@link CONFIRM_INTERVAL_MS} apart, to resolve an identifier to a hash. */
const TX_HASH_ATTEMPTS = 8;

/** The poll interval every confirmation loop in this service uses. */
export const CONFIRM_INTERVAL_MS = 2_000;

export const wait = (milliseconds: number) =>
  new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));

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
  const normalized = value.trim().toLowerCase().replace(/^0x/, '').replace(/^0200/, '');
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
  return hexToBytes(String(nativeToken().raw));
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
 * dies with "not found". The indexer maps one to the other. The transaction has
 * already landed by the time this runs, so the retries only cover indexer lag;
 * an identifier that never resolves is returned unchanged rather than replaced
 * by a plausible-looking lie.
 */
export async function resolveTransactionHash(
  indexerHttpUrl: string,
  identifier: string,
): Promise<string> {
  const query = `{ transactions(offset: { identifier: "${identifier}" }) { hash } }`;
  for (let attempt = 0; attempt < TX_HASH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(indexerHttpUrl, {
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
}

/* -------------------------------------------------------------------------- */
/* Compiled builds                                                            */
/* -------------------------------------------------------------------------- */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where a compiled contract's ZK ARTEFACTS live — the prover keys, verifier
 * keys, and ZKIR that {@link DirectoryZkConfigProvider} reads. The compiled
 * contract MODULE itself is bundled from a literal relative specifier by the
 * module that uses it, never imported from the path this returns; see the note
 * on that import in `./midnames.ts` for why the difference matters.
 *
 * The repository stages exactly one copy of each build, under
 * `experiments/account-custody-prototype/contracts/managed/`, and every
 * consumer reaches it rather than keeping a copy that can drift.
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
        resolve(HERE, '..', '..', '..', 'experiments', 'account-custody-prototype', 'contracts', 'managed', build),
        resolve(HERE, '..', '..', '..', '..', 'experiments', 'account-custody-prototype', 'contracts', 'managed', build),
        resolve(process.cwd(), 'experiments', 'account-custody-prototype', 'contracts', 'managed', build),
      ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'contract', 'index.js'))) return candidate;
  }
  throw new Error(
    `The pinned ${build} build was not found (looked in: ${candidates.join(', ')}). ${options.remedy}`,
  );
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
export class DirectoryZkConfigProvider extends ZKConfigProvider<string> {
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

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

/** Session-lifetime private-state store, mirroring the demo's. */
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
      throw new Error('Private-state export is not supported by the funder.');
    },
  };
}

/**
 * The provider set one contract job runs against.
 *
 * Build it PER JOB, not once per process: the wallet provider snapshots the
 * wallet's shielded keys at construction, and a long-lived funder outlives any
 * one snapshot. The wallet provider is both `walletProvider` and
 * `midnightProvider` because the funder balances, signs, and submits its own
 * transactions — there is no sponsor leg anywhere in this service.
 */
export async function contractProviders(
  config: FunderConfig,
  options: {
    privateStateId: string;
    initialPrivateState: unknown;
    zkConfigProvider: ZKConfigProvider<string>;
    walletProvider: ContractWalletProvider;
  },
) {
  const { indexerPublicDataProvider } = await import(
    '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
  );
  const { httpClientProofProvider } = await import(
    '@midnight-ntwrk/midnight-js-http-client-proof-provider'
  );
  return {
    privateStateProvider: inMemoryPrivateStateProvider({
      [options.privateStateId]: options.initialPrivateState,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexerHttpUrl, config.indexerWsUrl),
    zkConfigProvider: options.zkConfigProvider,
    proofProvider: httpClientProofProvider(config.provingServerUrl, options.zkConfigProvider),
    walletProvider: options.walletProvider,
    midnightProvider: options.walletProvider,
  };
}
