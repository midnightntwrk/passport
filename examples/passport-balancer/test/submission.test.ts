/**
 * The wait that never returned, and the properties that end it.
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
 * dropped in silence.
 *
 * AND THE FAILURE THAT ORDERING ALONE DID NOT FIX, 2026/09/03 at 02:28 UTC.
 * With submissions serialised, `job-16`'s registration still died — on the
 * disconnect belonging to `job-8`, which had finished. `WsProvider.disconnect()`
 * calls `websocket.close(1000)` and resolves without waiting for the close
 * event, so the event landed after the next submission had reconnected the same
 * provider and registered its handler, and `#onSocketClose` errored the whole
 * provider-wide handler map: `disconnected from
 * wss://rpc.stagenet.shielded.tools/: 1000:: Normal Closure`, 39.7 s in, and a
 * refused registration for the user.
 *
 * So the property this file asserts first is ISOLATION: one connection per
 * submission, closed with it, because no ordering can protect a submission from
 * an event that arrives after the submission which caused it is over. Then that
 * submissions do not overlap, and that none of them waits for ever.
 *
 * The last assertions are the ones that keep the fix honest: a node REFUSAL must
 * still travel out unchanged, because `isNodeRejection` matches on its message
 * and `withNodeRejectionRetry` is what turns a refusal into a rebuild.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isNodeRejection } from '../src/account.js';
import { isSubmissionTimeout, serialiseSubmissions, SubmissionTimeout } from '../src/submission.js';

interface FakeClient {
  submitTransaction(tx: string, waitFor?: unknown): Promise<unknown>;
  close(): Promise<void>;
  closed: boolean;
}

/** A submission-service factory under this test's control. */
function fakeClients(behaviour: (transaction: string, waitFor: unknown) => Promise<unknown>): {
  open: () => FakeClient;
  opened: FakeClient[];
  calls: Array<{ transaction: string; waitFor: unknown; client: number; at: number }>;
} {
  const calls: Array<{ transaction: string; waitFor: unknown; client: number; at: number }> = [];
  const opened: FakeClient[] = [];
  return {
    calls,
    opened,
    open: (): FakeClient => {
      const index = opened.length;
      const client: FakeClient = {
        closed: false,
        submitTransaction(transaction: string, waitFor?: unknown) {
          calls.push({ transaction, waitFor, client: index, at: Date.now() });
          return behaviour(transaction, waitFor);
        },
        close: async () => {
          client.closed = true;
        },
      };
      opened.push(client);
      return client;
    },
  };
}

describe('one connection per submission', () => {
  it('opens its own service for each submission and closes it again', async () => {
    /* The 02:28 failure in one assertion. A submission that shares a provider
       with another can be killed by the other one's close event no matter how
       carefully the two were ordered, so no two submissions may share one. */
    const { open, opened, calls } = fakeClients(async () => 'ok');
    const wrapped = serialiseSubmissions(open, { timeoutMs: 1_000 });

    await wrapped.submitTransaction('one');
    await wrapped.submitTransaction('two');

    assert.equal(opened.length, 2, 'a connection each, never a shared one');
    assert.deepEqual(
      calls.map((call) => call.client),
      [0, 1],
      'and each submission went to its own',
    );
    assert.ok(
      opened.every((client) => client.closed),
      'both closed once their submission was over',
    );
  });

  it('opens the connection before joining the queue, so the wait warms it', async () => {
    /* The SDK starts connecting the moment the service is built. Opening after
       the mutex would put a second of connect on top of every queued
       submission instead of inside the wait it already has. */
    const { open, opened } = fakeClients(
      (transaction) => (transaction === 'first' ? new Promise(() => undefined) : Promise.resolve('ok')),
    );
    const wrapped = serialiseSubmissions(open, { timeoutMs: 200 });

    const first = wrapped.submitTransaction('first').catch(() => undefined);
    const second = wrapped.submitTransaction('second').catch(() => undefined);
    await new Promise((settle) => setTimeout(settle, 20));

    assert.equal(opened.length, 2, "the queued submission's connection is already open");
    await Promise.all([first, second]);
  });

  it('closes the connection of a submission it abandoned', async () => {
    /* Isolation is what makes abandonment safe: the dead subscription dies with
       its own socket instead of outliving the wrapper on a shared one. */
    const { open, opened } = fakeClients(() => new Promise(() => undefined));
    const wrapped = serialiseSubmissions(open, { timeoutMs: 40 });

    await wrapped.submitTransaction('tx').catch(() => undefined);
    await new Promise((settle) => setTimeout(settle, 10));

    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.closed, true, 'the abandoned submission took its socket with it');
  });
});

describe('bounding a node submission', () => {
  it('gives up on a submission that never answers, and says so in its own type', async () => {
    /* The hang itself: the SDK's promise simply never settles. */
    const { open } = fakeClients(() => new Promise(() => undefined));
    const wrapped = serialiseSubmissions(open, { timeoutMs: 60 });

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
    const { open } = fakeClients(() => new Promise(() => undefined));
    const wrapped = serialiseSubmissions(open, { timeoutMs: 40 });
    const failure = (await wrapped.submitTransaction('tx').catch((c: unknown) => c)) as Error;
    /* The wording matters as much as the type: both hangs had landed, so a
       message that said "this transaction failed" would be false, and `submitTx`
       would be entitled to revert DUST the chain has genuinely spent. */
    assert.match(failure.message, /may still have landed/);
  });
});

describe('never two submissions at once', () => {
  it('starts the second only after the first has settled', async () => {
    /* Isolation no longer requires this, but the node still sees one
       transaction of this wallet's at a time, built against one view of its
       coins, and at `'Submitted'` the window costs the queue under a second. */
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const { open } = fakeClients(
      (transaction) =>
        new Promise((settle) => {
          order.push(`start ${transaction}`);
          if (transaction === 'first') releaseFirst = () => settle('ok');
          else settle('ok');
        }),
    );
    const wrapped = serialiseSubmissions(open, { timeoutMs: 5_000 });

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
    const { open } = fakeClients(async (transaction) => {
      seen.push(transaction);
      if (transaction === 'refused') throw new Error('1010: Invalid Transaction: Custom error: 231');
      return 'ok';
    });
    const wrapped = serialiseSubmissions(open, { timeoutMs: 5_000 });

    const refused = wrapped.submitTransaction('refused').catch((cause: unknown) => cause);
    const after = wrapped.submitTransaction('after');
    await refused;

    assert.equal(await after, 'ok');
    assert.deepEqual(seen, ['refused', 'after']);
  });

  it('holds the next submission for the ceiling, then lets it through', async () => {
    /* A timed-out submission is abandoned, not cancelled. What is guaranteed is
       that the next one waits out the first's whole ceiling rather than starting
       alongside it — and, since 2026/09/03, that it starts on a connection the
       abandoned one cannot touch. */
    const starts: number[] = [];
    const { open } = fakeClients(
      () =>
        new Promise(() => {
          starts.push(Date.now());
        }),
    );
    const wrapped = serialiseSubmissions(open, { timeoutMs: 60 });

    const at = Date.now();
    await Promise.allSettled([wrapped.submitTransaction('one'), wrapped.submitTransaction('two')]);

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
    const { open } = fakeClients(async () => {
      throw new Error(
        'RPC-CORE: submitAndWatchExtrinsic: 1010: Invalid Transaction: Custom error: 231',
      );
    });
    const wrapped = serialiseSubmissions(open, { timeoutMs: 5_000 });

    const failure = await wrapped.submitTransaction('tx').catch((cause: unknown) => cause);
    assert.ok(isNodeRejection(failure), 'still recognised as a node rejection');
    assert.equal(isSubmissionTimeout(failure), false, 'and not mistaken for a timeout');
  });

  it("asks the node for 'Submitted', not for finality", async () => {
    /* Finality is 15–25 s on stagenet, per submission, and this service has no
       use for it: every job confirms against the INDEXER afterwards. Holding a
       lane through it was seconds off every user's click for nothing. */
    const { open, calls } = fakeClients(async () => 'ok');
    const wrapped = serialiseSubmissions(open, { timeoutMs: 1_000 });
    await wrapped.submitTransaction('tx');
    assert.equal(calls[0]?.waitFor, 'Submitted');
  });

  it('has nothing left to close between submissions', async () => {
    /* The facade calls `close()` from `stop()`. Every connection this wrapper
       opens is closed with the submission that opened it, so there is nothing
       for that call to do — and, importantly, nothing it could shut that a
       later submission would need. */
    const { open, opened } = fakeClients(async () => 'ok');
    const wrapped = serialiseSubmissions(open, { timeoutMs: 1_000 });
    await wrapped.submitTransaction('tx');
    await wrapped.close();
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.closed, true);
  });

  it("ends the wait when the running job's watchdog aborts it", async () => {
    /* The watchdog rejects the job; without this the SDK's promise would keep
       the wrapper's mutex — and so every later submission — waiting behind a
       job that has already been given up on. */
    const abort = new AbortController();
    const { open } = fakeClients(() => new Promise(() => undefined));
    const wrapped = serialiseSubmissions(open, {
      timeoutMs: 60_000,
      signal: () => abort.signal,
    });

    const pending = wrapped.submitTransaction('tx').catch((cause: unknown) => cause);
    abort.abort(new Error('stalled'));
    assert.ok(isSubmissionTimeout(await pending));
  });
});
