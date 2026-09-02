/**
 * The lane a running job gives back while it does nothing but poll.
 *
 * THE FAILURE, measured on the deployed service on 2026/09/02 at 21:54:07. The
 * node refused a `deposit_night`, and `withNodeRejectionRetry` did the right
 * thing — waited for this wallet to catch up with the block that refused it
 * before rebuilding — but it waited from INSIDE its spend job. On a wallet with
 * one fee-capable DUST coin that is the only lane, held until 21:55:50 by a
 * poll, while the name claim behind it waited. That claim reached Home in
 * 151.3 s against a bar of 120.
 *
 * It is the rule `withDustWait` already follows, from the other side: a wait
 * that occupies nothing should occupy nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWalletReservation, SpendPriority } from '../src/reservation.js';
import { withNodeRejectionRetry } from '../src/account.js';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('giving a lane back for the length of a wait', () => {
  it('lets a queued job run while the holder polls, on a one-lane wallet', async () => {
    const reservation = createWalletReservation({ lanes: () => 1 });
    const order: string[] = [];
    let releasePoll: () => void = () => undefined;
    const poll = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });

    const holder = reservation.exclusive(async () => {
      order.push('holder:start');
      await reservation.yieldLane(async () => {
        order.push('holder:polling');
        await poll;
        order.push('holder:polled');
      });
      order.push('holder:resumed');
    });

    await settle();
    const behind = reservation.exclusive(async () => {
      order.push('behind:ran');
    });
    await settle();
    await settle();
    /* The whole point: it ran, on the lane the poll gave back. */
    assert.deepEqual(order, ['holder:start', 'holder:polling', 'behind:ran']);

    releasePoll();
    await Promise.all([holder, behind]);
    assert.deepEqual(order, [
      'holder:start',
      'holder:polling',
      'behind:ran',
      'holder:polled',
      'holder:resumed',
    ]);
    assert.deepEqual(reservation.counts(), { reserved: 0, jobs: 0 });
  });

  it('never resumes onto a lane that does not exist', async () => {
    const reservation = createWalletReservation({ lanes: () => 1 });
    let running = 0;
    let mostAtOnce = 0;
    let releaseBehind: () => void = () => undefined;
    const behindHeld = new Promise<void>((resolve) => {
      releaseBehind = resolve;
    });
    const count = async <T>(work: () => Promise<T>): Promise<T> => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      try {
        return await work();
      } finally {
        running -= 1;
      }
    };

    const holder = reservation.exclusive(() =>
      count(async () => {
        await reservation.yieldLane(() => Promise.resolve());
      }),
    );
    await settle();
    const behind = reservation.exclusive(() => count(() => behindHeld));
    await settle();
    await settle();
    /* The holder wants its lane back and the job it let past still holds it. */
    assert.equal(mostAtOnce, 1);
    releaseBehind();
    await Promise.all([holder, behind]);
    assert.equal(mostAtOnce, 1);
    assert.deepEqual(reservation.counts(), { reserved: 0, jobs: 0 });
  });

  it('runs the work where it stands when the caller holds no lane', async () => {
    const reservation = createWalletReservation({ lanes: () => 1 });
    assert.equal(await reservation.yieldLane(() => Promise.resolve('done')), 'done');
    assert.deepEqual(reservation.counts(), { reserved: 0, jobs: 0 });
  });

  it('gives the lane back even when the wait throws', async () => {
    const reservation = createWalletReservation({ lanes: () => 1 });
    await assert.rejects(
      reservation.exclusive(() =>
        reservation.yieldLane(() => Promise.reject(new Error('gave up waiting'))),
      ),
      /gave up waiting/,
    );
    assert.deepEqual(reservation.counts(), { reserved: 0, jobs: 0 });
    /* And the queue still runs. */
    assert.equal(await reservation.exclusive(() => Promise.resolve('next')), 'next');
  });
});

describe('the node-rejection retry', () => {
  it('spends its catch-up wait outside the lane', async () => {
    const seen: string[] = [];
    let attempts = 0;
    const value = await withNodeRejectionRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('RpcError: 1010: Invalid Transaction: Custom error: 231');
        return 'landed';
      },
      {
        label: 'deposit_night into 00',
        synced: async () => {
          seen.push('polled');
          return true;
        },
        wait: async () => undefined,
        log: () => undefined,
        outsideLane: async (work) => {
          seen.push('yielded');
          const result = await work();
          seen.push('retaken');
          return result;
        },
      },
    );
    assert.equal(value, 'landed');
    assert.equal(attempts, 2);
    /* The poll happens between giving the lane up and taking it back, and the
       rebuild happens after — on a lane, exactly as the first attempt was. */
    assert.deepEqual(seen, ['yielded', 'polled', 'retaken']);
  });

  it('still runs the wait when no caller offered to yield', async () => {
    let attempts = 0;
    const value = await withNodeRejectionRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('RpcError: 1010: Invalid Transaction: Custom error: 231');
        return 'landed';
      },
      {
        label: 'deposit_night into 00',
        synced: async () => true,
        wait: async () => undefined,
        log: () => undefined,
      },
    );
    assert.equal(value, 'landed');
    assert.equal(attempts, 2);
  });

  it('reports the rejection when the wallet never catches up, lane or no lane', async () => {
    let retaken = false;
    await assert.rejects(
      withNodeRejectionRetry(() => Promise.reject(new Error('RpcError: 1010: Invalid Transaction: Custom error: 231')), {
        label: 'deposit_night into 00',
        synced: async () => false,
        budgetMs: 0,
        wait: async () => undefined,
        log: () => undefined,
        outsideLane: async (work) => {
          try {
            return await work();
          } finally {
            retaken = true;
          }
        },
      }),
      /Custom error: 231/,
    );
    assert.equal(retaken, true, 'the lane must be taken back even when the wait gives up');
  });
});
