// In-browser (zkir-v2 wasm) proving for the Passport demo.
//
// Ported from `experiments/account-custody-prototype/app/src/lib/wasmProver.ts`
// with one deliberate change: the prototype's `txTracker` import is gone, and
// the prove-busy signal is a local emitter (`onProving`) so this module has no
// dependency on any UI state container.
//
// The wasm prover runs in a dedicated worker (`./proofWorker.ts`) so the UI
// stays live during the seconds-to-tens-of-seconds a PLONK proof takes; this
// module owns key resolution on the main thread and proxies it to the worker
// per request — the same split the wallet SDK's own WasmProver uses. Key
// material for contract circuits resolves through the SAME
// FetchZkConfigProvider the HTTP path uses; system (balancing) circuits and
// SRS slices are served from `/zk-params`, byte-identical to the files the
// proof server downloads and verifies from the public bucket.
//
// Selected with `?prover=browser` or `VITE_BROWSER_PROVER=1`, and now also
// whenever no proof server is configured — which is the stagenet default,
// because stagenet publishes none (see `./localWallet.ts`). With this prover in
// play, no proof server is contacted anywhere in the stack. If the `/zk-params`
// tree has not been staged, the fetch below fails with an explicit instruction
// and that failure reaches the caller unmasked — there is no silent fallback to
// a remote proof server, because "the proof was computed locally" must never be
// claimed falsely.
//
// LEDGER-9: only the `CostModel` import moved (to `@midnightntwrk/ledger-v9`,
// the hyphenless scope). The key layout below did not, and that is not luck:
// `SYSTEM_KEYS` already names the version-9 circuits (`zswap/9/spend`,
// `dust/9/spend`, …) from the same bucket the beta SDK's own
// `makeDefaultKeyMaterialProvider` reads, so the tree
// `scripts/fetch-zk-params.mjs` stages is byte-for-byte the one ledger-9 wants.
//
// This module — rather than the SDK's `makeWasmProvingService` — is what proves
// in the browser, and that is a build constraint rather than a preference. The
// SDK's prover starts its worker with
// `new Worker(new URL(`../../dist/proof-worker.js`, currentFile))` from inside
// `node_modules`: a template literal against a variable, which Vite's worker
// analysis does not rewrite, so the worker's own bare imports (`effect`,
// `@midnight-ntwrk/zkir-v2`) reach the browser unresolved. The `new
// Worker(new URL('./proofWorker.ts', import.meta.url), …)` below is the form
// Vite does rewrite. The SDK's service is used under Node instead, where the
// same code path works and no staging is needed.

import { CostModel } from '@midnightntwrk/ledger-v9';
import { ZKConfigRegistry, zkConfigToProvingKeyMaterial } from '@midnight-ntwrk/midnight-js-types';

interface ZkConfigProviderLike {
  get(keyLocation: string): Promise<unknown>;
}

interface KeyMaterial {
  proverKey: Uint8Array;
  verifierKey: Uint8Array;
  ir: Uint8Array;
}

interface KmProvider {
  lookupKey(keyLocation: string): Promise<KeyMaterial | undefined>;
  getParams(k: number): Promise<Uint8Array>;
}

// ——— proving-busy signal (replaces the prototype's txTracker) ———

type ProvingListener = (busy: boolean) => void;
const provingListeners = new Set<ProvingListener>();
let provingDepth = 0;

/**
 * Subscribes to "a proof is being computed in this tab" transitions. Fires
 * `true` when the first proof starts and `false` when the last one finishes.
 * Returns an unsubscribe function.
 */
export function onProving(listener: (busy: boolean) => void): () => void {
  provingListeners.add(listener);
  return () => provingListeners.delete(listener);
}

function emitProving(busy: boolean): void {
  for (const listener of provingListeners) {
    try {
      listener(busy);
    } catch (cause) {
      console.debug('[wasm-prover] proving listener threw', cause);
    }
  }
}

function proveStarted(): void {
  provingDepth += 1;
  if (provingDepth === 1) emitProving(true);
}

function proveEnded(): void {
  provingDepth = Math.max(0, provingDepth - 1);
  if (provingDepth === 0) emitProving(false);
}

// ——— key material (main thread, cached) ———

const cache = new Map<string, unknown>();

async function fetchBytes(path: string, what: string): Promise<Uint8Array> {
  const resp = await fetch(path);
  // A 404 is only one of the two ways these files can be absent. Vite's dev
  // server answers an unknown path with the SPA fallback — `index.html`, HTTP
  // 200, `Content-Type: text/html` (verified against this app's dev server on
  // 2026/08/05) — so `resp.ok` alone would hand the prover a page of HTML and
  // produce a baffling wasm error instead of "stage your parameters". Anything
  // that is HTML is treated as missing.
  const contentType = resp.headers.get('content-type') ?? '';
  if (!resp.ok || contentType.includes('text/html')) {
    throw new Error(
      `missing ${what} (${path}) — run scripts/fetch-zk-params.mjs to stage examples/passport-demo/public/zk-params`,
    );
  }
  return new Uint8Array(await resp.arrayBuffer());
}

async function getParams(k: number): Promise<Uint8Array> {
  const key = `srs-${k}`;
  if (!cache.has(key)) {
    console.debug(`[wasm-prover] getParams: k=${k}`);
    cache.set(key, await fetchBytes(`/zk-params/bls_midnight_2p${k}`, `SRS slice for k=${k}`));
  }
  return cache.get(key) as Uint8Array;
}

// System (balancing) circuits, mirroring the proof server's key layout.
const SYSTEM_KEYS: Record<string, string> = {
  'midnight/zswap/spend': 'zswap/9/spend',
  'midnight/zswap/output': 'zswap/9/output',
  'midnight/zswap/sign': 'zswap/9/sign',
  'midnight/dust/spend': 'dust/9/spend',
};

async function lookupSystemKey(keyLocation: string): Promise<KeyMaterial | undefined> {
  const path = SYSTEM_KEYS[keyLocation];
  if (!path) return undefined;
  if (!cache.has(path)) {
    const [proverKey, verifierKey, ir] = await Promise.all([
      fetchBytes(`/zk-params/${path}.prover`, `${keyLocation} prover key`),
      fetchBytes(`/zk-params/${path}.verifier`, `${keyLocation} verifier key`),
      fetchBytes(`/zk-params/${path}.bzkir`, `${keyLocation} IR`),
    ]);
    cache.set(path, { proverKey, verifierKey, ir });
  }
  return cache.get(path) as KeyMaterial;
}

// ——— worker plumbing ———
// One shared worker; each in-flight request carries its own KmProvider so
// the worker's key-material callbacks route back to the right resolver.

/**
 * How long a request may go without a WORD from the worker before the worker
 * is presumed dead.
 *
 * It is an IDLE bound, not a total one, and that distinction is the whole
 * design. A first shielded send legitimately takes minutes: roughly 54 MB of
 * proving keys comes down before any arithmetic starts, and the proof itself
 * runs 20–60 seconds on a phone. But none of that is silent — every key the
 * wasm needs arrives as a `km` request on this channel, and finishing produces
 * a result. So progress is observable, and a channel that says nothing at all
 * for this long is not slow, it is gone.
 *
 * WHAT IT IS FOR. iOS reclaims memory by killing the WebContent process or
 * jettisoning a worker outright, and neither produces an `error` event: the
 * worker simply stops answering. `callWorker` had no timeout, no signal, and
 * no cancellation, so a proof interrupted by the user switching apps left a
 * spinner that never resolved — for ever, on the send screen, after the money
 * may already have moved.
 */
export const PROOF_WORKER_IDLE_MS = 90_000;

/**
 * What the user is told when the proof did not come back, in words that name
 * something they can do.
 *
 * It says nothing about workers, processes, or wasm. What a reader can act on
 * is that the screen has to stay open, which is the actual cause on a phone.
 */
export const PROOF_UNFINISHED_MESSAGE =
  'The proof did not finish on this device. Keep this screen open and try again — leaving Passport while it works can stop it part-way.';

interface WorkerRequest {
  op: 'prove' | 'check';
  preimage: Uint8Array;
  obi?: bigint;
}

interface PendingRequest {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  km: KmProvider;
  /** Kept so the request can be replayed onto a fresh worker exactly once. */
  request: WorkerRequest;
  replayed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

let worker: Worker | null = null;
let nextReqId = 1;
const pending = new Map<number, PendingRequest>();

/**
 * How a proof worker is spawned. A seam rather than a bare `new Worker` so the
 * restart logic above can be driven in a test without a real worker, and so
 * `spawnProofWorker` stays the single place the Vite-rewritable form is
 * written. See the module header for why that form is load-bearing.
 */
let spawnProofWorker: () => Worker = () =>
  new Worker(new URL('./proofWorker.ts', import.meta.url), { type: 'module' });

/**
 * Replaces the spawn seam and tears down whatever is running. Pass `null` to
 * restore the real one. Tests only.
 */
export function setProofWorkerSpawn(spawn: (() => Worker) | null): void {
  disposeWorker();
  for (const [id, request] of pending) {
    if (request.timer) clearTimeout(request.timer);
    pending.delete(id);
  }
  spawnProofWorker =
    spawn ??
    (() => new Worker(new URL('./proofWorker.ts', import.meta.url), { type: 'module' }));
}

function disposeWorker(): void {
  const current = worker;
  worker = null;
  try {
    current?.terminate();
  } catch {
    /* A worker that will not terminate is one we have already stopped
       listening to; there is nothing further to do about it and nothing worth
       failing a send over. */
  }
}

/** Restarts the idle clock for one request. Any word from the worker is progress. */
function markProgress(id: number): void {
  const request = pending.get(id);
  if (!request) return;
  if (request.timer) clearTimeout(request.timer);
  request.timer = setTimeout(() => stalled(id), PROOF_WORKER_IDLE_MS);
}

/**
 * The worker has said nothing for {@link PROOF_WORKER_IDLE_MS}. Presume it is
 * gone: take it down, replay every request that has not yet had its second
 * chance onto a fresh one, and fail the rest in plain words.
 *
 * Every in-flight request is replayed, not just the one whose clock expired,
 * because they were all on the worker that just died — leaving them parked on
 * a terminated channel is the hang this exists to end.
 */
function stalled(id: number): void {
  console.debug(`[wasm-prover] proof worker went quiet on req ${id}; restarting`);
  disposeWorker();
  const stranded = [...pending.entries()];
  for (const [requestId, request] of stranded) {
    if (request.timer) clearTimeout(request.timer);
    request.timer = null;
    if (request.replayed) {
      pending.delete(requestId);
      request.reject(new Error(PROOF_UNFINISHED_MESSAGE));
    }
  }
  const replayable = [...pending.entries()];
  if (replayable.length === 0) return;
  const restarted = ensureWorker();
  for (const [requestId, request] of replayable) {
    request.replayed = true;
    post(restarted, requestId, request.request);
    markProgress(requestId);
  }
}

/**
 * Copies key material out of the main-thread cache and hands the COPIES to the
 * worker by transfer.
 *
 * The cache's own buffers are never transferred: transferring detaches, and a
 * detached prover key is a cache entry that fails every proof after the first.
 * So the copy is what moves. What that buys over a bare structured clone is
 * one allocation instead of two — the clone would copy into the worker on top
 * of whatever the reply already held — and, with the worker's own cache, a
 * repeat lookup within a session that costs neither.
 */
function transferable(result: unknown): { payload: unknown; transfer: ArrayBuffer[] } {
  if (result instanceof Uint8Array) {
    const copy = new Uint8Array(result);
    return { payload: copy, transfer: [copy.buffer as ArrayBuffer] };
  }
  if (result && typeof result === 'object') {
    const source = result as Record<string, unknown>;
    const payload: Record<string, unknown> = { ...source };
    const transfer: ArrayBuffer[] = [];
    for (const [key, value] of Object.entries(source)) {
      if (!(value instanceof Uint8Array)) continue;
      const copy = new Uint8Array(value);
      payload[key] = copy;
      transfer.push(copy.buffer as ArrayBuffer);
    }
    return { payload, transfer };
  }
  return { payload: result, transfer: [] };
}

function post(target: Worker, id: number, request: WorkerRequest): void {
  const { op, preimage, obi } = request;
  console.debug(`[wasm-prover] → worker: ${op} (req ${id}, ${preimage.length} bytes)`);
  target.postMessage({ id, op, preimage, obi });
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = spawnProofWorker();
  worker.onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    if (msg.ready) {
      console.debug('[wasm-prover] proof worker ready');
      return;
    }
    if (msg.km !== undefined) {
      const keyRequest = pending.get(msg.id);
      if (!keyRequest || !worker) return;
      // A key request IS progress: the worker is alive and working through
      // this proof, however long the download behind it takes.
      markProgress(msg.id);
      const target = worker;
      try {
        const result =
          msg.km === 'lookupKey'
            ? await keyRequest.km.lookupKey(msg.arg)
            : await keyRequest.km.getParams(msg.arg);
        // The worker may have been restarted while this resolved; a reply to a
        // channel nobody is listening on is dropped rather than thrown.
        if (worker !== target) return;
        markProgress(msg.id);
        const { payload, transfer } = transferable(result);
        target.postMessage({ kmReply: msg.kmId, result: payload }, transfer);
      } catch (err: any) {
        if (worker !== target) return;
        target.postMessage({ kmReply: msg.kmId, error: String(err?.message ?? err) });
      }
      return;
    }
    const req = pending.get(msg.id);
    if (!req) return;
    if (req.timer) clearTimeout(req.timer);
    pending.delete(msg.id);
    if (msg.err !== undefined) req.reject(new Error(msg.err));
    else req.resolve(msg.ok);
  };
  worker.onerror = (e: ErrorEvent) => {
    console.debug(`[wasm-prover] proof worker crashed: ${e.message}`);
    /* A crash IS an answer, unlike the silence `stalled` handles, but it is
       answered the same way: one fresh worker and one replay each. A
       WebContent process taken down under memory pressure is not a fact about
       this transaction. */
    disposeWorker();
    for (const request of pending.values()) request.timer = null;
    stalled(-1);
  };
  return worker;
}

function callWorker(
  op: 'prove' | 'check',
  km: KmProvider,
  preimage: Uint8Array,
  obi?: bigint,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextReqId++;
    // Copy before posting: the ledger may hand us a view over its wasm
    // memory, and structured clone would clone the entire backing buffer.
    // The copy is kept, because a replay onto a fresh worker needs it again.
    const request: WorkerRequest = { op, preimage: new Uint8Array(preimage), obi };
    pending.set(id, { resolve, reject, km, request, replayed: false, timer: null });
    post(ensureWorker(), id, request);
    markProgress(id);
  });
}

// The ledger's two-method ProvingProvider, computed in the worker. The
// keyLocation argument is unused by the wasm side: the preimage embeds its
// own location, which comes back through the km proxy.
function workerProvingProvider(km: KmProvider): any {
  return {
    check: (preimage: Uint8Array, _keyLocation: string) => callWorker('check', km, preimage),
    prove: (preimage: Uint8Array, _keyLocation: string, obi?: bigint) =>
      callWorker('prove', km, preimage, obi),
  };
}

// ——— public surface ———

/**
 * The ledger's circuit-level `{ check, prove }` provider for CONTRACT circuits,
 * resolving contract keys through the given ZK config provider and the four
 * system (balancing) circuits from `/zk-params`.
 *
 * Returned at this level rather than as a finished `ProofProvider` because
 * midnight-js 5 ships its own transaction-level adapter, `createProofProvider`,
 * and going through it means the cost model and the prove/check sequencing are
 * the library's rather than a second implementation of them here. See
 * `../identity/contractRuntime.ts`.
 */
export function wasmProvingProvider(zkConfigProvider: ZkConfigProviderLike): any {
  /* The registry joins a CANONICAL key location — contract address, circuit,
     and the verifier-key hash the deployed contract carries — against our
     staged artefacts, refusing a build whose verifier key differs from what is
     on chain. A bare circuit name (what a DEPLOY preimage carries, there being
     no address yet) resolves straight from the provider; anything else is a
     protocol builtin served from the system bucket. Same order the balancer
     proves with in-process. */
  const registry = new ZKConfigRegistry([zkConfigProvider as never]);
  const km: KmProvider = {
    lookupKey: async (keyLocation: string) => {
      console.debug(`[wasm-prover] lookupKey: ${keyLocation}`);
      const system = await lookupSystemKey(keyLocation);
      if (system) return system;
      const resolved = await registry.resolveKeyLocation(keyLocation);
      if (resolved !== undefined) {
        return zkConfigToProvingKeyMaterial(resolved as any) as KeyMaterial;
      }
      const zkConfig = await zkConfigProvider.get(keyLocation);
      return zkConfigToProvingKeyMaterial(zkConfig as any) as KeyMaterial;
    },
    getParams,
  };
  const inner = workerProvingProvider(km);
  /* The busy signal belongs here rather than in the worker plumbing: a contract
     proof is the slow thing a user waits through, and `onProving` is what the
     UI listens to.

     `lookupKey` is part of the ledger's `ProvingProvider` contract, not an
     internal of the worker protocol: midnight-js 5 calls it on the provider it
     is handed before proving a contract call ("expected proving provider
     property 'lookupKey' to be a function" — seen live on the first stagenet
     claim, 2026/08/24). It is the same resolver the worker proxies to. */
  return {
    check: (preimage: Uint8Array, keyLocation: string) => inner.check(preimage, keyLocation),
    prove: async (preimage: Uint8Array, keyLocation: string, obi?: bigint) => {
      proveStarted();
      try {
        return await inner.prove(preimage, keyLocation, obi);
      } finally {
        proveEnded();
      }
    },
    lookupKey: (keyLocation: string) => km.lookupKey(keyLocation),
  };
}

/**
 * Transaction-level proving for contract circuits, kept for callers that want
 * to drive `unprovenTx.prove` themselves. {@link wasmProvingProvider} through
 * midnight-js's `createProofProvider` is the path the app takes.
 */
export function wasmProofProvider(zkConfigProvider: ZkConfigProviderLike): any {
  const provingProvider = wasmProvingProvider(zkConfigProvider);
  return {
    async proveTx(unprovenTx: any) {
      return unprovenTx.prove(provingProvider, CostModel.initialCostModel());
    },
  };
}

/**
 * Wallet-side proving service (balancing: zswap spends/outputs/signs and dust
 * fee spends). Same shape the wallet SDK's `makeWasmProvingService` builds;
 * injected through `WalletFacade.init({ provingService })`.
 */
export function wasmWalletProvingService(): { prove(tx: any): Promise<any> } {
  const km: KmProvider = {
    lookupKey: async (keyLocation: string) => {
      console.debug(`[wasm-prover/wallet] lookupKey: ${keyLocation}`);
      return lookupSystemKey(keyLocation);
    },
    getParams,
  };
  const provingProvider = workerProvingProvider(km);
  return {
    prove: async (tx: any) => {
      proveStarted();
      try {
        return await tx.prove(provingProvider, CostModel.initialCostModel());
      } finally {
        proveEnded();
      }
    },
  };
}
