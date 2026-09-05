// Dedicated worker that runs the zkir-v2 wasm prover off the main thread,
// so the UI stays live during the seconds-to-tens-of-seconds a PLONK proof
// takes. Key material is resolved on the MAIN thread (it owns the
// FetchZkConfigProvider and the cache) and proxied here per request —
// the same split the wallet SDK's WasmProver uses.
//
// Ported verbatim from
// `experiments/account-custody-prototype/app/src/lib/proofWorker.ts`; the
// prototype's protocol is unchanged so the two stay diff-able.
//
// The zkir wasm is imported dynamically so a failed or slow wasm load is
// observable as a message instead of a silent dead worker.
//
// Protocol (structured clone; BigInt and Uint8Array are clone-safe):
//   main → worker  { id, op: 'prove' | 'check', preimage, obi? }
//   worker → main  { id, km: 'lookupKey' | 'getParams', kmId, arg }
//   main → worker  { kmReply: kmId, result }   (or { kmReply, error })
//   worker → main  { id, ok: result }          (or { id, err })

const ctx = self as any;

let zkirPromise: Promise<any> | null = null;
function getZkir(): Promise<any> {
  if (!zkirPromise) {
    console.debug('[proof-worker] loading zkir wasm…');
    zkirPromise = import('@midnight-ntwrk/zkir-v2').then((m) => {
      console.debug('[proof-worker] zkir wasm ready');
      return m;
    });
  }
  return zkirPromise;
}

let nextKmId = 1;
const kmPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

/**
 * Key material this worker has already been sent, held HERE rather than only
 * on the main thread.
 *
 * The main thread caches the bytes it fetched, but every request used to cross
 * the boundary again — tens of megabytes of prover key structured-cloned per
 * proof, per circuit, for the life of the tab. The main thread now hands over
 * copies by transfer, so the crossing costs a move rather than a copy, and this
 * cache means the second proof of a session does not make it at all.
 *
 * Keyed by the request's own argument, which is what identifies the material:
 * a key location for `lookupKey`, the `k` of an SRS slice for `getParams`.
 * Bounded by the size of the key set a build can ask for, which is fixed.
 *
 * It dies with the worker, so a worker restarted after iOS jettisoned this one
 * refills it from the main thread — which is the correct behaviour, not a gap.
 */
const kmCache = new Map<string, unknown>();

function kmRequest(requestId: number, km: 'lookupKey' | 'getParams', arg: string | number) {
  const cacheKey = `${km}:${arg}`;
  const cached = kmCache.get(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const kmId = nextKmId++;
    kmPending.set(kmId, {
      resolve: (value: any) => {
        /* `undefined` is a real answer from `lookupKey` — "this is not a system
           circuit" — and caching it would be indistinguishable from a miss, so
           it is left out rather than stored. It costs one round trip on a
           lookup that resolves elsewhere anyway. */
        if (value !== undefined) kmCache.set(cacheKey, value);
        resolve(value);
      },
      reject,
    });
    ctx.postMessage({ id: requestId, km, kmId, arg });
  });
}

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  if (msg.kmReply !== undefined) {
    const waiter = kmPending.get(msg.kmReply);
    if (!waiter) return;
    kmPending.delete(msg.kmReply);
    if (msg.error !== undefined) waiter.reject(new Error(msg.error));
    else waiter.resolve(msg.result);
    return;
  }

  const { id, op, preimage, obi } = msg;
  console.debug(`[proof-worker] ${op} request ${id} (${preimage?.length} bytes)`);
  // The preimage embeds its own key location; the wasm calls lookupKey with it.
  const kmProxy: any = {
    lookupKey: (keyLocation: string) => kmRequest(id, 'lookupKey', keyLocation),
    getParams: (k: number) => kmRequest(id, 'getParams', k),
  };
  try {
    const zkir = await getZkir();
    const result =
      op === 'prove'
        ? await zkir.prove(preimage, kmProxy, obi)
        : await zkir.check(preimage, kmProxy);
    // Copy before posting: wasm-bindgen may hand back a view over wasm
    // memory, and structured clone would clone the entire backing buffer.
    const ok = result instanceof Uint8Array ? new Uint8Array(result) : result;
    console.debug(`[proof-worker] ${op} request ${id} done`);
    ctx.postMessage({ id, ok });
  } catch (err: any) {
    console.debug(`[proof-worker] ${op} request ${id} FAILED: ${err?.message ?? err}`);
    ctx.postMessage({ id, err: String(err?.message ?? err) });
  }
};

console.debug('[proof-worker] entry evaluated');
ctx.postMessage({ ready: true });
