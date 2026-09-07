/**
 * Fee coins reserved by jobs that no longer exist — the outage of 2026/09/07.
 *
 * WHAT HAPPENED. At 16:38 UTC a drill black-holed the node's addresses for six
 * minutes. Four spend jobs were caught by it: a spare mUSD mint (job-7), a
 * registration (job-8, then job-9), and an activation grant retry (job-10).
 * Each one balanced, reserved a fee-capable DUST coin, could not submit, and
 * hit the thirty-second submission bound — `failed after 30.x s`. The node came
 * back at 16:44 and nothing recovered: every registration after it reported
 * `waiting for a reserved coin` for thirty seconds and failed, then
 * `[dust] found no fee-capable coin free — waiting up to N s`, then
 * `a fee-capable coin came free after N s — rebuilding`, and failed again, in a
 * loop, while `/status` read `dustSpecks: 1.1e20` and `pendingTransactions: 0`.
 * A restart cleared it in one second, which is the whole finding: the coins
 * were in the wallet the entire time and the only thing keeping them from the
 * queue was this process's own bookkeeping.
 *
 * The three answers pinned down here — the release that cannot be forgotten,
 * the reclaim that runs on demand, and the verdict that names the fault — are
 * exercised against the real queue and the real reservation with an injected
 * clock. No wallet and no SDK: what is under test is who owns a coin and when
 * they stop owning it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RESERVATION_RECLAIM_MS,
  coinKey,
  createCoinReservation,
  dustFeeFirst,
  type CoinPresence,
  type CoinReservation,
  type SelectableCoin,
} from '../src/coinReservation.js';
import { createWalletReservation, currentJob } from '../src/reservation.js';
import {
  DEFAULT_HEALTH_POLICY,
  DEFAULT_REMEDY_POLICY,
  EMPTY_HEALTH_RECORD,
  assessHealth,
  chooseRemedy,
  type HealthFacts,
} from '../src/health.js';

/** An arbitrary fixed instant, and the drill's own six minutes. */
const T0 = 1_800_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** A fee-capable DUST coin, the shape the dust wallet hands the selector. */
const dust = (nonce: string, value = 15_000_000_000_000_000_000n): SelectableCoin => ({
  value,
  token: { nonce },
});

/**
 * The queue and the reservation wired the way `./wallet.ts` wires them: a
 * ticket's release is attached to the job that opened it, and the reclaim asks
 * the queue whether that job is still on it.
 */
function harness(options: { lanes?: number; maxMs?: number; watchdogIntervalMs?: number } = {}): {
  clock: () => number;
  advance: (ms: number) => void;
  reservation: ReturnType<typeof createWalletReservation>;
  coins: CoinReservation;
  lines: string[];
} {
  let clock = T0;
  const lines: string[] = [];
  const reservation = createWalletReservation({
    lanes: () => options.lanes ?? 1,
    now: () => clock,
    log: () => undefined,
    maxMs: options.maxMs,
    watchdogIntervalMs: options.watchdogIntervalMs,
  });
  const coins = createCoinReservation({
    now: () => clock,
    log: (line) => lines.push(line),
    attachToJob: (release) => {
      const job = currentJob();
      if (!job) return null;
      job.release.push(release);
      return job.id;
    },
    jobRunning: (jobId) => reservation.counts().running.some((job) => job.id === jobId),
  });
  return {
    clock: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    reservation,
    coins,
    lines,
  };
}

/** What a balance does: open a ticket, take a coin, hold it. */
function reserveCoin(coins: CoinReservation, label: string, coin: SelectableCoin): ReturnType<CoinReservation['open']> {
  const ticket = coins.open(label);
  ticket.hold([coinKey(coin)]);
  return ticket;
}

/** Can this coin be selected right now, by a job holding nothing? */
function selectable(coins: CoinReservation, pool: SelectableCoin[]): SelectableCoin | undefined {
  coins.beginBalance(null);
  try {
    return coins.guard(dustFeeFirst)(pool, 'dust', 1_000_000_000_000_000_000n, null);
  } finally {
    coins.endBalance();
  }
}

describe('a reservation is released when its job ends, however it ends', () => {
  it('frees the coin when the job times out at submit, for the very next job', async () => {
    const { reservation, coins } = harness();
    const coin = dust('a');

    await assert.rejects(
      reservation.exclusive(
        async () => {
          reserveCoin(coins, 'the registration of hectest.night', coin);
          /* The thirty-second submission bound, which is where job-8 ended. */
          throw new Error('the node did not acknowledge this transaction within 30 s');
        },
        { label: 'the registration of hectest.night' },
      ),
      /did not acknowledge/,
    );

    assert.deepEqual(coins.excluded(), []);
    assert.equal(coins.reservedCoins().count, 0);

    /* And the next job really is handed it, rather than merely finding the map
       empty. */
    const next = await reservation.exclusive(async () => selectable(coins, [coin]));
    assert.equal(coinKey(next!), coinKey(coin));
  });

  it('frees the coin when the socket fails under the submit', async () => {
    const { reservation, coins } = harness();
    const coin = dust('b');
    await assert.rejects(
      reservation.exclusive(async () => {
        reserveCoin(coins, 'the activation grant', coin);
        throw new Error('websocket is not connected');
      }),
      /websocket/,
    );
    assert.deepEqual(coins.excluded(), []);
  });

  it('frees the coin when the job throws before it ever submits', async () => {
    const { reservation, coins } = harness();
    const coin = dust('c');
    await assert.rejects(
      reservation.exclusive(async () => {
        reserveCoin(coins, 'the spare mUSD mint', coin);
        throw new TypeError('cannot read properties of undefined');
      }),
      TypeError,
    );
    assert.deepEqual(coins.excluded(), []);
  });

  it('frees the coin when the watchdog takes the lane back from a silent job', async () => {
    /* The path a `try`/`finally` around the balance would NOT cover: an
       abandoned job never reaches its own `finally`, which is the reason
       `RunningJob.release` exists and the reason the ticket is attached to it
       rather than wrapped at the call site. */
    const { reservation, coins, advance } = harness({ maxMs: 60 * SECOND, watchdogIntervalMs: 2 });
    const coin = dust('d');
    const job = reservation.exclusive(
      async () => {
        reserveCoin(coins, 'the registration that went silent', coin);
        /* Never settles — the SDK call the watchdog exists for. */
        await new Promise(() => undefined);
      },
      { label: 'the registration that went silent' },
    );
    advance(2 * MINUTE);
    await assert.rejects(job, /held a lane/);
    reservation.stop();
    assert.deepEqual(coins.excluded(), []);
  });

  it('keeps the coins of a submission the node DID acknowledge — the chain owns those', async () => {
    const { reservation, coins } = harness();
    const coin = dust('e');
    await reservation.exclusive(async () => {
      const ticket = reserveCoin(coins, 'the registration that landed', coin);
      ticket.submitted(T0 + 30 * MINUTE);
    });
    assert.deepEqual(coins.excluded(), [coinKey(coin)]);
    /* And it is not counted against the queue: no job owns it any more. */
    assert.equal(coins.reservedCoins().count, 0);
  });
});

describe('reclaiming what nothing will settle', () => {
  it('leaves a reservation alone inside the bound', () => {
    const { coins, advance } = harness();
    const coin = dust('f');
    const ticket = coins.open('the registration of hectest.night');
    ticket.hold([coinKey(coin)]);
    ticket.submitted(T0 + 30 * MINUTE, { acknowledged: false });

    advance(RESERVATION_RECLAIM_MS - SECOND);
    assert.deepEqual(coins.reclaim(), { reclaimed: 0, dropped: 0, coins: 0 });
    assert.deepEqual(coins.excluded(), [coinKey(coin)]);
  });

  it('reclaims an unacknowledged submission past the bound whose coin the wallet has back', () => {
    const { coins, advance, lines } = harness();
    const coin = dust('g');
    const ticket = coins.open('the registration of hectest.night');
    ticket.hold([coinKey(coin)]);
    ticket.submitted(T0 + 30 * MINUTE, { acknowledged: false });

    advance(RESERVATION_RECLAIM_MS + SECOND);
    const result = coins.reclaim({ presence: () => 'available' });
    assert.deepEqual(result, { reclaimed: 1, dropped: 0, coins: 1 });
    assert.deepEqual(coins.excluded(), []);
    assert.equal(coins.reservationsReclaimed(), 1);
    assert.match(lines.join('\n'), /the node never acknowledged it/);
  });

  it('leaves it alone while the wallet still has it booked as pending', () => {
    /* The sweeper has not ruled yet. Handing the coin out now is the double
       spend the whole module exists to prevent. */
    const { coins, advance } = harness();
    const coin = dust('h');
    const ticket = coins.open('the activation grant');
    ticket.hold([coinKey(coin)]);
    ticket.submitted(T0 + 30 * MINUTE, { acknowledged: false });

    advance(RESERVATION_RECLAIM_MS + SECOND);
    assert.deepEqual(coins.reclaim({ presence: () => 'pending' }), {
      reclaimed: 0,
      dropped: 0,
      coins: 0,
    });
    assert.deepEqual(coins.excluded(), [coinKey(coin)]);
  });

  it('drops rather than reclaims a reservation whose coin the chain took', () => {
    const { coins, advance, lines } = harness();
    const coin = dust('i');
    const ticket = coins.open('the registration that landed late');
    ticket.hold([coinKey(coin)]);
    ticket.submitted(T0 + 30 * MINUTE, { acknowledged: false });

    advance(RESERVATION_RECLAIM_MS + SECOND);
    const result = coins.reclaim({ presence: () => 'gone' });
    assert.deepEqual(result, { reclaimed: 0, dropped: 1, coins: 1 });
    assert.equal(coins.reservationsReclaimed(), 0);
    assert.match(lines.join('\n'), /spent its coins on chain after all/);
  });

  it('never touches a submission the node acknowledged, however old', () => {
    const { coins, advance } = harness();
    const coin = dust('j');
    const ticket = coins.open('the registration that landed');
    ticket.hold([coinKey(coin)]);
    ticket.submitted(T0 + 30 * MINUTE);

    advance(10 * MINUTE);
    assert.deepEqual(coins.reclaim({ presence: () => 'available' }), {
      reclaimed: 0,
      dropped: 0,
      coins: 0,
    });
    assert.deepEqual(coins.excluded(), [coinKey(coin)]);
  });

  it('reclaims a ticket still holding coins after its job left the queue', async () => {
    /* Unreachable while the structural release works. It is the backstop, and
       it says so in the journal when it fires. */
    const { reservation, coins, advance, lines } = harness();
    const coin = dust('k');
    let leaked: ReturnType<CoinReservation['open']> | null = null;
    await reservation.exclusive(async () => {
      leaked = reserveCoin(coins, 'a job that lost its release', coin);
      const job = currentJob()!;
      /* Simulates the release never having been registered at all. */
      job.release.length = 0;
    });
    assert.ok(leaked);
    assert.deepEqual(coins.excluded(), [coinKey(coin)]);

    advance(RESERVATION_RECLAIM_MS + SECOND);
    const result = coins.reclaim();
    assert.deepEqual(result, { reclaimed: 1, dropped: 0, coins: 1 });
    assert.deepEqual(coins.excluded(), []);
    assert.match(lines.join('\n'), /after its job ended/);
  });

  it('wakes a job that is waiting on the coin it frees', async () => {
    const { coins, advance } = harness();
    const coin = dust('l');
    const ticket = coins.open('the registration of hectest.night');
    ticket.hold([coinKey(coin)]);
    ticket.submitted(T0 + 30 * MINUTE, { acknowledged: false });

    advance(RESERVATION_RECLAIM_MS + SECOND);
    const waiting = coins.whenReleased(10 * SECOND);
    coins.reclaim({ presence: () => 'available' });
    assert.equal(await waiting, true);
  });
});

describe('the outage of 2026/09/07, replayed', () => {
  it('hands the first job after the node comes back a coin, without a wait', async () => {
    /* Four fee-capable coins and four jobs, which is the shape the drill
       caught: every coin the queue could open a lane on was reserved by a job
       that then failed at the submission. */
    const { reservation, coins, advance } = harness({ lanes: 4 });
    const pool = [dust('m1'), dust('m2'), dust('m3'), dust('m4')];
    const labels = [
      'the spare mUSD mint',
      'the registration of hectest.night',
      'the activation grant for 35e9973…c62d6d',
      'the activation grant for 35e9973…c62d6d (retry)',
    ];

    for (const [index, label] of labels.entries()) {
      await assert.rejects(
        reservation.exclusive(
          async () => {
            const ticket = reserveCoin(coins, label, pool[index]!);
            /* Handed to the node, never acknowledged, and the indexer says it
               is not on chain: watched as an orphan and rebuilt. */
            ticket.submitted(T0 + 30 * MINUTE, { acknowledged: false });
            throw new Error('the node did not acknowledge this transaction within 30 s');
          },
          { label },
        ),
        /did not acknowledge/,
      );
    }

    /* The node comes back. Nothing is running, every coin is still excluded,
       and the wallet reports plenty of DUST — the 16:44 reading. */
    assert.equal(reservation.counts().jobs, 0);
    assert.equal(coins.excluded().length, 4);
    assert.equal(selectable(coins, pool), undefined);

    /* Six minutes of black-hole, then the sweeper reverts the four bookings and
       the coins are back in the wallet's available list. */
    advance(6 * MINUTE);
    const present: CoinPresence = 'available';
    const freed = coins.reclaim({ presence: () => present });
    assert.equal(freed.reclaimed, 4);
    assert.equal(freed.coins, 4);

    const chosen = selectable(coins, pool);
    assert.ok(chosen, 'the first registration after the outage is handed a coin');
    assert.equal(coins.reservationsReclaimed(), 4);
  });

  it('publishes who holds what while the fault is standing', async () => {
    const { reservation, coins, advance } = harness({ lanes: 2 });
    const pool = [dust('n1'), dust('n2')];
    for (const [index, label] of ['the spare mUSD mint', 'the registration of hectest.night'].entries()) {
      await assert.rejects(
        reservation.exclusive(
          async () => {
            const ticket = reserveCoin(coins, label, pool[index]!);
            ticket.submitted(T0 + 30 * MINUTE, { acknowledged: false });
            throw new Error('the node did not acknowledge this transaction within 30 s');
          },
          { label },
        ),
        /did not acknowledge/,
      );
    }
    advance(4 * MINUTE);

    const summary = coins.reservedCoins();
    assert.equal(summary.count, 2);
    assert.equal(summary.held, 0);
    assert.equal(summary.inFlight, 2);
    assert.equal(summary.oldestAgeMs, 4 * MINUTE);
    assert.deepEqual(
      summary.jobs.map((entry) => entry.label).sort(),
      ['the registration of hectest.night', 'the spare mUSD mint'],
    );
    assert.ok(summary.jobs.every((entry) => entry.jobId !== null && entry.state === 'submitted'));
  });
});

/* -------------------------------------------------------------------------- */
/* The verdict                                                                */
/* -------------------------------------------------------------------------- */

/** A well service between jobs, with the reservation facts added. */
const facts = (overrides: Partial<HealthFacts> = {}): HealthFacts => ({
  now: T0,
  uptimeMs: 60 * MINUTE,
  stateReadable: true,
  synced: true,
  connected: true,
  /* The 16:44 reading: 1.1e20 Specks and 293 UTxOs, and not one of them
     reachable. */
  dustSpecks: 111_038_200_134_194_986_257n,
  utxoCount: 293,
  nightAtomic: 4_998_916_000n,
  dustGenerating: true,
  pendingTransactions: 0,
  proving: 'server',
  reserved: false,
  busy: false,
  reservedCoins: 0,
  lanes: 3,
  oldestReservationAgeMs: 0,
  syncAhead: null,
  lastSponsorshipAt: T0 - 5 * MINUTE,
  orphans: 0,
  lastStateChangeAt: T0 - MINUTE,
  consecutiveUnhealthy: 0,
  nodeSocket: 'connected',
  consecutiveSocketFailures: 0,
  consecutiveRebuildFailures: 0,
  socketHead: { height: 342_015, at: T0, subscribed: true, offered: true, headers: 50 },
  ...overrides,
});

describe('the verdict on coins nobody owns', () => {
  it('reports degraded, and names the jobs that no longer exist', () => {
    const verdict = assessHealth(
      facts({ reservedCoins: 8, lanes: 3, oldestReservationAgeMs: 6 * MINUTE }),
    );
    assert.equal(verdict.verdict, 'degraded');
    assert.match(verdict.reason, /fee coins reserved by jobs that no longer exist/);
    assert.match(verdict.reason, /8 coin\(s\) against 3 lane\(s\)/);
    assert.equal(verdict.act, true);
    assert.equal(verdict.restartEligible, false);
    assert.equal(verdict.reservationFault, true);
  });

  it('asks for a reclaim and not a restart', () => {
    const reading = facts({ reservedCoins: 8, lanes: 3, oldestReservationAgeMs: 6 * MINUTE });
    const choice = chooseRemedy(
      assessHealth(reading),
      reading,
      { lastRewarmAt: null, lastResyncDustAt: null, record: { ...EMPTY_HEALTH_RECORD } },
      DEFAULT_REMEDY_POLICY,
    );
    assert.equal(choice.remedy, 'reclaim');
    assert.match(choice.reason, /taken back, not the process restarted/);
  });

  it('says nothing while the reservations are younger than the reclaim bound', () => {
    /* A job that ended a moment ago may still have a submission the sweeper has
       not ruled on. Firing here would put this verdict on the journal after
       every ordinary outage minute. */
    const verdict = assessHealth(
      facts({
        reservedCoins: 8,
        lanes: 3,
        oldestReservationAgeMs: DEFAULT_HEALTH_POLICY.reservationReclaimMs - SECOND,
      }),
    );
    assert.equal(verdict.verdict, 'healthy');
  });

  it('says nothing while a job is running — a job owns its own coins', () => {
    const verdict = assessHealth(
      facts({ busy: true, reservedCoins: 8, lanes: 3, oldestReservationAgeMs: 6 * MINUTE }),
    );
    assert.equal(verdict.verdict, 'busy');
  });

  it('says nothing for a reservation per lane, which is the ordinary reading', () => {
    const verdict = assessHealth(
      facts({ reservedCoins: 3, lanes: 3, oldestReservationAgeMs: 6 * MINUTE }),
    );
    assert.equal(verdict.verdict, 'healthy');
  });

  it('leaves a dead submission socket ahead of it — the cause, not the symptom', () => {
    /* During the drill itself the socket verdict is the true one: the coins are
       piling up because nothing can be submitted, and reclaiming them would not
       help. */
    const verdict = assessHealth(
      facts({
        consecutiveSocketFailures: 5,
        reservedCoins: 8,
        lanes: 3,
        oldestReservationAgeMs: 6 * MINUTE,
      }),
    );
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.socketFault, true);
  });
});
