/**
 * The one failure this process cannot watch for from its own event loop: the
 * event loop stopping.
 *
 * WHAT HAPPENED, AND WHY EVERY OTHER WATCHDOG HERE MISSED IT
 * ----------------------------------------------------------
 * On 2026/09/03 the deployed balancer wrote `[job] the spare mUSD mint proved
 * (job-13)` at 01:45:29 UTC and then nothing at all. `/status` and
 * `/wallet-status` stopped answering — the TLS proxy logged one `/status` held
 * open for 369.8 s before it gave up with a 502 — the five-second stall sweep
 * in `./reservation.ts` never ran, and when systemd sent `SIGTERM` at 01:51:59
 * the handler in `./server.ts` did not run either: it logs a line before it
 * does anything, and no line was written. systemd waited out its stop timeout
 * and sent `SIGKILL` at 01:53:29. Eight minutes of silence, then ninety seconds
 * more of a stop that could not be answered.
 *
 * Every remedy this service had was scheduled ON the event loop — the health
 * tick, the stall sweep, the confirmation deadlines, the shutdown handler, the
 * HTTP server itself. A blocked loop runs none of them, so none of them can end
 * one. That is not a bug in any of them; it is the boundary of what code on
 * that loop can do, and it is why this module is the only one here that does
 * not live on it.
 *
 * HOW IT WORKS
 * ------------
 * The main thread stamps a shared buffer with the current time twice a second.
 * A worker thread — its own event loop, unaffected by whatever the main one is
 * doing — reads that stamp once a second through `Atomics.load`, which needs no
 * message to be delivered and no callback to be scheduled. A stamp older than
 * `blockedMs` means the main thread has not run for that long.
 *
 * The worker then does the only useful thing left: it writes a line explaining
 * itself and kills the process, so that `Restart=always` returns the sponsor in
 * seconds instead of after eight minutes of silence and a ninety-second stop.
 *
 * TWO DETAILS THAT ARE NOT DECORATION.
 *
 *   1. The worker writes with `fs.writeSync(2, …)`, not `console.error`. A
 *      worker's `stdout` and `stderr` are PIPED THROUGH THE PARENT — the parent
 *      forwards them on its own event loop — so a `console.error` here would be
 *      queued behind exactly the blockage it is reporting and would never reach
 *      the journal. Writing the file descriptor directly is what makes the
 *      diagnosis survive.
 *   2. It sends `SIGKILL`, not `SIGTERM`. `SIGTERM` is delivered to a handler
 *      on the blocked loop, which is what systemd already tried at 01:51:59 and
 *      spent ninety seconds finding out. Nothing this process could still run
 *      is worth those ninety seconds; the sync snapshot on disk is resumed from
 *      on the next start, and every booked coin is released by the restart.
 *
 * The same tick measures ordinary EVENT-LOOP LAG for `/status`, which is the
 * number that would have made the freeze visible while it was happening.
 */

import { writeSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

/** What `/status` publishes about the health of the loop itself. */
export interface LoopHealth {
  /**
   * The worst gap yet observed between two ticks that should be 500 ms apart,
   * minus those 500 ms. Ordinary values on the two-core droplet are tens of
   * milliseconds; a heavy synchronous balancing shows several seconds.
   */
  worstLagMs: number;
  /** The lag on the most recent tick. */
  lagMs: number;
  /** Whether the watching thread is running. */
  watching: boolean;
  /**
   * The longest block the WORKER has seen, in milliseconds, or zero. Non-zero
   * only when the worker was told not to kill — in production the process does
   * not outlive the observation.
   */
  blockedMs: number;
}

export interface LivenessWatch {
  health(): LoopHealth;
  /** Stops the ticker and the worker. For shutdown and for the tests. */
  stop(): Promise<void>;
}

export interface LivenessOptions {
  /**
   * How stale the stamp may get before the process is killed. Zero switches the
   * worker off and leaves only the lag measurement.
   */
  blockedMs: number;
  /** How often the main thread stamps. */
  tickMs?: number;
  /**
   * Whether the worker kills the process when the rule fires. Defaults to true,
   * which is the whole remedy. The tests set it false — a watchdog that kills
   * the test runner is not a test — and then read {@link LoopHealth.blockedMs},
   * which the worker writes into the same shared buffer. That keeps the tests
   * on the REAL worker thread rather than on a seam that runs on the very loop
   * the rule exists to catch stopping.
   */
  kill?: boolean;
  log?: (line: string) => void;
}

/**
 * The worker's whole program, as source.
 *
 * Inlined rather than kept in its own file because `dist/server.mjs` is a
 * single esbuild bundle: a `new Worker('./liveness-worker.js')` would name a
 * path that does not exist beside the bundle, and a second bundled entry point
 * is a second thing to keep in step with the deploy. There is nothing here that
 * wants a module of its own — it is a clock, a comparison, and a kill.
 */
const WORKER_SOURCE = `
const { writeSync } = require('node:fs');
const { workerData } = require('node:worker_threads');
const shared = new BigInt64Array(workerData.buffer);
const blockedMs = workerData.blockedMs;
const kill = workerData.kill;
setInterval(() => {
  const last = Number(Atomics.load(shared, 0));
  if (last === 0) return;
  const stalledMs = Date.now() - last;
  if (stalledMs < blockedMs) return;
  if (stalledMs > Number(Atomics.load(shared, 1))) {
    Atomics.store(shared, 1, BigInt(Math.round(stalledMs)));
  }
  try {
    writeSync(
      2,
      '[loop] the main thread has not run for ' +
        Math.round(stalledMs / 1000) +
        ' s — nothing scheduled on it can end that' +
        (kill
          ? ', so this process is being killed for the supervisor to restart'
          : ' (not killing: this watch was started without it)') +
        '\\n',
    );
  } catch {
    // A closed stderr is not a reason to stop watching.
  }
  if (kill) process.kill(process.pid, 'SIGKILL');
}, 1000);
`;
export function startLivenessWatch(options: LivenessOptions): LivenessWatch {
  const tickMs = options.tickMs ?? 500;
  const kill = options.kill ?? true;
  const log = options.log ?? ((line: string) => console.log(line));
  /* Two slots: the main thread's stamp, and the worst block the worker has
     seen. Shared rather than messaged, because a message is delivered on the
     main thread's event loop and that is precisely what may have stopped. */
  const buffer = new SharedArrayBuffer(16);
  const shared = new BigInt64Array(buffer);
  let worstLagMs = 0;
  let lagMs = 0;
  let previous = Date.now();

  Atomics.store(shared, 0, BigInt(previous));
  const ticker = setInterval(() => {
    const at = Date.now();
    lagMs = Math.max(0, at - previous - tickMs);
    if (lagMs > worstLagMs) worstLagMs = lagMs;
    previous = at;
    Atomics.store(shared, 0, BigInt(at));
  }, tickMs);
  /* Unreferenced: a liveness ticker must never be the reason the process stays
     up, and it runs regardless for as long as anything else does. */
  ticker.unref();

  let worker: Worker | null = null;
  if (options.blockedMs > 0) {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { buffer, blockedMs: options.blockedMs, kill },
    });
    worker.unref();
    worker.on('error', (cause) => {
      /* Reported and not retried. A watchdog that cannot start is a fact the
         operator should see in the journal; a restart loop for it would be a
         second thing to go wrong. */
      try {
        writeSync(2, `[loop] the liveness watch stopped: ${String(cause)}\n`);
      } catch {
        // Nothing left to report it with.
      }
    });
    if (kill) {
      log(
        `[loop] watching from a worker thread: this process kills itself if the main thread stops running for ${Math.round(options.blockedMs / 1_000)} s`,
      );
    }
  }

  return {
    health: () => ({
      worstLagMs,
      lagMs,
      watching: worker !== null,
      blockedMs: Number(Atomics.load(shared, 1)),
    }),
    stop: async () => {
      clearInterval(ticker);
      if (worker) await worker.terminate();
    },
  };
}
