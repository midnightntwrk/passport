/**
 * ONE FETCH PER ZK ARTEFACT, INSTEAD OF THREE.
 *
 * THE DEFECT THIS IS THE PURE HALF OF
 * -----------------------------------
 * A shielded leg is the largest allocation Passport ever makes, and most of it
 * is the same bytes fetched over and over. Measured live on stagenet against
 * bf5a527, 2026/09/03, one mUSD send to a `.night` name — `withdraw_shielded`
 * out of the sender's account, `deposit_shielded` into the recipient's:
 *
 *     +1.04s  GET /zk/account/keys/withdraw_shielded.prover   19,532,231 B
 *     +8.09s  GET /zk/account/keys/withdraw_shielded.prover   19,532,231 B
 *     +8.20s  GET /zk/account/keys/withdraw_shielded.prover   19,532,231 B
 *    +38.37s  GET /zk/account/keys/deposit_shielded.prover    19,482,922 B
 *    +45.16s  GET /zk/account/keys/deposit_shielded.prover    19,482,922 B
 *    +45.26s  GET /zk/account/keys/deposit_shielded.prover    19,482,922 B
 *
 * 117 MB downloaded, hashed for integrity, and handed to the garbage collector
 * for a transaction that needs 39 MB of it. The renderer's resident memory went
 * 330 MB at rest → 711 MB across leg one's reads → 787 MB across leg two's:
 * the only allocations of that size anywhere in the app.
 *
 * THREE ASKS, NONE OF THEM AWARE OF THE OTHERS. midnight-js reaches a ZK config
 * provider from three places per contract circuit:
 *
 *   1. `lookupKey`, which the ledger calls on the proving provider before it
 *      proves a contract call;
 *   2. `check`, whose payload is built from the IR ALONE — the prover key it
 *      fetched is discarded unread;
 *   3. `prove`, which is the one that uses it.
 *
 * Neither library layer holds the bytes between those. `ZKConfigRegistry`
 * memoises which SOURCE serves a key location and says why it does not memoise
 * more ("so it can be held for the registry's lifetime without retaining
 * artifact bytes"); `FetchZkConfigProvider` memoises the integrity manifest and
 * nothing else, so every `getProverKey` is a fresh GET, a fresh `Uint8Array`,
 * and a fresh SHA-256 over 19.5 MB.
 *
 * WHY IT IS WORTH FIXING RATHER THAN TOLERATING. On 2026/09/03 at 16:30:46 UTC
 * a headless browser running two Passports died 0.8 s into a mUSD send, in the
 * window where leg one's artefacts are read, on a host with 14 MB of free
 * memory and 1.1 GB of swap left. That death has NOT been reproduced — a single
 * Passport on the same build completes the same send — so this module does not
 * claim to be its cause. What it does claim is measured and checkable: the
 * shielded path asked for three times the memory it needed at exactly the
 * moment the browser had none to spare.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not hold artefacts for ever. A prover key nothing has asked for in
 * {@link ZK_ARTEFACT_IDLE_MS} is dropped, so a Passport left open on Home is
 * not sitting on 39 MB of keys it has finished with — the peak comes down
 * without the resting figure going up to pay for it.
 *
 * It does not memoise a REJECTION, on `FetchZkConfigProvider.loadManifest`'s
 * own rule: one bad moment on the network must not become permanent for the
 * life of the tab.
 *
 * It does not sweep on a timer. A timer is a thing to leak and a thing to stop;
 * the sweep happens on the way into a read, which is the only moment the answer
 * could matter.
 *
 * It holds no DOM, no React, no `fetch`, and no clock of its own — the provider
 * and the clock are injected — so all of it is drilled in
 * `src/lib/zkArtefactCache.test.ts`. The provider it wraps, and the one place
 * it is wrapped, are `src/identity/contractRuntime.ts`, which stays out of the
 * denominator with the rest of the midnight-js plumbing.
 */

/**
 * How long an artefact is kept after the last read that wanted it.
 *
 * Long enough to cover a whole two-leg send — 45 s from leg one's first
 * artefact read to leg two's last, measured above — and short enough that the
 * keys are gone well before a reader could have started another send.
 */
export const ZK_ARTEFACT_IDLE_MS = 90_000;

/**
 * What this module needs of the provider it wraps: the three artefact reads
 * `ZKConfigProvider` declares abstract. Everything else that class offers —
 * `get`, `getVerifierKeys`, `asKeyMaterialProvider` — is built out of these
 * three and comes along unchanged.
 */
export interface ZkArtefactSource {
  getProverKey(circuitId: string): Promise<unknown>;
  getVerifierKey(circuitId: string): Promise<unknown>;
  getZKIR(circuitId: string): Promise<unknown>;
}

export interface ZkArtefactCacheOptions {
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to {@link ZK_ARTEFACT_IDLE_MS}. */
  idleMs?: number;
}

/**
 * Wraps a ZK config provider so each artefact is fetched once.
 *
 * `Object.create` rather than a subclass, and that is the whole trick: the
 * returned object's prototype IS the provider, so the inherited `get` and
 * `getVerifierKeys` reach these overrides through `this` and are memoised
 * without being reimplemented, and an `instanceof` check anywhere downstream
 * still answers what it answered before. Reimplementing them here would be a
 * second copy of midnight-js's own composition rules, which is exactly the
 * thing that goes stale.
 *
 * @param provider The provider to wrap. It is never mutated.
 * @returns A view of `provider` that fetches each artefact at most once per
 * {@link ZkArtefactCacheOptions.idleMs} of idleness.
 */
export function memoisingZkConfigProvider<P extends ZkArtefactSource>(
  provider: P,
  options: ZkArtefactCacheOptions = {},
): P {
  const now = options.now ?? ((): number => Date.now());
  const idleMs = options.idleMs ?? ZK_ARTEFACT_IDLE_MS;
  const held = new Map<string, { artefact: Promise<unknown>; readAt: number }>();

  const once = (key: string, fetchIt: () => Promise<unknown>): Promise<unknown> => {
    const at = now();
    for (const [heldKey, entry] of [...held]) {
      if (at - entry.readAt >= idleMs) held.delete(heldKey);
    }
    const existing = held.get(key);
    if (existing !== undefined) {
      existing.readAt = at;
      return existing.artefact;
    }
    const artefact = fetchIt();
    held.set(key, { artefact, readAt: at });
    /* A failure is forgotten rather than remembered — and only if it is still
       the entry that failed, so a retry already in flight is not evicted. */
    artefact.catch(() => {
      if (held.get(key)?.artefact === artefact) held.delete(key);
    });
    return artefact;
  };

  const view = Object.create(provider) as P;
  Object.assign(view, {
    getProverKey: (circuitId: string): Promise<unknown> =>
      once(`prover:${circuitId}`, () => provider.getProverKey(circuitId)),
    getVerifierKey: (circuitId: string): Promise<unknown> =>
      once(`verifier:${circuitId}`, () => provider.getVerifierKey(circuitId)),
    getZKIR: (circuitId: string): Promise<unknown> =>
      once(`zkir:${circuitId}`, () => provider.getZKIR(circuitId)),
  });
  return view;
}
