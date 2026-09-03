/**
 * The watch that runs when the event loop does not.
 *
 * Every other remedy in this service is scheduled on the main thread's event
 * loop, and on 2026/09/03 that loop stopped: no journal line for eight minutes,
 * no five-second stall sweep, no answer on `/status`, and no `SIGTERM` handler
 * when systemd tried to stop the service at 01:51:59.
 *
 * The tests below run the REAL worker thread against a REAL blocked main thread
 * — a spin loop, which is what a synchronous balancing looks like from outside
 * — and take the kill away rather than the worker. A seam that ran the rule on
 * the main thread would be a test of nothing: it could not run either.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { startLivenessWatch } from '../src/liveness.js';

const wait = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

describe('the liveness watch', () => {
  it('leaves a running loop alone', async () => {
    const watch = startLivenessWatch({ blockedMs: 10_000, tickMs: 20, kill: false });
    await wait(1_500);
    assert.equal(watch.health().blockedMs, 0, 'a loop that is running is not a blocked one');
    await watch.stop();
  });

  it('fires from the worker thread while the main one is blocked', async () => {
    const watch = startLivenessWatch({ blockedMs: 300, tickMs: 20, kill: false });
    /* The worker has to be up before the block begins, or there is nothing
       watching to notice it. */
    await wait(500);
    /* The main thread blocked, for real: a spin loop is exactly what a
       synchronous balancing looks like from outside, and no timer of any kind
       runs while it holds the thread. */
    const until = Date.now() + 2_500;
    while (Date.now() < until) {
      // Deliberately synchronous. This is the failure being reproduced: no
      // timer, no callback, and no message on this thread runs while it holds.
    }
    const seen = watch.health().blockedMs;
    assert.ok(seen >= 300, `the worker saw ${seen} ms of a blocked main thread`);
    await watch.stop();
  });

  it('measures lag for /status even with no killer running', async () => {
    const watch = startLivenessWatch({ blockedMs: 0, tickMs: 20, kill: false });
    const until = Date.now() + 300;
    while (Date.now() < until) {
      // Blocked, briefly.
    }
    await wait(100);
    const health = watch.health();
    assert.equal(health.watching, false, 'zero switches the worker off');
    assert.ok(health.worstLagMs >= 200, `worst lag was ${health.worstLagMs} ms`);
    await watch.stop();
  });
});

/**
 * Recycling before the spiral, rather than freezing after it.
 *
 * The freeze was reproduced live at 02:10 UTC on 2026/09/03, seventeen minutes
 * into a fresh process: the main thread running at 50% with four V8 helper
 * threads at 30–40% each against 2.39 GB resident — a collector marking
 * continuously, not a call waiting on anything. A restart at 1.8 GB with
 * nothing in flight costs a second of resume-from-snapshot; the same restart
 * once the loop has stopped cost eight minutes of a dead sponsor and ninety
 * seconds of an unanswerable stop.
 */
describe('recycling on the heap', () => {
  it('recycles once the mark is passed and nothing is in flight', async () => {
    let recycled = 0;
    const lines: string[] = [];
    const watch = startLivenessWatch({
      blockedMs: 0,
      tickMs: 20,
      kill: false,
      recycleHeapBytes: 1,
      idle: () => true,
      recycle: () => {
        recycled += 1;
      },
      log: (line) => lines.push(line),
    });
    await wait(120);
    assert.equal(recycled, 1, 'once, not once per tick');
    assert.ok(
      lines.some((line) => /recycling now/.test(line)),
      lines.join('\n'),
    );
    await watch.stop();
  });

  it('waits for a quiet moment, however large the heap', async () => {
    let recycled = 0;
    let busy = true;
    const watch = startLivenessWatch({
      blockedMs: 0,
      tickMs: 20,
      kill: false,
      recycleHeapBytes: 1,
      idle: () => !busy,
      recycle: () => {
        recycled += 1;
      },
      log: () => undefined,
    });
    await wait(120);
    assert.equal(recycled, 0, 'a claim is never abandoned for a heap reading');
    busy = false;
    await wait(120);
    assert.equal(recycled, 1, 'and it happens the moment the queue empties');
    await watch.stop();
  });

  it('recycles on resident size even when the heap looks healthy', async () => {
    let recycled = 0;
    const lines: string[] = [];
    const watch = startLivenessWatch({
      blockedMs: 0,
      tickMs: 20,
      kill: false,
      /* The half `heapUsed` does not count: the ledger's WASM memory and the
         prover keys beside it. A sponsor can reach 2.4 GB resident — which is
         where it froze on 2026/09/03 — with a heap that reads healthy. */
      recycleHeapBytes: 1_800_000_000,
      recycleRssBytes: 1,
      idle: () => true,
      recycle: () => {
        recycled += 1;
      },
      log: (line) => lines.push(line),
    });
    await wait(120);
    assert.equal(recycled, 1, lines.join('\n'));
    await watch.stop();
  });

  it('leaves a healthy heap alone', async () => {
    let recycled = 0;
    const watch = startLivenessWatch({
      blockedMs: 0,
      tickMs: 20,
      kill: false,
      recycleHeapBytes: 1_800_000_000,
      recycleRssBytes: 2_000_000_000,
      idle: () => true,
      recycle: () => {
        recycled += 1;
      },
      log: () => undefined,
    });
    await wait(120);
    assert.equal(recycled, 0);
    assert.ok(watch.health().heapUsedBytes > 0, 'and the heap is reported for /status');
    assert.ok(watch.health().rssBytes > 0, 'and so is the resident size');
    await watch.stop();
  });
});
