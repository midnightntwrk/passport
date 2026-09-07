/**
 * How long Passport waits on the chain before it carries on with what it
 * already knows.
 *
 * THE DEFECT THIS WAS WRITTEN FOR (2026/09/07)
 * --------------------------------------------
 * A reviewer sat on "Setting up your account… Taking a little longer than
 * usual" until they gave up. Their account transaction was in block 359977
 * five seconds after it was submitted. Nothing was wrong with the chain, the
 * sponsor, or the transaction: what was wrong was the WAIT.
 *
 * The wallet SDK submits through a polkadot-js subscription and waits for the
 * node's `Finalized` event with no bound at all
 * (`@midnight-ntwrk/wallet-sdk-facade/dist/index.js:227-233`). polkadot-js
 * never re-creates an `author_*` subscription after a websocket drop and never
 * errors it (`@polkadot/rpc-provider` `ws/index.js`, `onSocketClose`), so a
 * drop anywhere between the submit and finality — an Android radio handoff, a
 * screen locked after the biometric — leaves that promise pending for the life
 * of the tab. Every step behind it waits with it, silently, for ever.
 *
 * A wait that cannot end is worse than a wait that ends early with an honest
 * answer, because the honest answer was available the whole time: the
 * transaction identifier is known LOCALLY before anything is submitted, and
 * the indexer is asked about it afterwards regardless. So every wait on the
 * chain in this app now has a bound, and reaching that bound is not a failure
 * — it is the moment Passport stops listening and starts asking.
 *
 * WHAT IS HERE, AND WHY IT IS HERE AND NOT AT THE CALL SITES
 * ---------------------------------------------------------
 * Three rules, and nothing else: bound a wait, notice a connection going away
 * while it runs, and poll a question until it answers or the window closes.
 * They hold no SDK, no DOM, no `fetch`, no clock of their own and no timers of
 * their own where it matters — the clock and the sleep are injected — so all
 * of it is drilled directly in `./chainWait.test.ts`. The call sites in
 * `../identity/` hold the SDK shapes and nothing else.
 */

/**
 * How long a submit waits for the node before it answers with the transaction
 * identifier it already holds.
 *
 * Sixty seconds against a stagenet where inclusion is one block (six seconds)
 * and finality lag was measured at two blocks on 2026/09/07. It is not a
 * timeout in the usual sense — nothing fails when it expires and nothing is
 * given back to the sponsor, because the transaction may perfectly well be in
 * flight. It is the point at which waiting stops being the best way to find
 * out.
 */
export const SUBMIT_WAIT_MS = 60_000;

/**
 * How long the deployment watch is given before the contract's own state is
 * read back instead.
 *
 * Two minutes, which is an order of magnitude more than the 13.2–14.1 s of
 * indexer lag measured on stagenet on 2026/08/31 — so a wait that reaches it
 * is not a slow indexer, it is a subscription that is never going to speak.
 * The read-back that follows answers the same question by asking rather than
 * listening.
 */
export const SETTLE_WATCH_MS = 120_000;

/* -------------------------------------------------------------------------- */
/* Noticing a connection that has gone away                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whatever can say that the connection carrying a wait has gone.
 *
 * Two things can, and they are asked in that order: the node's own provider
 * where the SDK exposes one, and failing that the device's own radio — which
 * is what actually moves during the Android handoff this was written for.
 */
export interface ConnectionWatch {
  /** True when the connection is known to be down right now. */
  isDown(): boolean;
  /** Calls `listener` when it goes down. Returns an unregister function. */
  onDown(listener: (reason: string) => void): () => void;
}

/** The shape a polkadot-js `ApiPromise` or provider presents. */
interface ProviderLike {
  isConnected: boolean;
  on(event: string, handler: () => void): unknown;
  off(event: string, handler: () => void): unknown;
}

function providerLike(candidate: unknown): ProviderLike | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const provider = candidate as Partial<ProviderLike>;
  if (typeof provider.isConnected !== 'boolean') return null;
  if (typeof provider.on !== 'function' || typeof provider.off !== 'function') return null;
  return provider as ProviderLike;
}

/**
 * A watch over a polkadot-js provider, or null when `candidate` is not one.
 *
 * Duck-typed deliberately. The wallet SDK builds its submission service's
 * `PolkadotNodeClient` behind a closed-over `Deferred` and hands back only
 * `submitTransaction` and `close`, so there is no reachable `api` on this
 * build; this exists so that the day one IS reachable, the better signal is
 * used without another change here.
 */
export function providerConnectionWatch(candidate: unknown): ConnectionWatch | null {
  const provider = providerLike(candidate);
  if (!provider) return null;
  return {
    isDown: () => provider.isConnected === false,
    onDown: (listener) => {
      const handler = () => listener('the connection to Midnight dropped');
      provider.on('disconnected', handler);
      return () => provider.off('disconnected', handler);
    },
  };
}

/** The shape a browser `window` presents to this. */
interface DeviceLike {
  addEventListener(event: string, handler: () => void): unknown;
  removeEventListener(event: string, handler: () => void): unknown;
  navigator: { onLine: boolean };
}

function deviceLike(candidate: unknown): DeviceLike | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const device = candidate as Partial<DeviceLike>;
  if (typeof device.addEventListener !== 'function') return null;
  if (typeof device.removeEventListener !== 'function') return null;
  if (typeof device.navigator?.onLine !== 'boolean') return null;
  return device as DeviceLike;
}

/**
 * A watch over the DEVICE's own network, or null where nothing can say.
 *
 * The fallback, and the one that actually fires on the phone: a radio handoff
 * takes the websocket with it, and `offline` is the browser's own word for
 * that. It is not a statement about the node — the node may be perfectly
 * reachable from somewhere else — which is why nothing that reads it treats it
 * as a failure. It ends a wait; it does not decide an outcome.
 */
export function deviceConnectionWatch(candidate: unknown): ConnectionWatch | null {
  const device = deviceLike(candidate);
  if (!device) return null;
  return {
    isDown: () => device.navigator.onLine === false,
    onDown: (listener) => {
      const handler = () => listener('this device lost its network connection');
      device.addEventListener('offline', handler);
      return () => device.removeEventListener('offline', handler);
    },
  };
}

/**
 * The best watch available: the first candidate that is a node provider, and
 * failing all of them the device itself. Null when nothing can answer, which
 * is a perfectly ordinary answer — the wait is then bounded by time alone.
 */
export function connectionWatchFor(
  providers: readonly unknown[],
  device: unknown,
): ConnectionWatch | null {
  for (const candidate of providers) {
    const watch = providerConnectionWatch(candidate);
    if (watch) return watch;
  }
  return deviceConnectionWatch(device);
}

/* -------------------------------------------------------------------------- */
/* Bounding one wait                                                          */
/* -------------------------------------------------------------------------- */

/** How a bounded wait ended. */
export type ChainWaitOutcome<T> =
  /** The thing being waited for answered. */
  | { via: 'answer'; value: T }
  /** The window closed first. Nothing failed; nothing is known yet either. */
  | { via: 'deadline'; reason: string }
  /** The connection carrying the wait went away first. Same: nothing failed. */
  | { via: 'disconnected'; reason: string };

/**
 * Waits for `work`, but never for longer than `deadlineMs` and never past the
 * connection carrying it going away.
 *
 * REJECTS when `work` rejects, unchanged and at any time — a refusal is an
 * answer and it must travel. Resolving early is NOT a refusal, which is the
 * whole distinction this type exists to make: `deadline` and `disconnected`
 * both mean "ask someone else", and every caller here asks the indexer.
 *
 * `work`'s own rejection is always handled, whether or not this promise is
 * still listening, so a wait abandoned at the deadline cannot become an
 * unhandled rejection in the tab minutes later.
 */
export function waitBounded<T>(
  work: Promise<T>,
  options: { deadlineMs: number; watch?: ConnectionWatch | null },
): Promise<ChainWaitOutcome<T>> {
  const { deadlineMs, watch = null } = options;
  return new Promise<ChainWaitOutcome<T>>((resolve, reject) => {
    let settled = false;
    let unwatch: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (act: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (unwatch) unwatch();
      act();
    };

    work.then(
      (value) => finish(() => resolve({ via: 'answer', value })),
      /* The original rejection, forwarded exactly as it arrived — an SDK that
         rejects with something that is not an `Error` is still telling the
         caller what happened, and re-wrapping it would hide it. */
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      (cause: unknown) => finish(() => reject(cause)),
    );

    /* Already gone before the wait even started — which is the state a tab
       resumed from the background is in more often than not. */
    if (watch?.isDown()) {
      finish(() => resolve({ via: 'disconnected', reason: 'the connection was already down' }));
      return;
    }
    if (watch) {
      unwatch = watch.onDown((reason) =>
        finish(() => resolve({ via: 'disconnected', reason })),
      );
    }
    timer = setTimeout(() => {
      finish(() =>
        resolve({
          via: 'deadline',
          reason: `nothing answered within ${Math.round(deadlineMs / 1_000)}s`,
        }),
      );
    }, deadlineMs);
  });
}

/* -------------------------------------------------------------------------- */
/* Asking, rather than listening                                              */
/* -------------------------------------------------------------------------- */

/**
 * Asks `read` until it says yes or the window closes.
 *
 * The other half of the rule above: where a subscription cannot be trusted to
 * speak, the same fact is available by asking repeatedly, and asking has a
 * natural end. A read that THROWS counts as a no — an indexer that could not
 * be reached and a contract that is not there are the same silence, and
 * neither is worth abandoning the window for.
 *
 * `false` means the window closed without a yes. It never means "no": the
 * caller decides what an unanswered question is worth.
 */
export async function pollUntilTrue(
  read: () => Promise<boolean>,
  options: {
    windowMs: number;
    intervalMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  const { windowMs, intervalMs } = options;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + windowMs;
  for (;;) {
    let answered = false;
    try {
      answered = await read();
    } catch {
      // Unreachable and absent are the same silence here; keep asking.
    }
    if (answered) return true;
    /* Not after the last look. A sleep nobody is going to read the result of
       is a window that closes later than it says it does. */
    if (now() + intervalMs > deadline) return false;
    await sleep(intervalMs);
  }
}

/* -------------------------------------------------------------------------- */
/* The identifier a submit already holds                                      */
/* -------------------------------------------------------------------------- */

/**
 * The transaction identifier a finalized transaction carries, or null.
 *
 * This is the value `WalletFacade.submitTransaction` answers with —
 * `tx.identifiers().at(-1)` — and the point is that it is known LOCALLY,
 * before the node has said anything at all. It is what lets a submit stop
 * waiting without inventing anything: the identifier a bounded submit returns
 * is the identifier the unbounded one would have returned.
 *
 * Null rather than a guess for every shape that is not that, including a
 * `identifiers()` that throws — a caller with no identifier has nothing to
 * carry on WITH, and must keep waiting rather than answer with a lie.
 */
export function transactionIdentifierOf(tx: unknown): string | null {
  if (!tx || typeof tx !== 'object') return null;
  const identifiers = (tx as { identifiers?: unknown }).identifiers;
  if (typeof identifiers !== 'function') return null;
  let list: unknown;
  try {
    list = (identifiers as () => unknown).call(tx);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const last: unknown = list.at(-1);
  return typeof last === 'string' && last.length > 0 ? last : null;
}
