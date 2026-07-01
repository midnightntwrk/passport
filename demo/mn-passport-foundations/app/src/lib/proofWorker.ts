// Dedicated worker that runs the zkir-v2 wasm prover off the main thread,
// so the UI stays live during the seconds-to-tens-of-seconds a PLONK proof
// takes. Key material is resolved on the MAIN thread (it owns the
// FetchZkConfigProvider and the cache) and proxied here per request —
// the same split the wallet SDK's WasmProver uses.
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

function kmRequest(requestId: number, km: 'lookupKey' | 'getParams', arg: string | number) {
  return new Promise((resolve, reject) => {
    const kmId = nextKmId++;
    kmPending.set(kmId, { resolve, reject });
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
