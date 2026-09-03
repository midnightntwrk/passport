/**
 * How this service hands a transaction to the node — and why it does not use
 * the wallet SDK's submission service unwrapped.
 *
 * THE DEFECT THIS MODULE EXISTS FOR
 * --------------------------------
 * On 2026/09/02 two spend jobs went silent while holding a lane, 23:03:31 and
 * 23:46:30 UTC, with the proof server idle and no journal line, until an
 * operator restarted the service. In both cases the job's transaction had
 * ALREADY LANDED on chain — the resolver-leaf `ContractDeploy` is in blocks
 * 291694 and 292118 — and the job never noticed. The wait that never returned
 * is the node submission, not the indexer watch:
 *
 *   1. `makeDefaultSubmissionServiceEffect` builds ONE `PolkadotNodeClient`,
 *      and therefore one polkadot-js `ApiPromise` and one `WsProvider`, for the
 *      whole facade.
 *   2. `PolkadotNodeClient.sendMidnightTransaction` ends EVERY submission
 *      stream with `Stream.ensuring(api.disconnect())`. So the end of any one
 *      submission closes the socket every other submission is watching on.
 *   3. `WsProvider.#onSocketClose` errors the pending REQUEST handlers but
 *      leaves the SUBSCRIPTIONS alone, and `#resubscribe` explicitly skips
 *      anything whose type starts with `author_`. An
 *      `author_submitAndWatchExtrinsic` that was open when another submission
 *      finished is therefore dropped in silence: no further status callback,
 *      the `Stream.async` never ends, and `reconnectionTimeout` is
 *      `Duration.infinity`.
 *
 * WHY SERIALISING WAS NOT ENOUGH, WHICH IS THE 2026/09/03 CORRECTION
 * -----------------------------------------------------------------
 * The first fix here was a mutex: one submission at a time, so two watches on
 * the shared connection could not coexist. The live run of 02:28 UTC on
 * 2026/09/03 shows why that is insufficient, and the journal names the
 * mechanism outright. `job-8` was refused (`1010: Invalid Transaction: Custom
 * error: 231`), its stream ended, and its `ensuring` ran `api.disconnect()`.
 * `WsProvider.disconnect()` calls `websocket.close(1000)` and RESOLVES
 * IMMEDIATELY — it does not wait for the socket's close event. So the mutex was
 * handed on, `job-16` reconnected the SAME provider and registered its own
 * handler, and only THEN did the old socket's close event reach
 * `#onSocketClose`, which walks the provider-wide handler map and errors
 * everything in it. `job-16` died on somebody else's disconnect with
 * `disconnected from wss://rpc.stagenet.shielded.tools/: 1000:: Normal Closure`
 * after 39.7 s, and the user saw a refused registration.
 *
 * Ordering cannot fix that, because the damage is done by an event that arrives
 * after the submission which caused it has already finished. The only property
 * that does fix it is isolation.
 *
 * WHAT THIS WRAPPER DOES ABOUT IT
 * -------------------------------
 *   1. **One connection per submission.** Every submission gets its own
 *      `PolkadotNodeClient`, and therefore its own `ApiPromise`, `WsProvider`,
 *      and handler map. `ensuring(api.disconnect())` and the close event that
 *      follows it can then only ever reach handlers belonging to the submission
 *      that is already over. Nothing shared, nothing to lose. The connection is
 *      opened BEFORE the queue is joined, so the second or so it costs overlaps
 *      the wait rather than adding to it.
 *   2. **One submission at a time.** Kept, though isolation no longer requires
 *      it: at `'Submitted'` the window is under a second, it costs the queue
 *      almost nothing, and it keeps the node from seeing several of this
 *      wallet's transactions built against one view of its coins at once.
 *   3. **A hard ceiling.** `submitTimeoutMs`, after which the wait is abandoned
 *      with a typed {@link SubmissionTimeout} and the caller decides whether the
 *      transaction landed anyway. Nothing underneath this bounds anything.
 *
 * And one consequence worth stating plainly: the wrapper asks the node for
 * `'Submitted'` rather than `'Finalized'`. A node REFUSAL still arrives, as the
 * rejection of the `.send()` call itself — which is what `isNodeRejection` and
 * `withNodeRejectionRetry` match on, so neither changes — while the 15–25 s of
 * stagenet finality per submission comes off the user's click. Finality is not
 * a thing this service ever needed from the node: every job that cares about
 * its transaction confirms it against the INDEXER afterwards.
 */

import { makeDefaultSubmissionService } from '@midnight-ntwrk/wallet-sdk/capabilities/submission';

/** The subset of the SDK's `SubmissionService` this service uses. */
export interface SubmissionLike<TTransaction> {
  submitTransaction(transaction: TTransaction, waitForStatus?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * A submission that was abandoned rather than completed.
 *
 * It does NOT mean the transaction failed: by the time this is thrown the bytes
 * are almost always with the node, and both hangs it was written for had landed
 * on chain. The caller's job is to find out which — see `submitTx` in
 * `./wallet.ts`, which asks the indexer before it reverts anything.
 */
export class SubmissionTimeout extends Error {
  readonly waitedMs: number;

  constructor(waitedMs: number) {
    super(
      `The node did not acknowledge this transaction within ${Math.round(waitedMs / 1_000)} s. It may still have landed; the caller checks the indexer before giving up on it.`,
    );
    this.name = 'SubmissionTimeout';
    this.waitedMs = waitedMs;
  }
}

/** Matches {@link SubmissionTimeout} across a bundle boundary, as `isNodeRejection` does. */
export function isSubmissionTimeout(cause: unknown): boolean {
  if (cause instanceof SubmissionTimeout) return true;
  return cause instanceof Error && cause.name === 'SubmissionTimeout';
}

export interface SerialisedSubmissionOptions<TTransaction> {
  /** How long one submission may take. See `config.submitTimeoutMs`. */
  timeoutMs: number;
  /**
   * What to ask the node to wait for. `'Submitted'` — the first Ready or
   * Broadcast status — everywhere in this service; the parameter exists so a
   * test can pin it.
   */
  waitForStatus?: 'Submitted' | 'InBlock' | 'Finalized';
  /** Aborts the wait early — the running job's watchdog signal. */
  signal?: () => AbortSignal | undefined;
  /** One line per submission, for the journal. */
  log?: (line: string) => void;
  /**
   * Reports a step of the running spend job — `reservation.progress`.
   *
   * Not decoration. Submissions are serialised, so a job whose turn has not
   * come yet is genuinely doing nothing and saying nothing, and with three
   * lanes it can wait two full ceilings before it starts. Without a step
   * reported here that silence is indistinguishable from the wedge the stall
   * watchdog exists to catch, and the watchdog would eventually abort a job
   * that was merely queued.
   */
  onStep?: (step: string) => void;
}

/**
 * Wraps a submission-service FACTORY so that each submission gets its own
 * connection, submissions do not overlap, and none of them waits for ever.
 *
 * The factory, rather than one service, is the whole point: `open()` is called
 * once per submission and the service it returns is closed as soon as that
 * submission settles. See the header for the close event that made a shared
 * connection unusable no matter how carefully submissions were ordered.
 *
 * A timed-out submission is abandoned rather than cancelled — nothing in the
 * SDK offers cancellation — but closing its own service disconnects its own
 * socket, so the subscription it left behind dies with it and touches nothing
 * else. That is the difference isolation makes: an abandoned submission is now
 * this service's problem alone for as long as it takes the caller to ask the
 * indexer whether the transaction landed, and never the next job's.
 */
export function serialiseSubmissions<TTransaction>(
  open: () => SubmissionLike<TTransaction>,
  options: SerialisedSubmissionOptions<TTransaction>,
): SubmissionLike<TTransaction> {
  const waitForStatus = options.waitForStatus ?? 'Submitted';
  let tail: Promise<unknown> = Promise.resolve();

  const bounded = async (
    client: SubmissionLike<TTransaction>,
    transaction: TTransaction,
  ): Promise<unknown> => {
    options.onStep?.('submitting');
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const signal = options.signal?.();
    try {
      return await new Promise((settle, fail) => {
        timer = setTimeout(() => fail(new SubmissionTimeout(Date.now() - startedAt)), options.timeoutMs);
        if (signal) {
          if (signal.aborted) {
            fail(new SubmissionTimeout(Date.now() - startedAt));
            return;
          }
          onAbort = (): void => fail(new SubmissionTimeout(Date.now() - startedAt));
          signal.addEventListener('abort', onAbort, { once: true });
        }
        /* The underlying promise is NEVER cancelled — nothing in the SDK can
           cancel it — it is merely stopped being waited on. Its eventual
           rejection is swallowed here rather than left to crash the process as
           an unhandled rejection. */
        void client.submitTransaction(transaction, waitForStatus).then(settle, fail);
      });
    } finally {
      if (timer) clearTimeout(timer);
      /* Removed on EVERY path, not just on abort. One job submits several
         transactions against one `AbortController`, and listeners that
         accumulated on it would trip Node's max-listeners warning and hold the
         closure of every submission the job had already finished. */
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  };

  return {
    async submitTransaction(transaction: TTransaction): Promise<unknown> {
      /* Opened BEFORE the queue is joined. The SDK starts connecting the moment
         the service is built, so the connection this submission will use warms
         while it waits for its turn instead of after it. */
      const client = open();
      try {
        /* Chained on the tail rather than guarded by a flag, so submissions run
           in arrival order and a rejected predecessor never poisons the chain. */
        /* Announced before the wait, not after it: this is the step that explains
           a job which is about to go quiet for somebody else's ceiling. */
        options.onStep?.('waiting to submit');
        const mine = tail.then(
          () => bounded(client, transaction),
          () => bounded(client, transaction),
        );
        tail = mine.then(
          () => undefined,
          () => undefined,
        );
        const result = await mine;
        options.log?.('[job] the node acknowledged this transaction');
        return result;
      } finally {
        /* Closed on every path, including the one where the submission was
           abandoned on a timeout: this socket belongs to this submission and to
           nothing else, so closing it can only end what is already over. */
        void client.close().catch(() => undefined);
      }
    },
    /* Nothing is held between submissions, so there is nothing left to close.
       The facade calls this from `stop()`. */
    close: async () => undefined,
  };
}

/**
 * The submission service this service hands to `WalletFacade.init`.
 *
 * Every node submission the balancer makes goes through it, because it IS the
 * facade's service: the DUST registration's `facade.submitTransaction`, the
 * spare-mint path, and the contract path in `midnightProvider.submitTx`.
 */
export function serialisedSubmissionService<TTransaction>(
  config: { relayURL: URL },
  options: SerialisedSubmissionOptions<TTransaction>,
): SubmissionLike<TTransaction> {
  return serialiseSubmissions(
    () => makeDefaultSubmissionService(config) as unknown as SubmissionLike<TTransaction>,
    options,
  );
}
