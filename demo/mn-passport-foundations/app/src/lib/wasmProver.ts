// Browser-side proving (see ../../BROWSER-PROVING-SCOPE.md).
//
// The zkir-v2 wasm prover runs in a dedicated worker (proofWorker.ts) so the
// UI stays live while a PLONK proof is computed; this module owns key
// resolution on the main thread and proxies it to the worker per request —
// the same split the wallet SDK's WasmProver uses. Key material for contract
// circuits resolves through the SAME FetchZkConfigProvider the HTTP path
// uses; system (balancing) circuits and SRS slices are served from
// /zk-params — byte-identical to the files the proof server downloads and
// verifies from the public bucket.
//
// Selected with `?prover=browser` (see providers.ts). With the flag set, no
// proof server is needed anywhere in the stack.

import { CostModel } from '@midnight-ntwrk/ledger-v8';
import { zkConfigToProvingKeyMaterial } from '@midnight-ntwrk/midnight-js-types';

import { proveStarted, proveEnded } from './txTracker.js';

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

// ——— key material (main thread, cached) ———

const cache = new Map<string, unknown>();

async function fetchBytes(path: string, what: string): Promise<Uint8Array> {
  const resp = await fetch(path);
  if (!resp.ok) {
    throw new Error(
      `missing ${what} (${path}) — run scripts/fetch-zk-params.mjs to stage app/public/zk-params`,
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

let worker: Worker | null = null;
let nextReqId = 1;
const pending = new Map<
  number,
  { resolve: (v: any) => void; reject: (e: Error) => void; km: KmProvider }
>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./proofWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    if (msg.ready) {
      console.debug('[wasm-prover] proof worker ready');
      return;
    }
    if (msg.km !== undefined) {
      const req = pending.get(msg.id);
      if (!req || !worker) return;
      try {
        const result =
          msg.km === 'lookupKey' ? await req.km.lookupKey(msg.arg) : await req.km.getParams(msg.arg);
        worker.postMessage({ kmReply: msg.kmId, result });
      } catch (err: any) {
        worker.postMessage({ kmReply: msg.kmId, error: String(err?.message ?? err) });
      }
      return;
    }
    const req = pending.get(msg.id);
    if (!req) return;
    pending.delete(msg.id);
    if (msg.err !== undefined) req.reject(new Error(msg.err));
    else req.resolve(msg.ok);
  };
  worker.onerror = (e: ErrorEvent) => {
    const error = new Error(`proof worker crashed: ${e.message}`);
    for (const req of pending.values()) req.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
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
    pending.set(id, { resolve, reject, km });
    // Copy before posting: the ledger may hand us a view over its wasm
    // memory, and structured clone would clone the entire backing buffer.
    const bytes = new Uint8Array(preimage);
    console.debug(`[wasm-prover] → worker: ${op} (req ${id}, ${bytes.length} bytes)`);
    ensureWorker().postMessage({ id, op, preimage: bytes, obi });
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

export function wasmProofProvider(zkConfigProvider: ZkConfigProviderLike): any {
  const km: KmProvider = {
    lookupKey: async (keyLocation: string) => {
      console.debug(`[wasm-prover] lookupKey: ${keyLocation}`);
      const system = await lookupSystemKey(keyLocation);
      if (system) return system;
      const zkConfig = await zkConfigProvider.get(keyLocation);
      return zkConfigToProvingKeyMaterial(zkConfig as any) as KeyMaterial;
    },
    getParams,
  };
  const provingProvider = workerProvingProvider(km);
  return {
    async proveTx(unprovenTx: any) {
      proveStarted();
      try {
        return await unprovenTx.prove(provingProvider, CostModel.initialCostModel());
      } finally {
        proveEnded();
      }
    },
  };
}

/**
 * Wallet-side proving service (balancing: zswap spends/outputs/signs and
 * dust fee spends). Same shape the wallet SDK's makeWasmProvingService
 * builds; injected through WalletFacade.init({ provingService }).
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
    prove: (tx: any) => tx.prove(provingProvider, CostModel.initialCostModel()),
  };
}
