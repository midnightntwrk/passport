/**
 * The second unbounded wait, and why a timeout here must never mean "failed".
 *
 * midnight-js confirms a transaction by handing the indexer's public data
 * provider a `watchForTxData` or `watchForDeployTxData` — an Apollo
 * `watchQuery` filtered to the first matching answer and taken once. If the
 * answer never comes, or the socket underneath stops producing answers, the
 * promise never settles. Nothing in midnight-js bounds it, and until 2026/09/02
 * nothing here did either.
 *
 * THE ASYMMETRY THIS FILE EXISTS TO PIN DOWN. A watch that timed out says
 * nothing whatever about the transaction. Both hangs of 2026/09/02 had their
 * transaction in a block already — 291694 and 292118 — so a service that
 * treated its own deadline as a failure would have reverted DUST the chain had
 * genuinely spent and rebuilt transactions that had genuinely landed. The
 * indexer is therefore asked DIRECTLY before anything is given up on, and only
 * an answer of "not there" becomes a rebuildable failure.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRebuildable, withNodeRejectionRetry } from '../src/account.js';
import {
  ConfirmationTimeout,
  boundedPublicDataProvider,
  isConfirmationTimeout,
} from '../src/contractRuntime.js';

/** A public data provider whose three watches this test drives. */
function stubProvider(watch: (what: string, subject: string) => Promise<unknown>) {
  return {
    watchForTxData: (txId: string) => watch('tx', txId),
    watchForDeployTxData: (address: string) => watch('deploy', address),
    watchForContractState: (address: string) => watch('state', address),
    /* A method the wrapper does not name. It must survive: midnight-js calls
       plenty of them, and a wrapper that dropped them would break the moment it
       shipped. */
    queryContractState: async () => 'untouched',
  };
}

describe('bounding an indexer watch', () => {
  it('gives up on a watch that never answers, once the indexer denies the transaction', async () => {
    const bounded = boundedPublicDataProvider(stubProvider(() => new Promise(() => undefined)), {
      confirmTimeoutMs: 60,
      fresh: async () => stubProvider(() => new Promise(() => undefined)),
      indexerHttpUrl: 'http://indexer.invalid/graphql',
      landed: async () => false,
      log: () => undefined,
    });

    const started = Date.now();
    const failure = await bounded.watchForTxData('tx-1').catch((cause: unknown) => cause);

    assert.ok(failure instanceof ConfirmationTimeout);
    assert.ok(isConfirmationTimeout(failure));
    assert.ok(Date.now() - started < 1_000, 'bounded by the ceiling, not by the indexer');
  });

  it('carries on when the transaction is on chain and only the stream was lost', async () => {
    /* Both hangs of 2026/09/02, in miniature: the deploy had landed and the
       watch simply stopped being told. Recovery retries on a FRESH client,
       because the failure being recovered from is a client that has stopped
       producing results — retrying on the same one would wait out a second
       deadline and learn nothing. */
    let clients = 0;
    const bounded = boundedPublicDataProvider(
      stubProvider(() => new Promise(() => undefined)),
      {
        confirmTimeoutMs: 60,
        fresh: async () => {
          clients += 1;
          return stubProvider(async () => 'the deploy');
        },
        indexerHttpUrl: 'http://indexer.invalid/graphql',
        landed: async () => true,
        log: () => undefined,
      },
    );

    assert.equal(await bounded.watchForDeployTxData('addr-1'), 'the deploy');
    assert.equal(clients, 1, 'the retry went to a new client, not the wedged one');
  });

  it('answers straight through when the indexer is behaving', async () => {
    let asked = 0;
    const bounded = boundedPublicDataProvider(
      stubProvider(async (what, subject) => `${what}:${subject}`),
      {
        confirmTimeoutMs: 60_000,
        fresh: async () => stubProvider(async () => 'unused'),
        indexerHttpUrl: 'http://indexer.invalid/graphql',
        landed: async () => {
          asked += 1;
          return true;
        },
        log: () => undefined,
      },
    );

    assert.equal(await bounded.watchForTxData('tx-2'), 'tx:tx-2');
    assert.equal(asked, 0, 'nothing was asked directly, because nothing timed out');
  });

  it('keeps the methods it does not wrap', () => {
    /* `indexerPublicDataProvider` returns a CLASS instance and midnight-js
       calls methods this wrapper never names, so the wrapper preserves the
       prototype rather than spreading the object. */
    const bounded = boundedPublicDataProvider(stubProvider(async () => 'x'), {
      confirmTimeoutMs: 60_000,
      fresh: async () => stubProvider(async () => 'x'),
      indexerHttpUrl: 'http://indexer.invalid/graphql',
      landed: async () => true,
    });
    assert.equal(typeof bounded.queryContractState, 'function');
  });
});

describe('what a caller does with a confirmation timeout', () => {
  it('rebuilds once the wallet has caught up, exactly as it does for a refusal', async () => {
    /* The two failures are different and the remedy is the same: the bytes are
       not going to become a landed transaction, and the coins they select were
       chosen against a view that has moved on. */
    let caughtUp = false;
    let attempts = 0;
    const log: string[] = [];

    const result = await withNodeRejectionRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new ConfirmationTimeout('transaction', 'tx-3', 120_000);
        return 'landed on the rebuild';
      },
      {
        label: 'deposit_night into 0xabc',
        synced: async () => caughtUp,
        pollMs: 1,
        budgetMs: 1_000,
        wait: async () => {
          caughtUp = true;
        },
        log: (line) => log.push(line),
      },
    );

    assert.equal(result, 'landed on the rebuild');
    assert.equal(attempts, 2);
    assert.match(log[0]!, /gave up waiting on/);
    assert.doesNotMatch(log[0]!, /the node refused/, 'and does not call it a refusal, because it was not');
  });

  it('counts a timeout as rebuildable and an unrelated fault as not', () => {
    assert.equal(isRebuildable(new ConfirmationTimeout('transaction', 'tx', 1)), true);
    assert.equal(
      isRebuildable(new Error('1010: Invalid Transaction: Custom error: 231')),
      true,
      'the original case still holds',
    );
    assert.equal(
      isRebuildable(new Error('the prover is unreachable')),
      false,
      'waiting does not make an unreachable prover better',
    );
  });
});
