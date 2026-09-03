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
import { countingProof } from './proving.js';
import { currentJob, progress } from './reservation.js';
import type { ContractWalletProvider } from './wallet.js';

/** Attempts, {@link CONFIRM_INTERVAL_MS} apart, to resolve an identifier to a hash. */
const TX_HASH_ATTEMPTS = 60;

/**
 * The poll interval every confirmation loop in this service uses.
 *
 * Five hundred milliseconds since 2026/08/31, down from two seconds, with every
 * attempt count in the service multiplied by four on the same commit so that
 * not one confirmation WINDOW changed length. The windows are the tolerances —
 * how long a lagging indexer is given before a submitted transaction is
 * reported as unconfirmed — and shortening those would have been a change to
 * what the service is willing to say, not to how fast it says it.
 *
 * What changed is only the overshoot. Every one of these loops repeats a single
 * indexer query, measured at 102–123 ms warm and 346 ms cold against stagenet
 * over sixteen samples, and most of them are entered immediately after
 * something that has already waited out the indexer's own ~14 s lag — so on the
 * happy path the first attempt succeeds and the whole cost of the loop was the
 * fraction of an interval it slept through before asking. Four loops of it in
 * one claim.
 */
export const CONFIRM_INTERVAL_MS = 500;

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
/* Deadlines                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A wait after a submission that was abandoned rather than answered.
 *
 * It says nothing about the transaction — see {@link boundedPublicDataProvider},
 * which asks the indexer directly by identifier before it throws one of these.
 * The two hangs of 2026/09/02 had both landed on chain, and a service that
 * treated its own timeout as a failure would have rebuilt two transactions that
 * were already in blocks 291694 and 292118.
 */
export class ConfirmationTimeout extends Error {
  readonly what: string;
  readonly subject: string;

  constructor(what: string, subject: string, waitedMs: number) {
    super(
      `The indexer did not report ${what} ${subject} within ${Math.round(waitedMs / 1_000)} s, and a direct query did not find it either.`,
    );
    this.name = 'ConfirmationTimeout';
    this.what = what;
    this.subject = subject;
  }
}

/** Matches {@link ConfirmationTimeout} across a bundle boundary. */
export function isConfirmationTimeout(cause: unknown): boolean {
  if (cause instanceof ConfirmationTimeout) return true;
  return cause instanceof Error && cause.name === 'ConfirmationTimeout';
}

/** A proof that took longer than this service is willing to hold a lane for. */
export class ProofTimeout extends Error {
  constructor(waitedMs: number) {
    super(`Proving did not finish within ${Math.round(waitedMs / 1_000)} s.`);
    this.name = 'ProofTimeout';
  }
}

/** Matches {@link ProofTimeout} across a bundle boundary. */
export function isProofTimeout(cause: unknown): boolean {
  if (cause instanceof ProofTimeout) return true;
  return cause instanceof Error && cause.name === 'ProofTimeout';
}

/**
 * Runs `work` with a ceiling, and with the running job's abort as a second exit.
 *
 * The underlying promise is never CANCELLED — nothing in midnight-js or the
 * wallet SDK offers cancellation — it is stopped being waited on, and its
 * eventual settlement is discarded rather than left to surface as an unhandled
 * rejection. That is the honest description of what this service can do about a
 * library that waits for ever, and it is enough: the lane comes back, the job
 * rebuilds, and the DUST is recovered through the orphan sweeper.
 */
export async function withDeadline<T>(
  work: () => Promise<T>,
  milliseconds: number,
  onExpiry: (waitedMs: number) => Error,
): Promise<T> {
  const startedAt = Date.now();
  const signal = currentJob()?.abort.signal;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  try {
    return await new Promise<T>((settle, fail) => {
      timer = setTimeout(() => fail(onExpiry(Date.now() - startedAt)), milliseconds);
      if (signal) {
        if (signal.aborted) {
          fail(signal.reason);
          return;
        }
        onAbort = (): void => fail(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      void work().then(settle, fail);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * One indexer query: has the transaction with this IDENTIFIER landed?
 *
 * The bounded sibling of {@link resolveTransactionHash}, which retries for
 * thirty seconds because it runs when the answer is known to be yes. This one
 * runs when the answer is the question — a watch that timed out — so it asks
 * once and reports what it got, including "the indexer would not answer",
 * which is not the same as "the transaction is not there".
 */
export async function queryTransactionByIdentifier(
  indexerHttpUrl: string,
  identifier: string,
): Promise<{ landed: boolean; hash: string | null; block: number | null }> {
  const query = `{ transactions(offset: { identifier: "${identifier}" }) { hash block { height } } }`;
  try {
    const response = await fetch(indexerHttpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as {
      data?: { transactions?: Array<{ hash?: string; block?: { height?: number } }> };
    };
    const found = body.data?.transactions?.[0];
    if (found?.hash) return { landed: true, hash: found.hash, block: found.block?.height ?? null };
  } catch {
    // An unreachable indexer is not a landed transaction, and not a missing one.
  }
  return { landed: false, hash: null, block: null };
}

/** One indexer query: does a contract exist at this address? */
export async function queryContractExists(
  indexerHttpUrl: string,
  contractAddress: string,
): Promise<boolean> {
  const query = `{ contractAction(address: "${contractAddress}") { address } }`;
  try {
    const response = await fetch(indexerHttpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as { data?: { contractAction?: { address?: string } | null } };
    return Boolean(body.data?.contractAction?.address);
  } catch {
    return false;
  }
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
      proofProvider: countedProofProvider(
        httpClientProofProvider({
          url: config.provingServerUrl,
          zkConfigProvider,
          timeout: CONTRACT_PROOF_TIMEOUT_MS,
        } as never),
      ),
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
  return {
    mode: 'wasm',
    proofProvider: countedProofProvider(createProofProvider(prover.asProvingProvider())),
  };
}

/** What midnight-js asks a proof provider to do. */
interface ProvingProvider {
  proveTx(...args: unknown[]): Promise<unknown>;
  [key: string]: unknown;
}

/**
 * Makes midnight-js's own proving visible to the stall watchdog.
 *
 * `deployContract` and `callTx` prove through this provider, and a contract
 * proof is minutes long and reports nothing while it runs. Without this count
 * the watchdog in `./reservation.ts` would see a job that has not moved since
 * `balanced` and abort a perfectly healthy registration; with it, `proverIdle`
 * is false for exactly as long as the proof is outstanding.
 *
 * Prototype-preserving, for the reason `boundedPublicDataProvider` gives: the
 * providers are class instances with methods this wrapper does not name.
 */
function countedProofProvider(provider: unknown): unknown {
  const inner = provider as ProvingProvider;
  if (typeof inner?.proveTx !== 'function') return provider;
  const wrapper = Object.create(inner) as ProvingProvider;
  Object.assign(wrapper, {
    proveTx: (...args: unknown[]) => {
      progress('proving');
      return countingProof(async () => {
        const proved = await inner.proveTx(...args);
        progress('proved');
        return proved;
      });
    },
  });
  return wrapper;
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

/** The three provider methods a spend job can wait on for ever. */
interface WatchingProvider {
  watchForTxData(txId: string): Promise<unknown>;
  watchForDeployTxData(contractAddress: string): Promise<unknown>;
  watchForContractState(contractAddress: string): Promise<unknown>;
  [key: string]: unknown;
}

export interface BoundedProviderOptions {
  /** See `config.confirmTimeoutMs`. */
  confirmTimeoutMs: number;
  /**
   * Builds a SECOND, independent provider for the recovery attempt.
   *
   * Independent is the load-bearing word. midnight-js polls the indexer through
   * one Apollo client per provider, and the failure being recovered from is a
   * client that has stopped producing results — so retrying on the same one
   * would wait out a second deadline and learn nothing. A fresh client asks the
   * same query over a new socket.
   *
   * Recovery goes through the LIBRARY rather than hand-parsing the indexer's
   * answer, and deliberately: the value these methods return carries a parsed
   * ledger `Transaction`, and this service links `@midnightntwrk/ledger-v9`
   * while midnight-js links `@midnight-ntwrk/ledger-v9` — two different WASM
   * modules. A transaction parsed here and handed to midnight-js would be an
   * object from a foreign instance, which is a worse fault than the one being
   * fixed.
   */
  fresh: () => Promise<WatchingProvider>;
  /** Where {@link queryTransactionByIdentifier} asks. */
  indexerHttpUrl: string;
  /**
   * The direct question: is this transaction, or this contract, on chain?
   *
   * Injectable so the recovery path is a unit test rather than a stagenet
   * afternoon — the default is the real pair of one-shot indexer queries, and
   * that is what production uses.
   */
  landed?: (what: 'transaction' | 'contract', subject: string) => Promise<boolean>;
  log?: (line: string) => void;
}

/**
 * Puts a ceiling on the three indexer waits midnight-js performs with none.
 *
 * `pollUntilPresent` — `watchForTxData`, `watchForDeployTxData` — is an Apollo
 * `watchQuery` filtered to the first matching answer and taken once. If the
 * answer never comes, or the socket underneath stops producing answers, the
 * promise never settles and the spend job holding a lane never ends. Nothing in
 * midnight-js, and until now nothing here, bounded it.
 *
 * On expiry the indexer is asked DIRECTLY, once, by identifier or by address.
 * A transaction that landed and was merely not streamed to us is a completed
 * job — that is both hangs of 2026/09/02 — so the watch is retried on a fresh
 * client and the job carries on. A transaction that is genuinely not there is a
 * {@link ConfirmationTimeout}, which `withNodeRejectionRetry` treats as a
 * rebuildable failure.
 */
export function boundedPublicDataProvider<TProvider extends WatchingProvider>(
  provider: TProvider,
  options: BoundedProviderOptions,
): TProvider {
  const log = options.log ?? ((line: string) => console.log(line));
  const askDirectly =
    options.landed ??
    (async (what: 'transaction' | 'contract', subject: string): Promise<boolean> =>
      what === 'transaction'
        ? (await queryTransactionByIdentifier(options.indexerHttpUrl, subject)).landed
        : queryContractExists(options.indexerHttpUrl, subject));

  const bound = async <T>(
    what: string,
    subject: string,
    call: (from: WatchingProvider) => Promise<T>,
    landed: () => Promise<boolean>,
  ): Promise<T> => {
    try {
      const result = await withDeadline(
        () => call(provider),
        options.confirmTimeoutMs,
        (waitedMs) => new ConfirmationTimeout(what, subject, waitedMs),
      );
      progress('seen-on-chain');
      return result;
    } catch (cause) {
      if (!isConfirmationTimeout(cause)) throw cause;
      log(
        `[job] the indexer has not reported ${what} ${subject} in ${Math.round(options.confirmTimeoutMs / 1_000)} s — asking it directly`,
      );
      if (!(await landed())) throw cause;
      log(`[job] ${what} ${subject} is on chain — retrying the watch on a fresh indexer client`);
      const result = await withDeadline(
        async () => call(await options.fresh()),
        options.confirmTimeoutMs,
        (waitedMs) => new ConfirmationTimeout(what, subject, waitedMs),
      );
      progress('seen-on-chain (direct query)');
      return result;
    }
  };

  /* Prototype-preserving: `indexerPublicDataProvider` returns a CLASS instance,
     and midnight-js calls methods this wrapper does not name. Spreading it
     would drop every one of them. */
  const wrapper = Object.create(provider) as TProvider;
  Object.assign(wrapper, {
    watchForTxData: (txId: string) =>
      bound(
        'transaction',
        txId,
        (from) => from.watchForTxData(txId),
        () => askDirectly('transaction', txId),
      ),
    watchForDeployTxData: (address: string) =>
      bound(
        'the deploy of',
        address,
        (from) => from.watchForDeployTxData(address),
        () => askDirectly('contract', address),
      ),
    watchForContractState: (address: string) =>
      bound(
        'the state of',
        address,
        (from) => from.watchForContractState(address),
        () => askDirectly('contract', address),
      ),
  });
  return wrapper;
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
    /* Bounded, because midnight-js waits on these three with no deadline at
       all — see `boundedPublicDataProvider`. */
    publicDataProvider: boundedPublicDataProvider(
      (await publicDataProviderFor(config)) as never,
      {
        confirmTimeoutMs: config.confirmTimeoutMs,
        fresh: async () => (await publicDataProviderFor(config)) as never,
        indexerHttpUrl: config.indexerHttpUrl,
      },
    ),
    zkConfigProvider: options.zkConfigProvider,
    proofProvider: options.proofProvider,
    walletProvider: options.walletProvider,
    midnightProvider: options.walletProvider,
  };
}
