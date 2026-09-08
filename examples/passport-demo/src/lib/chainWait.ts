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
 * How long the ONE further attempt at that bound is given.
 *
 * THE BOUND WAS AN ASSUMPTION UNTIL 2026/09/08. {@link SUBMIT_WAIT_MS} ends a
 * wait and answers with the identifier this tab already holds, on the
 * reasoning that the bytes had reached the node and only the answer was lost.
 * That morning the reasoning was shown to be optimistic. Two transactions were
 * balanced by the sponsor between 09:15 and 09:33 UTC and were still not on
 * chain 122 seconds later — the sponsor released the fees it had booked for
 * them — and the person in front of the screen was told "Step 2 did not
 * finish" after a three-minute wait for a settlement that could never come.
 * The socket was already dead when the submit was made, so nothing was ever
 * sent, and every second after that was spent waiting for a transaction that
 * did not exist.
 *
 * So the bound now ASKS rather than assumes: the same signed bytes are offered
 * to the node once more. Twenty seconds, because everything expensive is
 * already behind it — the transaction is balanced, signed, and proved, and
 * this is one call over a socket that either exists or does not. It is over
 * three times the six-second block time and a third of the wait it follows, so
 * somebody who is already waiting is not asked to wait meaningfully longer for
 * an answer that changes what they are told.
 */
export const RESUBMIT_WAIT_MS = 20_000;

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

/* -------------------------------------------------------------------------- */
/* A submission the node never acknowledged                                   */
/* -------------------------------------------------------------------------- */

/**
 * How long the wait that FOLLOWS an unacknowledged submission is given.
 *
 * The fourth rule in this module, and the one 2026/09/08 bought. A submission
 * that was offered twice and acknowledged neither time is not the same thing as
 * a submission that was taken: it may be on chain, and it may equally never
 * have left the device. Both waits that follow one — three minutes between a
 * payment's two steps, two minutes on a new account's deployment — were chosen
 * against an indexer that had ALREADY accepted the transaction, where every
 * second past about fourteen is congestion rather than doubt. Against a
 * transaction nobody can say was sent, those minutes buy nothing and cost the
 * person the whole of them before they are told anything at all.
 *
 * A minute, then: still four times the worst indexer lag measured here, and
 * still long enough for a transaction that DID land to turn up, but a third of
 * the wait before somebody is told what happened and offered the card that
 * carries on. Nothing about the outcome changes — the record is left where it
 * was and the chain is asked again from Home — only how long the screen holds
 * them first.
 */
export const UNCONFIRMED_SETTLE_WAIT_MS = 60_000;

/**
 * The words a node uses for a transaction it is ALREADY holding.
 *
 * Three of them, and each is grounded rather than guessed. Substrate's author
 * RPC answers a resubmission of something already in its pool with error 1013,
 * "Transaction Already Imported", and the pool's own type spells the same fact
 * "Transaction is already in the pool"; 1012, "Transaction is temporarily
 * banned", is the pool saying it has seen these exact bytes recently and will
 * not take them again. polkadot-js turns all three into an `RpcError` whose
 * message is the code, a colon, and the node's own text
 * (`@polkadot/rpc-provider` `coder/index.js`) — the same shape as the refusal
 * already known here: `1010: Invalid Transaction: Custom error: 231`.
 *
 * The codes are matched WITH their colon, so a 1010 refusal carrying a custom
 * error that happens to read 1013 cannot be mistaken for one of these. "already
 * known" is deliberately absent: that is the wording an Ethereum node uses, and
 * this one never produces it.
 *
 * All three mean the same thing for a resubmission — the node has the
 * transaction, so offering it again achieves nothing and the indexer is what
 * decides whether it landed. None of them is a refusal of the transaction
 * itself, which is why none of them gives the sponsor its fee back.
 */
const ALREADY_WITH_THE_NODE = /Transaction Already Imported|already in the pool|(?:^|\s)101[23]:/i;

/** How far down a `cause` chain the words are looked for. */
const CAUSE_DEPTH = 8;

/**
 * Everything an error and its causes say, as one string.
 *
 * The reason this exists rather than a look at `error.message`: the wallet
 * SDK's submission service wraps every node refusal in an Effect tagged error
 * whose own message is the constant "Transaction submission error", and the
 * node client wraps it again as "Transaction submission failed". The node's own
 * words — the only ones that say WHICH refusal this is — are two `cause` levels
 * further down, on the polkadot-js `RpcError`. A matcher that read the top
 * message alone would never match anything real.
 *
 * Bounded and cycle-safe, because an error chain is arbitrary data: an SDK that
 * sets a cause to itself must not take the tab with it.
 */
export function refusalText(cause: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  let current: unknown = cause;
  for (let depth = 0; depth < CAUSE_DEPTH; depth += 1) {
    if (typeof current === 'object' && current !== null) {
      if (seen.has(current)) break;
      seen.add(current);
      /* An object with no message of its own has nothing worth reading: the
         words are further down, on the cause it wraps. */
      const message: unknown = (current as { message?: unknown }).message;
      if (typeof message === 'string') parts.push(message);
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    /* A chain that simply ends adds nothing. One that ends in a thrown STRING
       is carrying its whole message there — a `reject('…')` is the shape that
       produces one, and it is the only non-object worth reading. */
    if (typeof current === 'string') parts.push(current);
    break;
  }
  return parts.join(' | ');
}

/** True when `cause` is a node saying it already holds the transaction. */
export function nodeAlreadyHasTransaction(cause: unknown): boolean {
  return ALREADY_WITH_THE_NODE.test(refusalText(cause));
}

/**
 * The identifiers this tab offered to the node twice without ever being told
 * they had arrived.
 *
 * A SET RATHER THAN A FIELD ON THE ANSWER, and not for want of trying. What a
 * submit hands back through midnight-js is `tx.identifiers().at(-1)` — a string
 * — and every layer between the submit and the wait that follows it passes that
 * string through `String(...)`. There is nowhere on a primitive to hang a fact,
 * so the fact is kept beside it, keyed by the one value both ends already agree
 * on.
 *
 * Tab-lifetime and unbounded on purpose: a session submits a handful of
 * transactions, an entry is a few dozen bytes, and forgetting one would
 * silently restore the long wait this exists to shorten.
 */
const unconfirmedSubmissions = new Set<string>();

/** Remembers that `identifier` was offered twice and acknowledged neither time. */
export function markSubmissionUnconfirmed(identifier: string): void {
  unconfirmedSubmissions.add(identifier);
}

/**
 * How long to wait for `identifier` to settle: the caller's own window, or the
 * shorter one where nobody can say the transaction was ever sent.
 *
 * Never LONGER than the window asked for. A caller whose ordinary wait is
 * already under a minute has its own reason for being brief, and "shortening"
 * it into a longer wait would be the opposite of this rule.
 */
export function settleDeadlineFor(identifier: string | null, normalMs: number): number {
  if (identifier === null) return normalMs;
  if (!unconfirmedSubmissions.has(identifier)) return normalMs;
  return Math.min(UNCONFIRMED_SETTLE_WAIT_MS, normalMs);
}

/** Empties the register. For tests; nothing in the app forgets a submission. */
export function forgetUnconfirmedSubmissions(): void {
  unconfirmedSubmissions.clear();
}
