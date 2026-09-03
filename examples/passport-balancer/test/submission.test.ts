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
 * Every version of that failure comes from one line in the SDK's node client:
 * `sendMidnightTransaction` ends every submission stream with
 * `Stream.ensuring(api.disconnect())`, and `PolkadotNodeClient.make`
 * disconnects again as soon as it has loaded its metadata. polkadot-js drops
 * `author_*` subscriptions across a close without erroring them — that is the
 * hang — and `WsProvider.disconnect()` resolves before the close event, whose
 * `#onSocketClose` then errors every handler in the provider-wide map — that is
 * the refusal `job-16` died of at 02:28 UTC on 2026/09/03, on a disconnect
 * belonging to a submission that had already finished.
 *
 * Two narrower fixes were tried and measured failing on the deployed service.
 * Serialising submissions does not help, because the harm arrives after the
 * submission that caused it is over. A connection per submission does not help
 * either: the client disconnects during its own construction, so a client built
 * moments before its submission kills that submission with its own start-up
 * close — every spare-mint attempt at 02:40 and 02:41 UTC failed exactly that
 * way.
 *
 * So this service now owns the connection and never disconnects it while it is
 * running. These tests hold the queue, the ceiling, and the acceptance
 * semantics around it — everything except the socket, which is
 * `polkadotConnection` and is exercised live.
 *
 * The last assertions are the ones that keep the fix honest: a node REFUSAL must
 * still travel out unchanged, because `isNodeRejection` matches on its message
 * and `withNodeRejectionRetry` is what turns a refusal into a rebuild.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isNodeRejection } from '../src/account.js';
import {
  isSubmissionTimeout,
  serialiseSubmissions,
  SubmissionTimeout,
  type NodeConnection,
} from '../src/submission.js';

/** A transaction of the shape the facade hands down: it serialises itself. */
function tx(name: string): { serialize: () => Uint8Array; name: string } {
  return { name, serialize: () => new TextEncoder().encode(name) };
}

/** A node connection under this test's control. */
function fakeConnection(behaviour: (name: string) => Promise<string>): {
  connection: NodeConnection;
  sent: Array<{ name: string; at: number }>;
  closed: () => boolean;
} {
  const sent: Array<{ name: string; at: number }> = [];
  let wasClosed = false;
  return {
    sent,
    closed: () => wasClosed,
    connection: {
      send(transaction: Uint8Array) {
        const name = new TextDecoder().decode(transaction);
        sent.push({ name, at: Date.now() });
        return behaviour(name);
      },
      close: async () => {
        wasClosed = true;
      },
    },
  };
}

describe('one connection, never disconnected under a submission', () => {
  it('serialises the transaction and hands the bytes straight to the node', async () => {
    const { connection, sent } = fakeConnection(async () => '0xhash');
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 1_000 });

    const result = await wrapped.submitTransaction(tx('one'));

    assert.deepEqual(
      sent.map((call) => call.name),
      ['one'],
    );
    assert.deepEqual(result, { txHash: '0xhash' });
  });

  it('closes the connection only when the service itself is closed', async () => {
    /* The facade calls `close()` from `stop()`, and that is the ONLY disconnect
       this module performs. A submission that closed anything would be the
       whole defect back again. */
    const { connection, closed } = fakeConnection(async () => '0xhash');
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 1_000 });

    await wrapped.submitTransaction(tx('one'));
    assert.equal(closed(), false, 'submitting disconnected nothing');
    await wrapped.submitTransaction(tx('two'));
    assert.equal(closed(), false, 'and neither did the one after it');

    await wrapped.close();
    assert.equal(closed(), true);
  });
});

describe('bounding a node submission', () => {
  it('gives up on a submission that never answers, and says so in its own type', async () => {
    /* The hang itself: the node's status callback simply never arrives, which
       is what a dropped `author_*` subscription looks like from up here. */
    const { connection } = fakeConnection(() => new Promise(() => undefined));
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 60 });

    const started = Date.now();
    const failure = await wrapped.submitTransaction(tx('one')).then(
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
    const { connection } = fakeConnection(() => new Promise(() => undefined));
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 40 });
    const failure = (await wrapped.submitTransaction(tx('one')).catch((c: unknown) => c)) as Error;
    /* The wording matters as much as the type: both hangs had landed, so a
       message that said "this transaction failed" would be false, and `submitTx`
       would be entitled to revert DUST the chain has genuinely spent. */
    assert.match(failure.message, /may still have landed/);
  });

  it("ends the wait when the running job's watchdog aborts it", async () => {
    /* The watchdog rejects the job; without this the node's promise would keep
       the queue — and so every later submission — waiting behind a job that has
       already been given up on. */
    const abort = new AbortController();
    const { connection } = fakeConnection(() => new Promise(() => undefined));
    const wrapped = serialiseSubmissions(connection, {
      timeoutMs: 60_000,
      signal: () => abort.signal,
    });

    const pending = wrapped.submitTransaction(tx('one')).catch((cause: unknown) => cause);
    abort.abort(new Error('stalled'));
    assert.ok(isSubmissionTimeout(await pending));
  });
});

describe('never two submissions at once', () => {
  it('starts the second only after the first has settled', async () => {
    /* Safety no longer depends on this, but the node still sees one transaction
       of this wallet's at a time, built against one view of its coins. */
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const { connection } = fakeConnection(
      (name) =>
        new Promise((settle) => {
          order.push(`start ${name}`);
          if (name === 'first') releaseFirst = () => settle('0xhash');
          else settle('0xhash');
        }),
    );
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 5_000 });

    const first = wrapped.submitTransaction(tx('first'));
    const second = wrapped.submitTransaction(tx('second'));
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
    const { connection } = fakeConnection(async (name) => {
      seen.push(name);
      if (name === 'refused') throw new Error('1010: Invalid Transaction: Custom error: 231');
      return '0xhash';
    });
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 5_000 });

    const refused = wrapped.submitTransaction(tx('refused')).catch((cause: unknown) => cause);
    const after = wrapped.submitTransaction(tx('after'));
    await refused;

    assert.deepEqual(await after, { txHash: '0xhash' });
    assert.deepEqual(seen, ['refused', 'after']);
  });

  it('holds the next submission for the ceiling, then lets it through', async () => {
    /* A timed-out submission is abandoned, not cancelled. What is guaranteed is
       that the next one waits out the first's whole ceiling rather than starting
       alongside it. */
    const starts: number[] = [];
    const { connection } = fakeConnection(
      () =>
        new Promise(() => {
          starts.push(Date.now());
        }),
    );
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 60 });

    const at = Date.now();
    await Promise.allSettled([
      wrapped.submitTransaction(tx('one')),
      wrapped.submitTransaction(tx('two')),
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
    const { connection } = fakeConnection(async () => {
      throw new Error(
        'RPC-CORE: submitAndWatchExtrinsic: 1010: Invalid Transaction: Custom error: 231',
      );
    });
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 5_000 });

    const failure = await wrapped.submitTransaction(tx('one')).catch((cause: unknown) => cause);
    assert.ok(isNodeRejection(failure), 'still recognised as a node rejection');
    assert.equal(isSubmissionTimeout(failure), false, 'and not mistaken for a timeout');
  });

  it('reports the step a job is on, so a queued submission is not silent', async () => {
    /* With submissions serialised, a job whose turn has not come is genuinely
       doing nothing. Without these steps that silence is what the stall
       watchdog aborts jobs for. */
    const steps: string[] = [];
    const { connection } = fakeConnection(async () => '0xhash');
    const wrapped = serialiseSubmissions(connection, {
      timeoutMs: 1_000,
      onStep: (step) => steps.push(step),
    });

    await wrapped.submitTransaction(tx('one'));
    assert.deepEqual(steps, ['waiting to submit', 'submitting']);
  });
});
