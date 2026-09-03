/**
 * Rebuilding a transaction the node refused, and never holding the queue while
 * waiting for a coin.
 *
 * Both of these are 2026/09/02 failures with a timestamp against them.
 *
 * The first: at 15:35:38 a registration landed, and at 15:35:43 a
 * `deposit_night` balanced against the dust state as it stood BEFORE that block
 * was refused by the node with `RpcError: 1010: Invalid Transaction: Custom
 * error: 231`. The balancer answered 502 `deposit-failed` and the client's own
 * ladder carried the wait — 229 s to NIGHT and 519 s to mUSD. The wallet was
 * current again within four minutes and a rebuilt transaction went straight
 * through, which is what these tests make the balancer do for itself.
 *
 * The second: at 15:49:03 the spare-mint job entered the queue, found no DUST
 * because a `/balance-only` had taken the coins a moment earlier, and sat in
 * its fee estimate's ten-minute budget until 15:59:07 with a queue depth of
 * one — blocking every registration and grant behind it for the duration.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isNodeRejection, isRebuildable, withNodeRejectionRetry } from '../src/account.js';
import { withDeadline } from '../src/contractRuntime.js';
import { WalletCallTimeout, isWalletCallTimeout } from '../src/wallet.js';
import { createWalletReservation } from '../src/reservation.js';

/** The rejection as the SDK actually delivered it, wrapper and all. */
const rejection = (): Error =>
  new Error('failed to submit transaction', {
    cause: new Error('RpcError: 1010: Invalid Transaction: Custom error: 231'),
  });

describe('recognising a node rejection', () => {
  it('reads the two shapes the node sends, however deeply they are wrapped', () => {
    assert.equal(isNodeRejection(rejection()), true);
    assert.equal(
      isNodeRejection(new Error('1010: Invalid Transaction: Custom error: 239')),
      true,
    );
  });

  it('is not fooled by the failures a rebuild would not help', () => {
    for (const cause of [
      new Error('ECONNREFUSED 127.0.0.1:6300'),
      new Error('no contract state at 0xabc'),
      new Error('could not balance dust'),
      'a bare string',
      undefined,
    ]) {
      assert.equal(isNodeRejection(cause), false, String(cause));
    }
  });
});

describe('rebuilding after a node rejection', () => {
  it('lands on the second build, once the wallet reports itself caught up', async () => {
    const builds: number[] = [];
    let synced = false;
    const polls: number[] = [];

    const landed = await withNodeRejectionRetry(
      async () => {
        builds.push(Date.now());
        if (builds.length === 1) throw rejection();
        return 'tx-2';
      },
      {
        label: 'deposit_night',
        /* Not synced on the first two asks, which is the flap the journal
           recorded at 15:35:50 and 15:36:50. */
        synced: async () => {
          polls.push(polls.length);
          return synced;
        },
        pollMs: 0,
        wait: async () => {
          if (polls.length >= 2) synced = true;
        },
      },
    );

    assert.equal(landed, 'tx-2');
    assert.equal(builds.length, 2, 'REBUILT, not resubmitted — the refused bytes would fail again');
    assert.ok(polls.length >= 2, 'it waited for the wallet rather than retrying straight away');
  });

  it('gives up after three builds and reports the rejection to its caller', async () => {
    let builds = 0;
    await assert.rejects(
      withNodeRejectionRetry(
        async () => {
          builds += 1;
          throw rejection();
        },
        { label: 'deposit_night', synced: async () => true, pollMs: 0, wait: async () => undefined },
      ),
      /failed to submit transaction/,
    );
    assert.equal(builds, 3);
  });

  it('rethrows anything that is not a node rejection on the first attempt', async () => {
    let builds = 0;
    await assert.rejects(
      withNodeRejectionRetry(
        async () => {
          builds += 1;
          throw new Error('the proof server did not answer');
        },
        { label: 'deposit_night', synced: async () => true, pollMs: 0, wait: async () => undefined },
      ),
      /the proof server did not answer/,
    );
    assert.equal(builds, 1, 'waiting does not make an unreachable prover reachable');
  });

  it('stops waiting when the wallet never catches up, and reports the rejection', async () => {
    /* A zero budget is the same code path as an exhausted one — the deadline
       is checked after the first ask, never before it — and it makes the case
       arithmetic rather than two real minutes of a test run. */
    let builds = 0;
    let waits = 0;
    await assert.rejects(
      withNodeRejectionRetry(
        async () => {
          builds += 1;
          throw rejection();
        },
        {
          label: 'deposit_night',
          synced: async () => false,
          budgetMs: 0,
          wait: async () => {
            waits += 1;
          },
        },
      ),
      /failed to submit transaction/,
    );
    assert.equal(builds, 1, 'it never rebuilt against a view that was still stale');
    assert.equal(waits, 0, 'and never slept past a budget that had already run out');
  });

  it('treats a wallet that will not answer as a wallet that is not caught up', async () => {
    let builds = 0;
    let asks = 0;
    const landed = await withNodeRejectionRetry(
      async () => {
        builds += 1;
        if (builds === 1) throw rejection();
        return 'tx-2';
      },
      {
        label: 'deposit_night',
        synced: async () => {
          asks += 1;
          if (asks === 1) throw new Error('state() timed out');
          return true;
        },
        pollMs: 0,
        wait: async () => undefined,
      },
    );
    assert.equal(landed, 'tx-2');
    assert.equal(asks, 2);
  });
});

/* -------------------------------------------------------------------------- */
/* Never holding a lane for a coin                                            */
/* -------------------------------------------------------------------------- */

describe('a spend whose fee estimate finds no free DUST', () => {
  it('gives the lane back at once instead of holding it for its budget', async () => {
    /* `waitForDustMs` defaults to zero, so the fee estimate raises rather than
       loops. What this asserts is the consequence: the job behind it starts in
       milliseconds, where on 2026/09/02 it waited ten minutes. */
    const reservation = createWalletReservation({ lanes: () => 1 });
    const startedAt = Date.now();

    const mint = reservation
      .exclusive(async () => {
        throw new Error('could not balance dust: no spendable coin');
      })
      .catch(() => 'refused');

    let registrationStartedAt = 0;
    const registration = reservation.exclusive(async () => {
      registrationStartedAt = Date.now();
      return 'registered';
    });

    assert.equal(await mint, 'refused');
    assert.equal(await registration, 'registered');
    assert.ok(
      registrationStartedAt - startedAt < 1_000,
      `the registration waited ${registrationStartedAt - startedAt} ms for a lane`,
    );
    assert.equal(reservation.counts().jobs, 0, 'a failed job releases its lane');
  });
});

/**
 * The three wallet calls a spend job makes between its circuit proof and its
 * fee-leg proof, and the eight minutes of silence that proved they needed a
 * ceiling.
 *
 * On 2026/09/03 the deployed service wrote `the spare mUSD mint proved
 * (job-13)` at 01:45:29 UTC and then no line of any kind until systemd killed
 * it at 01:53:29. `proved` is the last step before `estimateTransactionFee`,
 * and neither it, `balanceUnboundTransaction`, nor `signRecipe` had a bound.
 */
describe('a wallet call that never returns', () => {
  it('expires with a WalletCallTimeout naming the call', async () => {
    const started = Date.now();
    await assert.rejects(
      withDeadline(
        () => new Promise<never>(() => {}),
        60,
        (waitedMs) => new WalletCallTimeout('balancing the transaction', waitedMs),
      ),
      (cause: unknown) =>
        isWalletCallTimeout(cause) &&
        (cause as Error).message.includes('balancing the transaction'),
    );
    assert.ok(Date.now() - started < 5_000, 'the bound must be the deadline, not the call');
  });

  it('is rebuildable: nothing has been submitted when one is thrown', () => {
    assert.equal(isRebuildable(new WalletCallTimeout('estimating the fee', 120_000)), true);
    /* And it is NOT mistaken for a node refusal, which is a different journal
       line and a different explanation. */
    assert.equal(isNodeRejection(new WalletCallTimeout('estimating the fee', 120_000)), false);
  });

  it('rebuilds once and succeeds, exactly as a refusal does', async () => {
    let attempts = 0;
    const built = await withNodeRejectionRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new WalletCallTimeout('signing the recipe', 120_000);
        return 'landed';
      },
      {
        label: 'the spare mUSD mint',
        synced: async () => true,
        pollMs: 1,
        wait: async () => {},
        log: () => {},
        progress: () => {},
      },
    );
    assert.equal(built, 'landed');
    assert.equal(attempts, 2);
  });
});

/**
 * Rebuilding while another of this sponsor's transactions is still in flight,
 * which is how one refusal became three on 2026/09/03.
 *
 * 02:14:19 UTC: an activation grant refused with `Custom error: 231`, rebuilt
 * at 02:14:46 and again at 02:14:56, refused both times — with a registration
 * of the same wallet's submitted and unlanded throughout. Three proofs, three
 * balancings, and a lane on a wallet with one fee-capable coin went to
 * transactions that could not land, and the two name claims behind them reached
 * Home at 146.5 s against a bar of 120 s.
 */
describe('rebuilding behind this wallet own pending transaction', () => {
  it('waits for the pending one to land before it rebuilds', async () => {
    let pending = 1;
    let attempts = 0;
    const asked: number[] = [];
    const built = await withNodeRejectionRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw rejection();
        return 'landed';
      },
      {
        label: 'deposit_night into 48c95e1b…',
        /* The predicate the two call sites now pass: synced, dust complete, and
           nothing of ours in flight. */
        synced: async () => {
          asked.push(pending);
          if (pending > 0) {
            pending -= 1;
            return false;
          }
          return true;
        },
        pollMs: 1,
        wait: async () => {},
        log: () => {},
        progress: () => {},
      },
    );
    assert.equal(built, 'landed');
    assert.equal(attempts, 2, 'one rebuild, after the wait — not one per poll');
    assert.ok(asked.length >= 2, 'and it polled until the pending transaction had landed');
  });
});
