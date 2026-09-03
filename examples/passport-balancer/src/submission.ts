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
 *      and therefore one polkadot-js `ApiPromise`, for the whole facade.
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
 * Both hangs have the same shape and the shape is the giveaway: a resolver-leaf
 * deploy waiting for `'Finalized'` while the same user's `deposit_night` was
 * refused by the node (`1010: Invalid Transaction: Custom error: 231`) on the
 * shared connection. The lanes change of 2026/09/02 is what made two balancer
 * submissions overlap for the first time.
 *
 * WHAT THIS WRAPPER DOES ABOUT IT, IN TWO PARTS
 * ---------------------------------------------
 *   1. **One submission at a time.** Not a throttle on the service — the spend
 *      queue's lanes are still three — but a mutex around the seconds a
 *      submission actually occupies the shared connection. Two in-flight
 *      watches on one `ApiPromise` cannot be made safe from out here, so they
 *      are never allowed to coexist.
 *   2. **A hard ceiling.** `submitTimeoutMs`, after which the wait is abandoned
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
}

/**
 * Wraps any submission service so that submissions are serialised and bounded.
 *
 * The mutex is held across the whole bounded call, so on the healthy path — the
 * only path that matters for the defect — two `author_submitAndWatchExtrinsic`
 * subscriptions never coexist and no submission can kill another's watch.
 *
 * ONE CASE THIS CANNOT MAKE CLEAN, stated plainly rather than papered over.
 * When a submission times out, its underlying promise is abandoned, not
 * cancelled — nothing in the SDK offers cancellation — so the next submission
 * does start while the abandoned one is, as far as the shared `ApiPromise` is
 * concerned, still an open subscription. Holding the mutex until it settled
 * would be the tidier invariant and the wrong trade: it would turn one
 * unanswerable submission into a permanently blocked queue, which is precisely
 * the wedge of 2026/09/02. A submission that has gone `timeoutMs` without a
 * status is in practice one whose subscription is already dead — that is why it
 * timed out — and the caller resolves the ambiguity properly by asking the
 * indexer whether the transaction landed.
 *
 * So the worst case is a wait of `timeoutMs` per queued submission, and never
 * an unbounded one.
 */
export function serialiseSubmissions<TTransaction>(
  inner: SubmissionLike<TTransaction>,
  options: SerialisedSubmissionOptions<TTransaction>,
): SubmissionLike<TTransaction> {
  const waitForStatus = options.waitForStatus ?? 'Submitted';
  let tail: Promise<unknown> = Promise.resolve();

  const bounded = async (transaction: TTransaction): Promise<unknown> => {
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
        void inner.submitTransaction(transaction, waitForStatus).then(settle, fail);
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
      /* Chained on the tail rather than guarded by a flag, so submissions run
         in arrival order and a rejected predecessor never poisons the chain. */
      const mine = tail.then(
        () => bounded(transaction),
        () => bounded(transaction),
      );
      tail = mine.then(
        () => undefined,
        () => undefined,
      );
      const result = await mine;
      options.log?.('[job] the node acknowledged this transaction');
      return result;
    },
    close: () => inner.close(),
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
    makeDefaultSubmissionService(config) as unknown as SubmissionLike<TTransaction>,
    options,
  );
}
