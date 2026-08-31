/**
 * The watchdog's judgement, tested without a chain, a clock, or a droplet.
 *
 * What these guard is the asymmetry that makes a self-healing sponsor safe to
 * run: acting when it should not is far worse than not acting when it should.
 * The two states this wallet spends most of its unavailable seconds in — a
 * spend in flight, and the DUST settle after one — are states in which the
 * remedy IS the outage, so the tests that matter most here are the ones that
 * assert nothing happens.
 *
 * Every fact is passed in and every timestamp is arithmetic on a fixed `T0`, so
 * a forty-second settle and a two-minute proof sit exactly where the live
 * observations put them rather than wherever a real clock happened to land.
 *
 * The degraded and restart branches are proved HERE and only here. The live
 * sponsor is never deliberately broken to watch it heal.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_HEALTH_POLICY,
  DEFAULT_REMEDY_POLICY,
  EMPTY_HEALTH_RECORD,
  assessHealth,
  chooseRemedy,
  startHealthLoop,
  type HealthAssessment,
  type HealthFacts,
  type HealthProbeReading,
  type HealthRecord,
  type HealthRemedy,
} from '../src/health.js';

/** An arbitrary fixed instant, well past any start-up grace. */
const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

/**
 * A wallet doing its job: synced, connected, three DUST UTxOs, proving through
 * the configured server, nothing in flight, an hour of uptime, a sponsorship
 * five minutes ago, indices that moved a minute ago.
 *
 * Every test below is this minus exactly one thing, which is the point: it says
 * in one place what "well" means, and each case names its own single deviation.
 */
const healthy = (overrides: Partial<HealthFacts> = {}): HealthFacts => ({
  now: T0,
  uptimeMs: 60 * MINUTE,
  stateReadable: true,
  synced: true,
  connected: true,
  dustSpecks: 23_464_217_639_022_489_435n,
  utxoCount: 3,
  proving: 'server',
  reserved: false,
  busy: false,
  lastSponsorshipAt: T0 - 5 * MINUTE,
  lastStateChangeAt: T0 - MINUTE,
  consecutiveUnhealthy: 0,
  ...overrides,
});

describe('the health verdict', () => {
  it('calls a working wallet healthy', () => {
    const verdict = assessHealth(healthy());
    assert.equal(verdict.verdict, 'healthy');
    assert.equal(verdict.act, false);
  });

  /* ---------------------------------------------------------------------- */
  /* Case 1: the DUST settle. The one that must never be treated as a fault. */
  /* ---------------------------------------------------------------------- */

  it('calls the 20-to-60-second DUST settle `settling`, never `degraded`', () => {
    /* The wallet holds ONE large NIGHT UTxO, so a fee-bearing submission
       nullifies its DUST and the replacement only lands with that transaction.
       Sampled across the whole observed window, second by second. */
    for (let elapsed = 0; elapsed <= 60_000; elapsed += 1_000) {
      const verdict = assessHealth(
        healthy({
          now: T0 + elapsed,
          dustSpecks: 0n,
          utxoCount: 0,
          lastSponsorshipAt: T0,
          lastStateChangeAt: T0,
        }),
      );
      assert.equal(
        verdict.verdict,
        'settling',
        `at ${elapsed / 1_000} s after a sponsorship the verdict was ${verdict.verdict}`,
      );
      assert.equal(verdict.act, false, 'nothing may act during the DUST settle');
    }
  });

  it('calls the post-spend syncing flap `settling` too, for the same reason', () => {
    /* A spend does not only nullify the DUST: the SDK scores being one event
       AHEAD of the stream the same as being behind, so the wallet also reads
       `isSynced: false` for up to about two minutes. Both halves are one
       expected event, so the settle branch is deliberately not gated on
       `synced`. */
    const verdict = assessHealth(
      healthy({
        now: T0 + 2 * MINUTE,
        synced: false,
        dustSpecks: 0n,
        utxoCount: 0,
        lastSponsorshipAt: T0,
      }),
    );
    assert.equal(verdict.verdict, 'settling');
    assert.equal(verdict.act, false);
  });

  it('stops calling it settling once the settle window has passed', () => {
    const verdict = assessHealth(
      healthy({
        now: T0 + DEFAULT_HEALTH_POLICY.settleWindowMs + 1_000,
        dustSpecks: 0n,
        utxoCount: 0,
        lastSponsorshipAt: T0,
      }),
    );
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.restartEligible, true);
  });

  it('treats a cold start with no DUST as settling, not as a fault', () => {
    /* A fresh process walks the chain and then waits for the DUST registration
       to be affordable out of projected generation. Restarting into that wait
       would never end. */
    const verdict = assessHealth(
      healthy({ uptimeMs: 3 * MINUTE, synced: false, dustSpecks: 0n, utxoCount: 0, lastSponsorshipAt: null }),
    );
    assert.equal(verdict.verdict, 'settling');
    assert.equal(verdict.act, false);
  });

  /* ---------------------------------------------------------------------- */
  /* Case 2: legitimately busy. The "locked while in use" the owner asked for. */
  /* ---------------------------------------------------------------------- */

  it('calls a two-minute shielded proof `busy` for every second of it', () => {
    for (let elapsed = 0; elapsed <= 120_000; elapsed += 5_000) {
      const verdict = assessHealth(healthy({ now: T0 + elapsed, busy: true }));
      assert.equal(verdict.verdict, 'busy', `at ${elapsed / 1_000} s into the proof`);
      assert.equal(verdict.act, false);
    }
  });

  it('calls an outstanding claim on the coin state `busy`', () => {
    const verdict = assessHealth(healthy({ reserved: true }));
    assert.equal(verdict.verdict, 'busy');
    assert.equal(verdict.act, false);
  });

  it('refuses to act while in use even when everything else is wrong', () => {
    /* The gate that matters: a wallet that is unsynced, disconnected, DUST-less,
       unreadable, and has been failing for ten ticks is STILL not to be touched
       while somebody is mid-spend. */
    for (const inUse of [{ reserved: true }, { busy: true }]) {
      const verdict = assessHealth(
        healthy({
          ...inUse,
          stateReadable: false,
          synced: false,
          connected: false,
          dustSpecks: 0n,
          utxoCount: 0,
          proving: 'failed',
          lastSponsorshipAt: T0 - 60 * MINUTE,
          lastStateChangeAt: T0 - 60 * MINUTE,
          consecutiveUnhealthy: 10,
        }),
      );
      assert.equal(verdict.verdict, 'busy');
      assert.equal(verdict.act, false);
      assert.equal(verdict.restartEligible, false);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Case 3: genuinely degraded.                                            */
  /* ---------------------------------------------------------------------- */

  it('reaches degraded for a wallet that is unsynced and idle', () => {
    const verdict = assessHealth(healthy({ synced: false }));
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.act, true);
    assert.equal(verdict.restartEligible, true);
  });

  it('stays degraded across several unsynced-and-idle ticks', () => {
    for (const ticks of [0, 1, 2, 3, 4]) {
      const verdict = assessHealth(healthy({ synced: false, consecutiveUnhealthy: ticks }));
      assert.equal(verdict.verdict, 'degraded', `tick ${ticks + 1}`);
    }
  });

  it('catches a dropped indexer subscription on a wallet that still reads as synced', () => {
    /* The "RPC-CORE: disconnected … Normal Closure" failure: balances and
       indices look fine, and the wallet has simply stopped being told about new
       blocks. Invisible in the balance alone, which is why `connected` is one of
       the facts. */
    const verdict = assessHealth(healthy({ connected: false }));
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.restartEligible, true);
  });

  it('catches key material that never loaded, and does not answer it with a restart', () => {
    const verdict = assessHealth(healthy({ proving: 'failed' }));
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.act, true);
    assert.equal(
      verdict.restartEligible,
      false,
      'restarting into the same failed download fixes nothing and loses the sync position',
    );
  });

  it('calls a wallet with no DUST and no sponsorship to explain it degraded', () => {
    const verdict = assessHealth(healthy({ dustSpecks: 0n, utxoCount: 0, lastSponsorshipAt: null }));
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.restartEligible, true);
  });

  it('reports a stalled wallet, but never bounces the service for it alone', () => {
    const verdict = assessHealth(healthy({ lastStateChangeAt: T0 - 45 * MINUTE }));
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.act, true);
    assert.equal(verdict.restartEligible, false, 'staleness is too soft a signal to restart on');
  });

  /* ---------------------------------------------------------------------- */
  /* Case 4: wedged.                                                        */
  /* ---------------------------------------------------------------------- */

  it('gives an unreadable wallet one tick of doubt, then calls it wedged', () => {
    const first = assessHealth(healthy({ stateReadable: false, consecutiveUnhealthy: 0 }));
    assert.equal(first.verdict, 'degraded');
    const second = assessHealth(healthy({ stateReadable: false, consecutiveUnhealthy: 1 }));
    assert.equal(second.verdict, 'wedged');
    assert.equal(second.restartEligible, true);
  });

  it('does not let the start-up grace hide a wedged facade', () => {
    /* A syncing wallet answers `currentState()` perfectly well and reports
       `isSynced: false`. One that answers nothing at all is a different thing,
       and being young is no excuse for it. */
    const verdict = assessHealth(
      healthy({ uptimeMs: MINUTE, stateReadable: false, consecutiveUnhealthy: 1 }),
    );
    assert.equal(verdict.verdict, 'wedged');
  });
});

/* -------------------------------------------------------------------------- */
/* The remedy ladder and its rate limits                                      */
/* -------------------------------------------------------------------------- */

const state = (overrides: Partial<HealthRecord> = {}, lastRewarmAt: number | null = null) => ({
  lastRewarmAt,
  record: { ...EMPTY_HEALTH_RECORD, ...overrides },
});

describe('the remedy ladder', () => {
  it('does nothing at all for healthy, busy, and settling', () => {
    for (const facts of [
      healthy(),
      healthy({ busy: true }),
      healthy({ reserved: true }),
      healthy({ dustSpecks: 0n, utxoCount: 0, lastSponsorshipAt: T0 - 30_000 }),
    ]) {
      const assessment = assessHealth(facts);
      assert.equal(chooseRemedy(assessment, facts, state()).remedy, 'none');
    }
  });

  it('escalates refresh, then re-warm, then restart across consecutive ticks', () => {
    const ladder: HealthRemedy[] = [];
    for (const ticks of [0, 1, 2]) {
      const facts = healthy({ synced: false, consecutiveUnhealthy: ticks });
      ladder.push(chooseRemedy(assessHealth(facts), facts, state()).remedy);
    }
    assert.deepEqual(ladder, ['refresh', 'rewarm', 'restart']);
  });

  it('sends a wedged facade straight to a restart, because nothing else can reach it', () => {
    const facts = healthy({ stateReadable: false, consecutiveUnhealthy: 1 });
    const assessment = assessHealth(facts);
    assert.equal(assessment.verdict, 'wedged');
    assert.equal(chooseRemedy(assessment, facts, state()).remedy, 'restart');
  });

  it('never restarts for a cause a restart would not fix', () => {
    const facts = healthy({ proving: 'failed', consecutiveUnhealthy: 9 });
    const choice = chooseRemedy(assessHealth(facts), facts, state());
    assert.equal(choice.remedy, 'rewarm', 'the repair for lost key material is to fetch it again');
  });

  it('holds the restart rate limit for a full thirty minutes', () => {
    /* Sampled every minute from the moment of the last request. The limit is
       read off the PERSISTED record, so it binds across the restart it bounds —
       an in-memory limit would reset on the very event it exists to rate-limit. */
    const lastRestartRequestAt = new Date(T0).toISOString();
    for (let elapsed = 0; elapsed < DEFAULT_REMEDY_POLICY.restartCooldownMs; elapsed += MINUTE) {
      const facts = healthy({ now: T0 + elapsed, synced: false, consecutiveUnhealthy: 9 });
      const choice = chooseRemedy(
        assessHealth(facts),
        facts,
        state({ lastRestartRequestAt, awaitingHealthyTick: false }),
      );
      assert.notEqual(choice.remedy, 'restart', `restarted again ${elapsed / MINUTE} min later`);
    }
    /* And releases exactly once it has elapsed. */
    const after = healthy({
      now: T0 + DEFAULT_REMEDY_POLICY.restartCooldownMs,
      synced: false,
      consecutiveUnhealthy: 9,
    });
    assert.equal(
      chooseRemedy(assessHealth(after), after, state({ lastRestartRequestAt })).remedy,
      'restart',
    );
  });

  it('never restarts twice without an intervening healthy tick', () => {
    /* Even with the cooldown long past: a second restart on the strength of the
       same never-recovering fault is a restart loop with a slow clock. */
    const facts = healthy({
      now: T0 + 10 * DEFAULT_REMEDY_POLICY.restartCooldownMs,
      synced: false,
      consecutiveUnhealthy: 9,
    });
    const choice = chooseRemedy(
      assessHealth(facts),
      facts,
      state({ lastRestartRequestAt: new Date(T0).toISOString(), awaitingHealthyTick: true }),
    );
    assert.equal(choice.remedy, 'refresh');
    assert.match(choice.reason, /has not yet been followed by a healthy tick/);
  });

  it('will not restart while the wallet is in use, whatever the streak', () => {
    /* Belt and braces: `assessHealth` already answers `busy` here, so this
       drives `chooseRemedy` with a restart-worthy assessment directly to prove
       the second gate holds on its own. */
    const assessment: HealthAssessment = {
      verdict: 'wedged',
      reason: 'contrived',
      act: true,
      restartEligible: true,
    };
    for (const inUse of [{ reserved: true }, { busy: true }]) {
      const facts = healthy({ ...inUse, consecutiveUnhealthy: 9 });
      const choice = chooseRemedy(assessment, facts, state());
      assert.equal(choice.remedy, 'refresh');
      assert.match(choice.reason, /the wallet is in use/);
    }
  });

  it('holds the re-warm cooldown as well', () => {
    const facts = healthy({ synced: false, consecutiveUnhealthy: 1 });
    assert.equal(chooseRemedy(assessHealth(facts), facts, state({}, T0 - MINUTE)).remedy, 'refresh');
    assert.equal(
      chooseRemedy(
        assessHealth(facts),
        facts,
        state({}, T0 - DEFAULT_REMEDY_POLICY.rewarmCooldownMs),
      ).remedy,
      'rewarm',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The loop                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A loop wired to a scripted probe, a fake clock, and no timers worth waiting
 * for: the interval is set high enough that only the explicit `tick()` calls
 * below ever run, so the ordering under test is the test's and not the event
 * loop's.
 */
function harness(readings: HealthProbeReading[]) {
  let clock = T0;
  let record: HealthRecord = { ...EMPTY_HEALTH_RECORD };
  const calls: HealthRemedy[] = [];
  let index = 0;
  const monitor = startHealthLoop({
    intervalMs: 3_600_000,
    now: () => clock,
    random: () => 0.5,
    log: () => undefined,
    warn: () => undefined,
    probe: async () => readings[Math.min(index++, readings.length - 1)]!,
    store: {
      read: () => record,
      write: async (next) => {
        record = next;
      },
    },
    remedies: {
      refresh: async () => {
        calls.push('refresh');
      },
      rewarm: async () => {
        calls.push('rewarm');
      },
      /* Emphatically does NOT exit: the real one calls `process.exit(1)`, and a
         test that ran it would take the runner with it. */
      restart: async () => {
        calls.push('restart');
      },
    },
  });
  return {
    monitor,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
    record: () => record,
  };
}

const reading = (overrides: Partial<HealthProbeReading> = {}): HealthProbeReading => {
  const { now: _now, consecutiveUnhealthy: _c, lastStateChangeAt: _l, ...rest } = healthy();
  return { ...rest, fingerprint: 'a', ...overrides };
};

describe('the health loop', () => {
  it('counts consecutive unhealthy ticks and resets on a healthy one', async () => {
    const h = harness([
      reading({ synced: false }),
      reading({ synced: false }),
      reading({}),
      reading({ synced: false }),
    ]);
    assert.equal((await h.monitor.tick())?.verdict, 'degraded');
    assert.equal(h.monitor.snapshot().consecutiveUnhealthy, 1);
    assert.equal((await h.monitor.tick())?.verdict, 'degraded');
    assert.equal(h.monitor.snapshot().consecutiveUnhealthy, 2);
    assert.equal((await h.monitor.tick())?.verdict, 'healthy');
    assert.equal(h.monitor.snapshot().consecutiveUnhealthy, 0, 'a healthy tick clears the streak');
    assert.equal((await h.monitor.tick())?.verdict, 'degraded');
    assert.equal(h.monitor.snapshot().consecutiveUnhealthy, 1, 'and the count starts again');
    h.monitor.stop();
  });

  it('does not let a busy tick clear an unhealthy streak', async () => {
    /* A wallet that was degraded and is now merely mid-spend has not been shown
       to be well. Zeroing the count here would let a fault that coincides with
       traffic escalate never. */
    const h = harness([reading({ synced: false }), reading({ busy: true }), reading({ synced: false })]);
    await h.monitor.tick();
    await h.monitor.tick();
    assert.equal(h.monitor.snapshot().verdict, 'busy');
    assert.equal(h.monitor.snapshot().consecutiveUnhealthy, 1, 'the streak is held, not cleared');
    await h.monitor.tick();
    assert.equal(h.monitor.snapshot().consecutiveUnhealthy, 2);
    h.monitor.stop();
  });

  it('runs no remedy at all across a settle and a proof', async () => {
    const h = harness([
      reading({ dustSpecks: 0n, utxoCount: 0, lastSponsorshipAt: T0 - 30_000 }),
      reading({ busy: true }),
      reading({ reserved: true }),
      reading({}),
    ]);
    for (let n = 0; n < 4; n += 1) await h.monitor.tick();
    assert.deepEqual(h.calls, [], 'nothing may be called while settling or in use');
    h.monitor.stop();
  });

  it('persists the restart request before it would exit, and bars the next one', async () => {
    const h = harness([
      reading({ synced: false }),
      reading({ synced: false }),
      reading({ synced: false }),
      reading({ synced: false }),
    ]);
    await h.monitor.tick();
    await h.monitor.tick();
    await h.monitor.tick();
    assert.deepEqual(h.calls, ['refresh', 'rewarm', 'restart']);
    assert.equal(h.record().restarts, 1);
    assert.equal(h.record().awaitingHealthyTick, true);
    assert.equal(h.monitor.snapshot().restartsRequestedSinceBoot, 1);

    /* An hour later — the cooldown long gone — and still no second restart,
       because no healthy tick has been seen. */
    h.advance(60 * MINUTE);
    await h.monitor.tick();
    assert.deepEqual(h.calls, ['refresh', 'rewarm', 'restart', 'refresh']);
    h.monitor.stop();
  });

  it('lifts the bar once a healthy tick is seen, and only then', async () => {
    const h = harness([
      reading({ synced: false }),
      reading({ synced: false }),
      reading({ synced: false }),
      /* Whatever went wrong has cleared — by itself, or because the process the
         restart request produced came back well. A moved fingerprint, because
         a wallet that is following the chain again is a wallet whose indices
         have moved; leaving it unchanged across half an hour would trip the
         stall branch instead, which is itself the right answer. */
      reading({ fingerprint: 'b' }),
      reading({ synced: false }),
      reading({ synced: false }),
      reading({ synced: false }),
    ]);
    for (let n = 0; n < 3; n += 1) await h.monitor.tick();
    assert.deepEqual(h.calls, ['refresh', 'rewarm', 'restart']);
    assert.equal(h.record().awaitingHealthyTick, true);

    h.advance(31 * MINUTE);
    await h.monitor.tick();
    assert.equal(h.monitor.snapshot().verdict, 'healthy');
    assert.equal(h.record().awaitingHealthyTick, false, 'a healthy tick lifts the bar');
    assert.equal(h.monitor.snapshot().awaitingHealthyTick, false, 'and /status says so');

    /* And with the bar lifted and the cooldown spent, a fresh fault may
       escalate all the way again. */
    for (let n = 0; n < 3; n += 1) {
      h.advance(MINUTE);
      await h.monitor.tick();
    }
    assert.deepEqual(h.calls, ['refresh', 'rewarm', 'restart', 'refresh', 'rewarm', 'restart']);
    assert.equal(h.record().restarts, 2);
    h.monitor.stop();
  });

  it('tracks the state fingerprint so a stalled wallet can be told from a quiet one', async () => {
    const h = harness([
      reading({ fingerprint: 'a' }),
      reading({ fingerprint: 'b' }),
      reading({ fingerprint: 'b' }),
    ]);
    for (let n = 0; n < 3; n += 1) {
      await h.monitor.tick();
      h.advance(MINUTE);
    }
    /* Three healthy ticks, no remedy: the stall threshold is half an hour and
       the fingerprint moved inside it. */
    assert.deepEqual(h.calls, []);
    h.monitor.stop();
  });

  it('publishes what /status reports', async () => {
    const h = harness([reading({ synced: false })]);
    await h.monitor.tick();
    const published = h.monitor.snapshot();
    assert.equal(published.verdict, 'degraded');
    assert.equal(published.checks, 1);
    assert.equal(published.consecutiveUnhealthy, 1);
    assert.equal(published.lastRemedy?.remedy, 'refresh');
    assert.equal(published.lastRemedy?.outcome, 'ok');
    assert.equal(published.lastCheckAt, new Date(T0).toISOString());
    assert.equal(published.restartsRequestedTotal, 0);
    h.monitor.stop();
  });

  it('records a remedy that fails rather than swallowing it', async () => {
    let clock = T0;
    let record: HealthRecord = { ...EMPTY_HEALTH_RECORD };
    const monitor = startHealthLoop({
      intervalMs: 3_600_000,
      now: () => clock,
      random: () => 0.5,
      log: () => undefined,
      warn: () => undefined,
      probe: async () => reading({ synced: false }),
      store: { read: () => record, write: async (next) => { record = next; } },
      remedies: {
        refresh: async () => {
          throw new Error('the wallet did not answer');
        },
        rewarm: async () => undefined,
        restart: async () => undefined,
      },
    });
    await monitor.tick();
    clock += MINUTE;
    assert.equal(monitor.snapshot().lastRemedy?.outcome, 'failed');
    assert.equal(monitor.snapshot().lastRemedy?.detail, 'the wallet did not answer');
    monitor.stop();
  });

  it('treats a probe that throws as an unreadable wallet, not as a healthy one', async () => {
    let record: HealthRecord = { ...EMPTY_HEALTH_RECORD };
    const monitor = startHealthLoop({
      intervalMs: 3_600_000,
      now: () => T0,
      random: () => 0.5,
      log: () => undefined,
      warn: () => undefined,
      probe: async () => {
        throw new Error('state() timed out');
      },
      store: { read: () => record, write: async (next) => { record = next; } },
      remedies: {
        refresh: async () => undefined,
        rewarm: async () => undefined,
        restart: async () => undefined,
      },
    });
    assert.equal((await monitor.tick())?.verdict, 'degraded');
    assert.equal((await monitor.tick())?.verdict, 'wedged');
    monitor.stop();
  });
});
