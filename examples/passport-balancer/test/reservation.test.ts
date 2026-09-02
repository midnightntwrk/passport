/**
 * The reservation semantics, tested without a chain.
 *
 * What these guard is one live failure: on 2026/08/26 an mUSD activation leg
 * held the wallet for the whole ~110 s it spent proving, `/wallet-status`
 * answered `available: 0` throughout, and the client — which gates fee
 * sponsorship on `available > 0` — refused every Send and every concurrent
 * onboarding for the duration. The fix is that proving claims nothing, and
 * these tests are what say so in a way a future refactor has to keep true.
 *
 * The harness below mirrors the real phase structure of a spend rather than the
 * SDK: `reserve` around the phases that select, sign, or submit coins, and a
 * bare `await` around the proof.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { walletAvailability } from '../src/availability.js';
import {
  SpendPriority,
  createWalletReservation,
  type WalletReservation,
} from '../src/reservation.js';

const wait = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

/** How `/wallet-status` would answer, for a wallet that is otherwise healthy. */
const availableNow = (reservation: WalletReservation): 0 | 1 =>
  walletAvailability({
    synced: true,
    dustSpecks: 4_986_372_758_799_194_665n,
    reserved: reservation.isReserved(),
    proving: 'server',
  }).available;

/**
 * One activation grant, shaped like `account.ts`'s asset leg: a short balancing
 * phase that claims the wallet, a long proof that claims nothing, then a short
 * submit that claims it again.
 */
async function grant(
  reservation: WalletReservation,
  options: { balanceMs: number; proveMs: number; submitMs: number; log?: string[]; name?: string },
): Promise<string> {
  return reservation.exclusive(async () => {
    await reservation.reserve(() => wait(options.balanceMs));
    await wait(options.proveMs);
    await reservation.reserve(() => wait(options.submitMs));
    options.log?.push(options.name ?? 'grant');
    return options.name ?? 'grant';
  });
}

describe('the wallet reservation', () => {
  it('holds no claim while a job is merely proving', async () => {
    const reservation = createWalletReservation();
    const samples: Array<{ reserved: boolean; busy: boolean }> = [];

    /* The proof outlasts the sampling window with room to spare: a sample that
       landed on the submit phase would be measuring the wrong thing. */
    const job = grant(reservation, { balanceMs: 10, proveMs: 600, submitMs: 10 });
    /* Sampled across the proof window, the way an operator polls
       `/wallet-status` every five seconds. */
    for (let n = 0; n < 6; n += 1) {
      await wait(20);
      samples.push({ reserved: reservation.isReserved(), busy: reservation.isBusy() });
    }
    await job;

    assert.equal(
      samples.some((sample) => sample.busy),
      true,
      'the job should have been on the queue for at least one sample',
    );
    assert.deepEqual(
      samples.filter((sample) => sample.reserved),
      [],
      'no sample taken during the proof may report a claim on the wallet',
    );
  });

  it('reports available: 1 for every sample taken during a proof', async () => {
    const reservation = createWalletReservation();
    const samples: Array<0 | 1> = [];

    const job = grant(reservation, { balanceMs: 5, proveMs: 600, submitMs: 5 });
    for (let n = 0; n < 6; n += 1) {
      await wait(25);
      samples.push(availableNow(reservation));
    }
    await job;

    assert.deepEqual(
      samples,
      [1, 1, 1, 1, 1, 1],
      'a grant that is proving must never make this wallet read as unavailable',
    );
  });

  it('serves a fee request while a grant is proving', async () => {
    const reservation = createWalletReservation();
    const order: string[] = [];

    const job = grant(reservation, {
      balanceMs: 10,
      proveMs: 600,
      submitMs: 10,
      log: order,
      name: 'grant',
    });

    // Mid-proof, a Send arrives. `/balance-only` does not queue: it checks the
    // claim, takes one of its own, proves, and answers.
    await wait(60);
    assert.equal(availableNow(reservation), 1);
    assert.equal(reservation.isReserved(), false, 'the proving grant holds nothing');

    const fee = (async () => {
      await reservation.reserve(() => wait(5));
      await wait(20);
      order.push('fee');
      return 'fee';
    })();

    assert.equal(await fee, 'fee');
    assert.equal(await job, 'grant');
    assert.deepEqual(order, ['fee', 'grant'], 'the fee leg must not wait for the grant to finish');
  });

  it('queues two grants and completes both, in order', async () => {
    const reservation = createWalletReservation();
    const order: string[] = [];

    const results = await Promise.all([
      grant(reservation, { balanceMs: 5, proveMs: 60, submitMs: 5, log: order, name: 'first' }),
      grant(reservation, { balanceMs: 5, proveMs: 60, submitMs: 5, log: order, name: 'second' }),
    ]);

    assert.deepEqual(results, ['first', 'second']);
    assert.deepEqual(order, ['first', 'second'], 'spends must still run one at a time');
    assert.deepEqual(reservation.counts(), { reserved: 0, jobs: 0 });
  });

  it('never lets two claims overlap on a single-threaded run', async () => {
    const reservation = createWalletReservation();
    let peak = 0;
    const watch = setInterval(() => {
      peak = Math.max(peak, reservation.counts().reserved);
    }, 5);

    await Promise.all([
      grant(reservation, { balanceMs: 15, proveMs: 40, submitMs: 15 }),
      grant(reservation, { balanceMs: 15, proveMs: 40, submitMs: 15 }),
    ]);
    clearInterval(watch);

    assert.ok(peak <= 1, `two queued grants should never claim the wallet at once (peak ${peak})`);
  });

  it('lets a registration overtake grants that are only waiting', async () => {
    const reservation = createWalletReservation();
    const order: string[] = [];
    const job = (name: string, priority: number): Promise<string> =>
      reservation.exclusive(
        async () => {
          await wait(20);
          order.push(name);
          return name;
        },
        { priority },
      );

    /* The first grant is RUNNING by the time the others arrive, so it finishes
       first however it is prioritised: the queue reorders what is waiting, and
       never interrupts what has started. */
    const first = job('grant-running', SpendPriority.Normal);
    const second = job('grant-waiting', SpendPriority.Normal);
    const registration = job('registration', SpendPriority.Registration);

    assert.deepEqual(await Promise.all([first, second, registration]), [
      'grant-running',
      'grant-waiting',
      'registration',
    ]);
    assert.deepEqual(
      order,
      ['grant-running', 'registration', 'grant-waiting'],
      'the registration must jump the grant that had not started',
    );
  });

  it('keeps equal priorities in the order they arrived', async () => {
    const reservation = createWalletReservation();
    const order: string[] = [];
    const job = (name: string, priority: number): Promise<string> =>
      reservation.exclusive(
        async () => {
          await wait(10);
          order.push(name);
          return name;
        },
        { priority },
      );

    await Promise.all([
      job('running', SpendPriority.Registration),
      job('first', SpendPriority.Registration),
      job('second', SpendPriority.Registration),
      job('third', SpendPriority.Registration),
    ]);

    assert.deepEqual(order, ['running', 'first', 'second', 'third']);
  });

  it('releases the claim when a phase throws', async () => {
    const reservation = createWalletReservation();
    await assert.rejects(
      reservation.reserve(async () => {
        throw new Error('balancing failed');
      }),
      /balancing failed/,
    );
    assert.equal(reservation.isReserved(), false);
    assert.equal(availableNow(reservation), 1);
  });

  it('runs the next job after a failed predecessor', async () => {
    const reservation = createWalletReservation();
    const failed = reservation.exclusive(async () => {
      throw new Error('deposit failed');
    });
    const next = reservation.exclusive(async () => 'ran anyway');

    await assert.rejects(failed, /deposit failed/);
    assert.equal(await next, 'ran anyway');
    assert.deepEqual(reservation.counts(), { reserved: 0, jobs: 0 });
  });

  it('is re-entrant, because a contract call claims the wallet twice inside one job', async () => {
    const reservation = createWalletReservation();
    const result = await reservation.exclusive(async () => {
      const balanced = await reservation.reserve(async () => 'balanced');
      const submitted = await reservation.reserve(async () => `${balanced}+submitted`);
      return submitted;
    });
    assert.equal(result, 'balanced+submitted');
    assert.deepEqual(reservation.counts(), { reserved: 0, jobs: 0 });
  });
});

describe('the availability policy', () => {
  const healthy = {
    synced: true,
    dustSpecks: 1_000n,
    reserved: false,
    proving: 'server',
  } as const;

  it('is available when synced, funded, unclaimed, and able to prove', () => {
    assert.deepEqual(walletAvailability(healthy), { available: 1 });
    assert.deepEqual(walletAvailability({ ...healthy, proving: 'ready' }), { available: 1 });
  });

  it('refuses with a cause a caller can act on', () => {
    assert.deepEqual(walletAvailability({ ...healthy, synced: false }), {
      available: 0,
      unavailableCause: 'WALLET_SYNCING',
    });
    /* A claim is settling BY DEFINITION — it is seconds, and it ends by
       itself — so this one carries the wait without being told about it. */
    assert.deepEqual(walletAvailability({ ...healthy, reserved: true }), {
      available: 0,
      unavailableCause: 'PENDING_TRANSACTION',
      settling: true,
      retryAfterMs: 3_000,
    });
    assert.deepEqual(walletAvailability({ ...healthy, dustSpecks: 0n }), {
      available: 0,
      unavailableCause: 'INSUFFICIENT_DUST',
    });
    assert.deepEqual(walletAvailability({ ...healthy, proving: 'warming' }), {
      available: 0,
      unavailableCause: 'PROVER_WARMING',
    });
    assert.deepEqual(walletAvailability({ ...healthy, proving: 'failed' }), {
      available: 0,
      unavailableCause: 'PROVER_UNAVAILABLE',
    });
  });

  /* The two fields `/wallet-status` gained on 2026/09/02, after a client that
     read a bare `available: 0` mid-send gave up on this service and took its
     second leg to a different sponsor — which proved it against a state the
     first leg had already moved, and it never landed. They say the wait is
     short and bounded; they never say the wallet can pay. */
  it('says a shortfall is a wait, without ever calling an empty wallet available', () => {
    const settling = walletAvailability({ ...healthy, dustSpecks: 0n, settling: true });
    assert.deepEqual(settling, {
      available: 0,
      unavailableCause: 'INSUFFICIENT_DUST',
      settling: true,
      retryAfterMs: 3_000,
    });

    assert.deepEqual(walletAvailability({ ...healthy, synced: false, settling: true }), {
      available: 0,
      unavailableCause: 'WALLET_SYNCING',
      settling: true,
      retryAfterMs: 3_000,
    });
  });

  it('does not dress a prover failure up as something worth waiting for', () => {
    assert.deepEqual(walletAvailability({ ...healthy, proving: 'failed', settling: true }), {
      available: 0,
      unavailableCause: 'PROVER_UNAVAILABLE',
    });
  });

  it('carries nothing extra when there is nothing in flight to explain the shortfall', () => {
    assert.deepEqual(walletAvailability({ ...healthy, dustSpecks: 0n, settling: false }), {
      available: 0,
      unavailableCause: 'INSUFFICIENT_DUST',
    });
  });

  it('reports syncing ahead of every other cause, because nothing else is knowable', () => {
    assert.deepEqual(
      walletAvailability({ synced: false, dustSpecks: 0n, reserved: true, proving: 'failed' }),
      { available: 0, unavailableCause: 'WALLET_SYNCING' },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Lanes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a lane really is, and why it is a function of the chain rather than a
 * setting.
 *
 * Every sponsored spend consumes a whole DUST coin, and the SDK's coin
 * selection takes the smallest coin with a value above zero until the fee is
 * covered. Two jobs started against one free coin therefore do not queue
 * politely — the second fails to balance, or sweeps a coin the first was about
 * to spend. So the queue asks how many coins are free before every start, and
 * the configured ceiling is only ever the smaller half of that answer.
 *
 * On 2026/09/02 the consequence of having no lanes at all was measured: five
 * sequential sponsored transactions per activation, a second Passport's
 * registration queued 280 s behind the first's, and 519 s from a landed account
 * to visible mUSD.
 */
describe('spend lanes', () => {
  /** A job that reports when it starts and finishes on the caller's schedule. */
  function job(log: string[], name: string) {
    let release!: () => void;
    const finished = new Promise<void>((settle) => {
      release = settle;
    });
    return {
      release,
      run: async () => {
        log.push(`start ${name}`);
        await finished;
        log.push(`end ${name}`);
        return name;
      },
    };
  }

  it('runs three jobs at once when three DUST coins are free', async () => {
    const log: string[] = [];
    const reservation = createWalletReservation({ lanes: () => 3 });
    const jobs = ['a', 'b', 'c'].map((name) => job(log, name));
    const running = jobs.map((entry) => reservation.exclusive(entry.run));

    await wait(5);
    assert.deepEqual(log, ['start a', 'start b', 'start c']);
    assert.equal(reservation.counts().jobs, 3);

    for (const entry of jobs) entry.release();
    assert.deepEqual(await Promise.all(running), ['a', 'b', 'c']);
  });

  it('runs one job when only one coin is free, however many lanes are configured', async () => {
    const log: string[] = [];
    const reservation = createWalletReservation({ lanes: () => Math.min(3, 1) });
    const jobs = ['a', 'b'].map((name) => job(log, name));
    const running = jobs.map((entry) => reservation.exclusive(entry.run));

    await wait(5);
    assert.deepEqual(log, ['start a'], 'the second waits for a coin, not for a lane');

    jobs[0]!.release();
    await wait(5);
    assert.deepEqual(log, ['start a', 'end a', 'start b']);
    jobs[1]!.release();
    await Promise.all(running);
  });

  it('opens a lane the moment a coin comes free, without an event to say so', async () => {
    /* The coin count is read AFRESH at each drain, which is what lets change
       landing on the chain admit a waiting job with nothing having to notify
       the queue. */
    const log: string[] = [];
    let free = 1;
    const reservation = createWalletReservation({ lanes: () => free });
    const jobs = ['a', 'b', 'c'].map((name) => job(log, name));
    const running = jobs.map((entry) => reservation.exclusive(entry.run));

    await wait(5);
    assert.deepEqual(log, ['start a']);

    free = 3;
    jobs[0]!.release();
    await wait(5);
    assert.deepEqual(log, ['start a', 'end a', 'start b', 'start c']);
    jobs[1]!.release();
    jobs[2]!.release();
    await Promise.all(running);
  });

  it('never stalls the queue when the caller reports no free coins at all', async () => {
    /* Zero lanes would not throttle this queue, it would STOP it: `drain` runs
       on arrival and on completion, so with nothing running there is nothing
       left to call it again. One lane whose job then fails its own fee estimate
       is recoverable; a queue holding work nobody will ever start is not. */
    const log: string[] = [];
    const reservation = createWalletReservation({ lanes: () => 0 });
    assert.equal(reservation.lanes(), 1);
    const only = job(log, 'a');
    const running = reservation.exclusive(only.run);
    await wait(5);
    assert.deepEqual(log, ['start a']);
    only.release();
    await running;
  });

  it('keeps registration ahead of the jobs waiting behind a full set of lanes', async () => {
    /* Priorities order what is WAITING and nothing else, so they must survive
       the change from one lane to several unchanged. */
    const log: string[] = [];
    const reservation = createWalletReservation({ lanes: () => 1 });
    const first = job(log, 'running');
    const running = reservation.exclusive(first.run);
    await wait(5);

    const grant = job(log, 'grant');
    const registration = job(log, 'registration');
    const queued = [
      reservation.exclusive(grant.run),
      reservation.exclusive(registration.run, { priority: SpendPriority.Registration }),
    ];

    first.release();
    await wait(5);
    assert.deepEqual(log, ['start running', 'end running', 'start registration']);
    registration.release();
    await wait(5);
    grant.release();
    await Promise.all([running, ...queued]);
    assert.deepEqual(log.filter((line) => line.startsWith('start')), [
      'start running',
      'start registration',
      'start grant',
    ]);
  });

  it('keeps the next lane for a registration that stepped outside to wait', async () => {
    /* The live shape, 2026/09/02: the registration finds no fee-capable coin,
       leaves the queue to wait for one, and the activation grant behind it
       takes the coin that comes free. With a hold it does not. */
    const reservation = createWalletReservation();
    const order: string[] = [];
    const job = (name: string, priority: number): Promise<string> =>
      reservation.exclusive(
        async () => {
          await wait(10);
          order.push(name);
          return name;
        },
        { priority },
      );

    const release = reservation.hold(SpendPriority.Registration);
    const grant = job('grant', SpendPriority.Normal);
    await wait(30);
    assert.deepEqual(order, [], 'a held queue must not start the grant');

    /* The coin arrived: the registration rebuilds, and only then is the hold
       dropped — which is the ordering `withDustWait` relies on. */
    const registration = job('registration', SpendPriority.Registration);
    release();
    assert.deepEqual(await Promise.all([grant, registration]), ['grant', 'registration']);
    assert.deepEqual(order, ['registration', 'grant']);
  });

  it('does not hold back a job of equal or higher priority', async () => {
    const reservation = createWalletReservation();
    const order: string[] = [];
    const job = (name: string, priority: number): Promise<string> =>
      reservation.exclusive(
        async () => {
          order.push(name);
          return name;
        },
        { priority },
      );

    const release = reservation.hold(SpendPriority.Normal);
    await Promise.all([
      job('peer', SpendPriority.Normal),
      job('registration', SpendPriority.Registration),
    ]);
    assert.deepEqual(order, ['peer', 'registration']);
    release();
  });

  it('never interrupts a job that has started', async () => {
    const reservation = createWalletReservation();
    const order: string[] = [];
    const running = reservation.exclusive(async () => {
      await wait(20);
      order.push('running');
    });
    const release = reservation.hold(SpendPriority.Registration);
    await running;
    release();
    assert.deepEqual(order, ['running']);
  });

  it('drains on release, and releases only once', async () => {
    const reservation = createWalletReservation();
    const order: string[] = [];
    const release = reservation.hold(SpendPriority.Registration);
    const second = reservation.hold(SpendPriority.Registration);
    const grant = reservation.exclusive(async () => {
      order.push('grant');
    });
    release();
    release();
    await wait(5);
    assert.deepEqual(order, [], 'the second hold still stands');
    second();
    await grant;
    assert.deepEqual(order, ['grant']);
  });

  it('defaults to one lane, which is the behaviour every earlier test asserts', () => {
    assert.equal(createWalletReservation().lanes(), 1);
  });
});
