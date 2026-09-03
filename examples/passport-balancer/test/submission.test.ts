/**
 * The wait that never returned, and the two properties that end it.
 *
 * THE FAILURE THIS PINS DOWN. On 2026/09/02 two spend jobs went silent holding
 * a lane — 23:03:31 and 23:46:30 UTC — with the proof server idle and not one
 * journal line between the hang and the operator's restart, thirty-seven and
 * twenty-three minutes later. Both jobs' transactions had ALREADY LANDED: the
 * resolver-leaf deploys are in stagenet blocks 291694 and 292118. What never
 * returned was the node submission underneath `deployContract`.
 *
 * The mechanism, from the SDK sources: the wallet facade builds ONE
 * `PolkadotNodeClient`, and therefore one polkadot-js `ApiPromise`, for its
 * whole life, and `sendMidnightTransaction` ends every submission stream with
 * `Stream.ensuring(api.disconnect())`. polkadot-js's `#onSocketClose` errors the
 * pending request handlers but leaves subscriptions alone, and `#resubscribe`
 * skips anything whose type starts with `author_`. So an
 * `author_submitAndWatchExtrinsic` that is open when ANOTHER submission
 * finishes — the second job's `deposit_night`, refused by the node with
 * `1010: Invalid Transaction: Custom error: 231`, at 23:03:14 and 23:45:47 — is
 * dropped in silence. No status callback ever arrives, the `Stream.async` never
 * ends, and `reconnectionTimeout` is `Duration.infinity`.
 *
 * Two properties close it, and they are what this file asserts: submissions
 * never overlap, so a second one cannot kill a first one's watch; and no
 * submission waits for ever, so even an overlap this service did not cause
 * ends in a typed failure a caller can act on rather than in a held lane.
 *
 * The third assertion is the one that keeps the fix honest: a node REFUSAL must
 * still travel out unchanged, because `isNodeRejection` matches on its message
 * and `withNodeRejectionRetry` is what turns a refusal into a rebuild.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isNodeRejection } from '../src/account.js';
import { isSubmissionTimeout, serialiseSubmissions, SubmissionTimeout } from '../src/submission.js';

/** A submission service under this test's control. */
function fakeService(
  behaviour: (transaction: string, waitFor: unknown) => Promise<unknown>,
): {
  service: { submitTransaction(tx: string, waitFor?: unknown): Promise<unknown>; close(): Promise<void> };
  calls: Array<{ transaction: string; waitFor: unknown; at: number }>;
  closed: () => boolean;
} {
  const calls: Array<{ transaction: string; waitFor: unknown; at: number }> = [];
  let wasClosed = false;
  return {
    calls,
    closed: () => wasClosed,
    service: {
      submitTransaction(transaction: string, waitFor?: unknown) {
        calls.push({ transaction, waitFor, at: Date.now() });
        return behaviour(transaction, waitFor);
      },
      close: async () => {
        wasClosed = true;
      },
    },
  };
}

describe('bounding a node submission', () => {
  it('gives up on a submission that never answers, and says so in its own type', async () => {
    /* The hang itself: the SDK's promise simply never settles. */
    const { service } = fakeService(() => new Promise(() => undefined));
    const wrapped = serialiseSubmissions(service, { timeoutMs: 60 });

    const started = Date.now();
    const failure = await wrapped.submitTransaction('tx').then(
      () => null,
      (cause: unknown) => cause,
    );

    assert.ok(failure instanceof SubmissionTimeout, 'the wait ends in a SubmissionTimeout');
    assert.ok(isSubmissionTimeout(failure), 'and the predicate matches it across a bundle');
    assert.ok(
      Date.now() - started < 1_000,
      'and it ends when the ceiling says so, not when the node feels like it',
    );
  });

  it('names the wait it abandoned, without claiming the transaction failed', async () => {
    const { service } = fakeService(() => new Promise(() => undefined));
    const wrapped = serialiseSubmissions(service, { timeoutMs: 40 });
    const failure = (await wrapped.submitTransaction('tx').catch((c: unknown) => c)) as Error;
    /* The wording matters as much as the type: both hangs had landed, so a
       message that said "this transaction failed" would be false, and `submitTx`
       would be entitled to revert DUST the chain has genuinely spent. */
    assert.match(failure.message, /may still have landed/);
  });
});

describe('never two submissions at once', () => {
  it('starts the second only after the first has settled', async () => {
    /* The overlap is the defect. One `ApiPromise`, and the end of any stream
       disconnects it, so two open `author_submitAndWatchExtrinsic`
       subscriptions is a state this service must never be in. */
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const { service } = fakeService(
      (transaction) =>
        new Promise((settle) => {
          order.push(`start ${transaction}`);
          if (transaction === 'first') releaseFirst = () => settle('ok');
          else settle('ok');
        }),
    );
    const wrapped = serialiseSubmissions(service, { timeoutMs: 5_000 });

    const first = wrapped.submitTransaction('first');
    const second = wrapped.submitTransaction('second');
    await new Promise((settle) => setTimeout(settle, 20));

    assert.deepEqual(order, ['start first'], 'the second submission has not touched the node');
    assert.ok(releaseFirst, 'the first is still open');
    (releaseFirst as unknown as () => void)();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['start first', 'start second']);
  });

  it('lets the next submission through after one that failed', async () => {
    /* A rejected predecessor must not poison the chain: the node refuses
       transactions routinely — twice in each of the 2026/09/02 hangs — and a
       queue that stopped at the first refusal would be a worse wedge than the
       one being fixed. */
    const seen: string[] = [];
    const { service } = fakeService(async (transaction) => {
      seen.push(transaction);
      if (transaction === 'refused') throw new Error('1010: Invalid Transaction: Custom error: 231');
      return 'ok';
    });
    const wrapped = serialiseSubmissions(service, { timeoutMs: 5_000 });

    const refused = wrapped.submitTransaction('refused').catch((cause: unknown) => cause);
    const after = wrapped.submitTransaction('after');
    await refused;

    assert.equal(await after, 'ok');
    assert.deepEqual(seen, ['refused', 'after']);
  });

  it('holds the next submission for the ceiling, then lets it through', async () => {
    /* The case the wrapper cannot make perfectly clean, pinned down as it
       actually behaves. A timed-out submission is abandoned, not cancelled, so
       the next one does eventually start on top of a subscription the SDK still
       thinks is open. Holding the mutex until it settled would be tidier and
       wrong: one unanswerable submission would block the queue for ever, which
       is the wedge being fixed. What IS guaranteed is that the second waits out
       the first's whole ceiling rather than starting alongside it. */
    const starts: number[] = [];
    const { service } = fakeService(
      () =>
        new Promise(() => {
          starts.push(Date.now());
        }),
    );
    const wrapped = serialiseSubmissions(service, { timeoutMs: 60 });

    const at = Date.now();
    await Promise.allSettled([
      wrapped.submitTransaction('one'),
      wrapped.submitTransaction('two'),
    ]);

    assert.equal(starts.length, 2);
    assert.ok(starts[0]! - at < 40, 'the first went straight to the node');
    assert.ok(
      starts[1]! - starts[0]! >= 55,
      'the second waited out the first ceiling instead of overlapping it',
    );
  });
});

describe('what the wrapper must not change', () => {
  it('passes a node refusal out untouched, so it can still be rebuilt', async () => {
    /* `withNodeRejectionRetry` matches on this message. A wrapper that wrapped
       it, or replaced it with its own error, would silently turn every
       recoverable refusal into a failed activation. */
    const { service } = fakeService(async () => {
      throw new Error(
        'RPC-CORE: submitAndWatchExtrinsic: 1010: Invalid Transaction: Custom error: 231',
      );
    });
    const wrapped = serialiseSubmissions(service, { timeoutMs: 5_000 });

    const failure = await wrapped.submitTransaction('tx').catch((cause: unknown) => cause);
    assert.ok(isNodeRejection(failure), 'still recognised as a node rejection');
    assert.equal(isSubmissionTimeout(failure), false, 'and not mistaken for a timeout');
  });

  it("asks the node for 'Submitted', not for finality", async () => {
    /* Finality is 15–25 s on stagenet, per submission, and this service has no
       use for it: every job confirms against the INDEXER afterwards. Holding a
       lane through it was seconds off every user's click for nothing. */
    const { service, calls } = fakeService(async () => 'ok');
    const wrapped = serialiseSubmissions(service, { timeoutMs: 1_000 });
    await wrapped.submitTransaction('tx');
    assert.equal(calls[0]?.waitFor, 'Submitted');
  });

  it('closes the service underneath it', async () => {
    const { service, closed } = fakeService(async () => 'ok');
    await serialiseSubmissions(service, { timeoutMs: 1_000 }).close();
    assert.equal(closed(), true);
  });

  it("ends the wait when the running job's watchdog aborts it", async () => {
    /* The watchdog rejects the job; without this the SDK's promise would keep
       the wrapper's mutex — and so every later submission — waiting behind a
       job that has already been given up on. */
    const abort = new AbortController();
    const { service } = fakeService(() => new Promise(() => undefined));
    const wrapped = serialiseSubmissions(service, {
      timeoutMs: 60_000,
      signal: () => abort.signal,
    });

    const pending = wrapped.submitTransaction('tx').catch((cause: unknown) => cause);
    abort.abort(new Error('stalled'));
    assert.ok(isSubmissionTimeout(await pending));
  });
});
