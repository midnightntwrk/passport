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

import type { ChainHeadProbe, ChainHeadReading } from '../src/chainHead.js';
import { DEFAULT_HEALTH_INTERVAL_MS } from '../src/config.js';
import {
  DEFAULT_HEALTH_POLICY,
  DEFAULT_REMEDY_POLICY,
  EMPTY_HEALTH_RECORD,
  assessHealth,
  chooseRemedy,
  startHealthLoop,
  type ChainHeadFacts,
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
  /* 4,998.916 NIGHT — what the balancer actually holds, so a wedge case can be
     written by removing the DUST and changing nothing else. */
  nightAtomic: 4_998_916_000n,
  dustGenerating: true,
  pendingTransactions: 0,
  proving: 'server',
  reserved: false,
  busy: false,
  syncAhead: null,
  lastSponsorshipAt: T0 - 5 * MINUTE,
  orphans: 0,
  lastStateChangeAt: T0 - MINUTE,
  consecutiveUnhealthy: 0,
  /* The submission socket, healthy by default: `./submission.ts` reports
     `connected` whenever no failure stands against it, which includes the state
     before the first submission has opened anything. */
  nodeSocket: 'connected',
  consecutiveSocketFailures: 0,
  consecutiveRebuildFailures: 0,
  /* The socket's own view of the chain, healthy by default: subscribed, and a
     header a moment ago. `342,015` is the height stagenet actually reported on
     2026/09/06 — `0x537ff` — so the arithmetic in these assertions is at the
     scale of the real chain rather than a convenient small integer. */
  socketHead: { height: 342_015, at: T0 - 6_000, subscribed: true, headers: 3_000 },
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
    /* And names it precisely, rather than lumping it in with `degraded`. This
       reading — synced, holding NIGHT, no DUST, nothing pending, nothing
       outstanding, well past the settle — is the wedge and nothing else, which
       is exactly what the journal said in the coarser words it had on
       2026/09/02: 'degraded: no spendable DUST 12/22/32 min after the last
       sponsorship'. Three ticks of a ladder that could not reach it. */
    const verdict = assessHealth(
      healthy({
        now: T0 + DEFAULT_HEALTH_POLICY.settleWindowMs + 1_000,
        dustSpecks: 0n,
        utxoCount: 0,
        lastSponsorshipAt: T0,
      }),
    );
    assert.equal(verdict.verdict, 'dust-wedged');
    assert.equal(verdict.act, true);
  });

  /* The 2026/09/02 wedge, and the two halves of what it taught. A transaction
     the node refused took this wallet's only DUST coins with it; the DUST was
     booked, not spent, and no clock could tell the difference. The sweeper in
     `../src/wallet.ts` asks the chain instead — so the fact the watchdog needs
     is not "how long ago" but "is anything still outstanding". */
  it('calls a wallet whose DUST is booked against an outstanding balance `settling`', () => {
    const verdict = assessHealth(
      healthy({
        now: T0 + 10 * DEFAULT_HEALTH_POLICY.settleWindowMs,
        dustSpecks: 0n,
        utxoCount: 0,
        lastSponsorshipAt: T0,
        orphans: 1,
      }),
    );
    assert.equal(verdict.verdict, 'settling', 'restarting would lose the sync and fix nothing');
    assert.equal(verdict.act, false);
    assert.equal(verdict.restartEligible, false);
    assert.match(verdict.reason, /outstanding/);
  });

  it('is healthy again the moment the sweeper has released that DUST', () => {
    /* The sweeper reverted the booking, so the coin is back and nothing is
       outstanding. Nothing here waits out the rest of the settle window: the
       wallet can pay somebody's fee this instant, which is the only question
       `healthy` answers. */
    const verdict = assessHealth(
      healthy({
        now: T0 + 30_000,
        lastSponsorshipAt: T0,
        orphans: 0,
      }),
    );
    assert.equal(verdict.verdict, 'healthy');
    assert.equal(verdict.act, false);
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

  it('calls a wallet with NIGHT, no DUST, and no sponsorship to explain it a wedge', () => {
    /* The reading a restart INHERITS. `lastSponsorshipAt` is null because this
       process has sponsored nothing since it started — which is precisely the
       state the 16:21:01 restart of 2026/09/02 came back in, having resumed
       from a snapshot that carried the pending flags forward. Nothing about a
       fresh process makes the withheld coins less withheld. */
    const verdict = assessHealth(healthy({ dustSpecks: 0n, utxoCount: 0, lastSponsorshipAt: null }));
    assert.equal(verdict.verdict, 'dust-wedged');
    assert.equal(verdict.restartEligible, false);
  });

  it('calls a wallet with neither NIGHT nor DUST degraded — it is empty, not wedged', () => {
    const verdict = assessHealth(
      healthy({ dustSpecks: 0n, utxoCount: 0, nightAtomic: 0n, lastSponsorshipAt: null }),
    );
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.restartEligible, true);
    assert.match(verdict.reason, /sponsored nothing to explain it/);
  });

  it('reports a stalled wallet, but never bounces the service for it alone', () => {
    const verdict = assessHealth(healthy({ lastStateChangeAt: T0 - 45 * MINUTE }));
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.act, true);
    assert.equal(verdict.restartEligible, false, 'staleness is too soft a signal to restart on');
  });

  /* ---------------------------------------------------------------------- */
  /* Case 3b: the DUST wedge — a wallet holding money it cannot see.        */
  /* ---------------------------------------------------------------------- */

  /**
   * The reading that took the sponsor down twice on 2026/09/02: 4,998 NIGHT,
   * a synced wallet, no spendable DUST, and nothing whatsoever to explain it.
   * The ledger's `spend()` had set `pending_until = ctime + 3 h` on both coins
   * and the revert that should have cleared them found nothing to clear.
   *
   * Every case below is that reading minus one term of the conjunction, and
   * each of them must fall back to an innocent verdict, because acting on a
   * wallet that is merely mid-spend is the worse of the two mistakes.
   */
  const wedgedDust = (overrides: Partial<HealthFacts> = {}): HealthFacts =>
    healthy({
      dustSpecks: 0n,
      utxoCount: 0,
      lastSponsorshipAt: T0 - 3 * MINUTE,
      ...overrides,
    });

  it('calls a wallet holding NIGHT with no DUST, nothing pending and nothing outstanding dust-wedged', () => {
    const verdict = assessHealth(wedgedDust());
    assert.equal(verdict.verdict, 'dust-wedged');
    assert.equal(verdict.act, true);
    assert.equal(
      verdict.restartEligible,
      false,
      'a restart resumes from the snapshot, and the snapshot carries the pending flags',
    );
  });

  it('calls the same reading settling while one of the wallet’s own transactions is pending', () => {
    /* Correct and temporary: the coin that paid for that transaction is
       legitimately nullified until it lands. */
    assert.equal(assessHealth(wedgedDust({ pendingTransactions: 1 })).verdict, 'settling');
  });

  it('calls the same reading settling while a balanced transaction is outstanding', () => {
    /* The sweeper has a claim on that coin and will rule on it. */
    assert.equal(assessHealth(wedgedDust({ orphans: 1 })).verdict, 'settling');
  });

  it('calls the same reading busy while the wallet is claimed or holding the queue', () => {
    assert.equal(assessHealth(wedgedDust({ reserved: true })).verdict, 'busy');
    assert.equal(assessHealth(wedgedDust({ busy: true })).verdict, 'busy');
  });

  it('never calls an empty wallet wedged — there is nothing there to withhold', () => {
    const verdict = assessHealth(wedgedDust({ nightAtomic: 0n, lastSponsorshipAt: null }));
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.restartEligible, true);
  });

  it('sees a wedge INSIDE the start-up grace, because that is where an inherited one lives', () => {
    /* The snapshot carries the pending flags across a restart, so a restarted
       process's first minutes are exactly where a wedge survives. Observed live
       at 17:21:01 on 2026/09/02: a revert reported the wedge and the verdict
       came back 'still starting up (271 s in)'. */
    assert.equal(assessHealth(wedgedDust({ uptimeMs: 271_000 })).verdict, 'dust-wedged');
  });

  it('still lets a cold start whose NIGHT is not yet registered wait', () => {
    /* A wallet whose NIGHT is not registered has no DUST for an honest reason
       and no amount of resyncing would give it any. This is the term that keeps
       the wedge branch safe in front of the grace. */
    assert.equal(
      assessHealth(wedgedDust({ uptimeMs: 271_000, dustGenerating: false })).verdict,
      'settling',
    );
  });

  it('waits out the orphan window before calling a fresh spend a wedge', () => {
    /* Inside `orphanMs` the reading is exactly what a spend that has just
       happened looks like, and repairing it would revert a transaction on its
       way to a block. */
    assert.equal(
      assessHealth(wedgedDust({ lastSponsorshipAt: T0 - 30_000 })).verdict,
      'settling',
    );
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

const state = (
  overrides: Partial<HealthRecord> = {},
  lastRewarmAt: number | null = null,
  lastResyncDustAt: number | null = null,
) => ({
  lastRewarmAt,
  lastResyncDustAt,
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
    /* The rungs are counted in TICKS, so the wall-clock time to reach the last
       one is a function of the health cadence — which is why the figures are
       read off the policy here rather than written out. See
       `restartAfterTicks`: it moved from 3 to 15 when the cadence went from ten
       minutes to two, precisely so that this ladder still takes thirty minutes
       to reach a restart. */
    const ladder: HealthRemedy[] = [];
    for (const ticks of [0, 1, DEFAULT_REMEDY_POLICY.restartAfterTicks - 1]) {
      const facts = healthy({ synced: false, consecutiveUnhealthy: ticks });
      ladder.push(chooseRemedy(assessHealth(facts), facts, state()).remedy);
    }
    assert.deepEqual(ladder, ['refresh', 'rewarm', 'restart']);
  });

  it('takes half an hour of sustained soft fault to ask for a restart, at the shipped cadence', () => {
    /* The invariant the tick count exists to hold, asserted rather than left in
       a comment: a cadence change that forgets to move `restartAfterTicks`
       fails HERE instead of quietly making the sponsor five times more willing
       to bounce itself. Thirty minutes is the figure that was reasoned about;
       the tick count is only how many checks fit inside it. */
    assert.equal(
      DEFAULT_HEALTH_INTERVAL_MS * DEFAULT_REMEDY_POLICY.restartAfterTicks,
      30 * MINUTE,
    );
  });

  it('resyncs the DUST on the FIRST tick of a wedge, without waiting out the restart ladder', () => {
    const facts = healthy({
      dustSpecks: 0n,
      utxoCount: 0,
      lastSponsorshipAt: T0 - 3 * MINUTE,
      consecutiveUnhealthy: 0,
    });
    const assessment = assessHealth(facts);
    assert.equal(assessment.verdict, 'dust-wedged');
    const choice = chooseRemedy(assessment, facts, state());
    assert.equal(choice.remedy, 'resyncDust');
  });

  it('resyncs the DUST even while the restart ladder is barred', () => {
    /* `awaitingHealthyTick` and a restart four minutes ago would both hold a
       `degraded` cause at `refresh`. They must not hold this one: those limits
       exist to stop a soft signal bouncing a live sponsor, and a wedge is
       proved rather than inferred. */
    const facts = healthy({ dustSpecks: 0n, utxoCount: 0, lastSponsorshipAt: T0 - 3 * MINUTE });
    const barred = state({
      awaitingHealthyTick: true,
      lastRestartRequestAt: new Date(T0 - 4 * MINUTE).toISOString(),
      restarts: 3,
    });
    assert.equal(chooseRemedy(assessHealth(facts), facts, barred).remedy, 'resyncDust');
  });

  it('holds the DUST resync to one in any ten minutes', () => {
    /* Ten rather than the two it was until 2026/09/06. A cooldown shorter than
       the interval of the tick that consults it separates nothing, and the tick
       is now two minutes. */
    const facts = (now: number): HealthFacts =>
      healthy({ now, dustSpecks: 0n, utxoCount: 0, lastSponsorshipAt: now - 3 * MINUTE });
    const requestedAt = T0;
    for (const elapsed of [0, 30_000, DEFAULT_REMEDY_POLICY.resyncDustCooldownMs - 1]) {
      const at = facts(requestedAt + elapsed);
      const choice = chooseRemedy(assessHealth(at), at, state({}, null, requestedAt));
      assert.equal(choice.remedy, 'refresh', `${elapsed} ms after a resync`);
    }
    const after = facts(requestedAt + DEFAULT_REMEDY_POLICY.resyncDustCooldownMs);
    assert.equal(
      chooseRemedy(assessHealth(after), after, state({}, null, requestedAt)).remedy,
      'resyncDust',
    );
  });

  it('will not exit for a resync again until this process has been up long enough', () => {
    /* THE BOUND THE COOLDOWN CANNOT PROVIDE. `resyncDust` ends in
       `process.exit(1)` and `lastResyncDustAt` lives in memory, so it dies with
       the process it was meant to bound; the wedge branch also deliberately
       precedes the start-up grace, because an inherited wedge lives in exactly
       those first minutes. A wallet still wedged after its repair therefore
       comes back, sees the wedge on its first tick, and exits again — and until
       2026/09/06 the only thing setting the period of that loop was the health
       interval. At two minutes that would be a spin, so the floor is stated. */
    const wedged = (uptimeMs: number): HealthFacts =>
      healthy({ uptimeMs, dustSpecks: 0n, utxoCount: 0, lastSponsorshipAt: T0 - 3 * MINUTE });

    const fresh = wedged(DEFAULT_REMEDY_POLICY.resyncDustMinUptimeMs - 1);
    assert.equal(assessHealth(fresh).verdict, 'dust-wedged', 'the wedge is still DIAGNOSED at once');
    const held = chooseRemedy(assessHealth(fresh), fresh, state());
    assert.equal(held.remedy, 'refresh', 'but it is not acted on yet');
    assert.match(held.reason, /a resync exits, and one that came back wedged must not exit again/);

    const settled = wedged(DEFAULT_REMEDY_POLICY.resyncDustMinUptimeMs);
    assert.equal(chooseRemedy(assessHealth(settled), settled, state()).remedy, 'resyncDust');
  });

  it('cannot be made to flap by a faster tick, on any rung that exits the process', () => {
    /* The property the 2026/09/06 cadence change had to preserve. Both remedies
       that end this process are bounded by a clock rather than by a tick count,
       so halving or fifthing the interval cannot make either of them fire more
       often than it already could. */
    assert.ok(
      DEFAULT_REMEDY_POLICY.resyncDustMinUptimeMs >= DEFAULT_HEALTH_INTERVAL_MS,
      'a DUST resync must not be reachable on the first tick of every restarted process',
    );
    assert.ok(
      DEFAULT_REMEDY_POLICY.resyncDustCooldownMs >= DEFAULT_HEALTH_INTERVAL_MS,
      'a cooldown shorter than the tick that consults it separates nothing',
    );
    assert.ok(
      DEFAULT_REMEDY_POLICY.socketRestartCooldownMs >= DEFAULT_HEALTH_INTERVAL_MS,
      'the socket restart is rate-limited by its own clock, not by the cadence',
    );
    assert.ok(
      DEFAULT_REMEDY_POLICY.rewarmCooldownMs >= DEFAULT_HEALTH_INTERVAL_MS,
      'the re-warm rung likewise',
    );
  });

  it('never resyncs the DUST while the wallet is in use', () => {
    /* The remedy exits the process. Doing that mid-spend would abandon a proof
       somebody is waiting on — the one thing this module must never cause. */
    for (const inUse of [{ reserved: true }, { busy: true }]) {
      const facts = healthy({
        dustSpecks: 0n,
        utxoCount: 0,
        lastSponsorshipAt: T0 - 3 * MINUTE,
        ...inUse,
      });
      /* Not reachable through `assessHealth`, which calls this busy — asked of
         the ladder directly, so the gate holds even if a future branch reorder
         lets a wedge verdict past the in-use check above it. */
      const assessment: HealthAssessment = {
        verdict: 'dust-wedged',
        reason: 'wedged',
        act: true,
        restartEligible: false,
      };
      assert.equal(chooseRemedy(assessment, facts, state()).remedy, 'refresh');
    }
  });

  it('sends a wedged facade straight to a restart, because nothing else can reach it', () => {
    const facts = healthy({ stateReadable: false, consecutiveUnhealthy: 1 });
    const assessment = assessHealth(facts);
    assert.equal(assessment.verdict, 'wedged');
    assert.equal(chooseRemedy(assessment, facts, state()).remedy, 'restart');
  });

  it('never restarts for a cause a restart would not fix', () => {
    const facts = healthy({ proving: 'failed', consecutiveUnhealthy: DEFAULT_REMEDY_POLICY.restartAfterTicks });
    const choice = chooseRemedy(assessHealth(facts), facts, state());
    assert.equal(choice.remedy, 'rewarm', 'the repair for lost key material is to fetch it again');
  });

  it('holds the restart rate limit for a full thirty minutes', () => {
    /* Sampled every minute from the moment of the last request. The limit is
       read off the PERSISTED record, so it binds across the restart it bounds —
       an in-memory limit would reset on the very event it exists to rate-limit. */
    const lastRestartRequestAt = new Date(T0).toISOString();
    for (let elapsed = 0; elapsed < DEFAULT_REMEDY_POLICY.restartCooldownMs; elapsed += MINUTE) {
      const facts = healthy({ now: T0 + elapsed, synced: false, consecutiveUnhealthy: DEFAULT_REMEDY_POLICY.restartAfterTicks });
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
      consecutiveUnhealthy: DEFAULT_REMEDY_POLICY.restartAfterTicks,
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
      consecutiveUnhealthy: DEFAULT_REMEDY_POLICY.restartAfterTicks,
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
      const facts = healthy({ ...inUse, consecutiveUnhealthy: DEFAULT_REMEDY_POLICY.restartAfterTicks });
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
function harness(
  readings: HealthProbeReading[],
  /* THE TWO OBSERVERS, built against the harness's own clock so a test can move
     the chain, the socket, and the wallet independently — which is the whole of
     what the stall rule is about. Both `undefined` is a loop with no reference
     at all, which is the pre-2026/09/06 behaviour and concludes nothing. */
  makeHead?: (now: () => number) => ChainHeadProbe,
  indexerHeight?: () => number | null,
  /* The socket's own head, scripted per tick rather than taken from `readings`,
     because a case that moves the chain has to be able to move the socket with
     it — or deliberately not to. */
  socketHead?: () => HealthProbeReading['socketHead'],
) {
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
    probe: async () => {
      const next = readings[Math.min(index++, readings.length - 1)]!;
      return socketHead ? { ...next, socketHead: socketHead() } : next;
    },
    ...(makeHead ? { chainHead: makeHead(() => clock) } : {}),
    ...(indexerHeight ? { indexerHeight: async () => indexerHeight() } : {}),
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
      reconnect: async () => {
        calls.push('reconnect');
      },
      rewarm: async () => {
        calls.push('rewarm');
      },
      resyncDust: async () => {
        calls.push('resyncDust');
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

/**
 * The remedies one uninterrupted fault produces, tick by tick, on a clock that
 * does not move between ticks: `refresh`, then the re-warm rung, then `refresh`
 * for as long as it takes to reach the restart rung — the re-warm cooldown
 * holds after the first one because no time has passed.
 *
 * Derived from the policy rather than written out. How many `refresh` ticks sit
 * in the middle is a function of the health cadence (see `restartAfterTicks`),
 * so a literal here would be a test that had to be edited every time the
 * service changed how often it looks at itself.
 */
const ladderToRestart = (): HealthRemedy[] => [
  'refresh',
  'rewarm',
  ...new Array<HealthRemedy>(DEFAULT_REMEDY_POLICY.restartAfterTicks - 3).fill('refresh'),
  'restart',
];

describe('the health loop', () => {
  it('repairs a DUST wedge on its first tick and publishes when it did', async () => {
    const wedge = reading({
      dustSpecks: 0n,
      utxoCount: 0,
      lastSponsorshipAt: T0 - 3 * MINUTE,
    });
    const h = harness([wedge, wedge]);
    assert.equal((await h.monitor.tick())?.verdict, 'dust-wedged');
    assert.deepEqual(h.calls, ['resyncDust'], 'no refresh-then-rewarm ladder in front of it');
    assert.equal(h.monitor.snapshot().lastResyncDustAt, new Date(T0).toISOString());
    assert.equal(h.monitor.snapshot().lastRemedy?.outcome, 'ok');

    /* And it does not do it again a minute later. The real remedy exits the
       process; a cooldown the loop only honoured after a successful exit would
       be no cooldown at all in the case where the exit fails. */
    h.advance(MINUTE);
    await h.monitor.tick();
    assert.deepEqual(h.calls, ['resyncDust', 'refresh']);
  });

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
    for (let n = 0; n < DEFAULT_REMEDY_POLICY.restartAfterTicks; n += 1) {
      await h.monitor.tick();
    }
    assert.deepEqual(h.calls, ladderToRestart());
    assert.equal(h.record().restarts, 1);
    assert.equal(h.record().awaitingHealthyTick, true);
    assert.equal(h.monitor.snapshot().restartsRequestedSinceBoot, 1);

    /* An hour later — the cooldown long gone — and still no second restart,
       because no healthy tick has been seen. */
    h.advance(60 * MINUTE);
    await h.monitor.tick();
    assert.deepEqual(h.calls, [...ladderToRestart(), 'refresh']);
    h.monitor.stop();
  });

  it('lifts the bar once a healthy tick is seen, and only then', async () => {
    const h = harness([
      /* One unbroken fault for the whole of the ladder — as many readings as it
         takes to reach the restart rung, which is a function of the cadence. */
      ...new Array<HealthProbeReading>(DEFAULT_REMEDY_POLICY.restartAfterTicks).fill(
        reading({ synced: false }),
      ),
      /* Whatever went wrong has cleared — by itself, or because the process the
         restart request produced came back well. A moved fingerprint, because
         a wallet that is following the chain again is a wallet whose indices
         have moved; leaving it unchanged across half an hour would trip the
         stall branch instead, which is itself the right answer. */
      reading({ fingerprint: 'b' }),
      /* And then it is back, for as long as the harness is asked to tick. */
      reading({ synced: false }),
    ]);
    for (let n = 0; n < DEFAULT_REMEDY_POLICY.restartAfterTicks; n += 1) {
      await h.monitor.tick();
    }
    assert.deepEqual(h.calls, ladderToRestart());
    assert.equal(h.record().awaitingHealthyTick, true);

    h.advance(31 * MINUTE);
    await h.monitor.tick();
    assert.equal(h.monitor.snapshot().verdict, 'healthy');
    assert.equal(h.record().awaitingHealthyTick, false, 'a healthy tick lifts the bar');
    assert.equal(h.monitor.snapshot().awaitingHealthyTick, false, 'and /status says so');

    /* And with the bar lifted and the cooldown spent, a fresh fault may
       escalate all the way again. The exact rungs in between are not asserted
       this time: the clock moves a minute per tick here, so the re-warm
       cooldown lets a second and a third re-warm through, which is correct and
       is not what this test is about. */
    for (let n = 0; n < DEFAULT_REMEDY_POLICY.restartAfterTicks; n += 1) {
      h.advance(MINUTE);
      await h.monitor.tick();
    }
    assert.equal(h.calls.at(-1), 'restart', 'a fresh fault escalates all the way again');
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
        reconnect: async () => undefined,
        rewarm: async () => undefined,
        resyncDust: async () => undefined,
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
        reconnect: async () => undefined,
        rewarm: async () => undefined,
        resyncDust: async () => undefined,
        restart: async () => undefined,
      },
    });
    assert.equal((await monitor.tick())?.verdict, 'degraded');
    assert.equal((await monitor.tick())?.verdict, 'wedged');
    monitor.stop();
  });
});

/* -------------------------------------------------------------------------- */
/* The submission socket                                                      */
/* -------------------------------------------------------------------------- */

/**
 * THE OUTAGE THIS LADDER IS THE ANSWER TO. On 2026/09/05 the wallet's node
 * websocket died at 14:48 UTC. At 15:28 this classifier said `degraded: the
 * wallet's sync indices have not moved in 40 min` and `chooseRemedy` answered
 * `refresh`, which re-read the wallet in 0 s and did not touch the connection.
 * From 15:30:27 until an operator restarted the unit at 20:12, EVERY submission
 * failed instantly — 520 of them — while `/status` reported `synced: true`,
 * `busy: false`, and both sponsorships `available`. Five hours in which every
 * name registration, activation grant, and mUSD mint failed, and nothing in
 * this module could see it, because the wallet is read from the INDEXER and
 * transactions go to the NODE over a different connection entirely.
 *
 * The facts are now in `HealthFacts`, so the cases below are the whole of what
 * this service concluded then and what it concludes now.
 */
describe('the verdict on a dead submission socket', () => {
  it('refuses to call a sponsor that cannot submit anything healthy', () => {
    /* Every other fact is the deployed sponsor's at 16:00 UTC: synced,
       connected, DUST in hand, able to prove, nothing in flight. The verdict
       then was `healthy`. */
    const verdict = assessHealth(healthy({ consecutiveSocketFailures: 12, nodeSocket: 'dead' }));
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.act, true);
    assert.equal(verdict.socketFault, true);
    assert.match(verdict.reason, /submission socket has failed 12 submission\(s\) in a row/);
  });

  it('holds its tongue below N, because one failure is a socket the connection retries itself', () => {
    for (let failures = 0; failures < DEFAULT_HEALTH_POLICY.socketFailuresForDegraded; failures += 1) {
      assert.equal(
        assessHealth(healthy({ consecutiveSocketFailures: failures })).verdict,
        'healthy',
        `${failures} failure(s) is not yet a fault`,
      );
    }
    assert.equal(
      assessHealth(
        healthy({ consecutiveSocketFailures: DEFAULT_HEALTH_POLICY.socketFailuresForDegraded }),
      ).verdict,
      'degraded',
    );
  });

  it('is decided ahead of the DUST branches, which can all answer on a sponsor that cannot submit', () => {
    /* A submission outage nullifies nothing and settles nothing, so the DUST
       facts go on reading exactly as they did — and any of these branches
       would happily return a verdict about coins on a service whose real fault
       is that it cannot put a transaction on chain. */
    const cases: Array<[string, Partial<HealthFacts>]> = [
      ['the DUST settle', { dustSpecks: 0n, utxoCount: 0, lastSponsorshipAt: T0 - 30_000 }],
      ['a balanced transaction outstanding', { dustSpecks: 0n, utxoCount: 0, orphans: 2 }],
      ['the start-up grace', { uptimeMs: 60_000, synced: false }],
      ['the sync-index stall', { lastStateChangeAt: T0 - 40 * MINUTE }],
    ];
    for (const [name, reading] of cases) {
      const verdict = assessHealth(healthy({ ...reading, consecutiveSocketFailures: 6 }));
      assert.equal(verdict.socketFault, true, name);
      assert.match(verdict.reason, /submission socket/, name);
    }
  });

  it('still leaves a wallet that is in use alone', () => {
    /* The one order that must not change. A remedy taken mid-spend abandons a
       proof somebody is waiting on, and this verdict is not worth that. */
    for (const inUse of [{ reserved: true }, { busy: true }]) {
      const verdict = assessHealth(healthy({ ...inUse, consecutiveSocketFailures: 20 }));
      assert.equal(verdict.verdict, 'busy');
      assert.equal(verdict.act, false);
    }
  });

  it('escalates to a restart only once the rebuilds themselves have failed M times', () => {
    const rebuildable = assessHealth(healthy({ consecutiveSocketFailures: 9 }));
    assert.equal(rebuildable.restartEligible, false, 'a fresh socket is cheaper than a chain walk');

    const hopeless = assessHealth(
      healthy({
        consecutiveSocketFailures: 9,
        consecutiveRebuildFailures: DEFAULT_HEALTH_POLICY.rebuildFailuresForRestart,
        nodeSocket: 'dead',
      }),
    );
    assert.equal(hopeless.restartEligible, true);
    assert.match(hopeless.reason, /rebuilds of it have failed too/);
  });

  it('checks the socket when the sync indices stop moving — the 15:28 verdict, corrected', () => {
    /* The exact reading of 15:28 UTC: the socket had been dead for forty
       minutes and NOTHING had been submitted since, so the failure count was
       still zero. A count alone would have missed it, which is why the socket's
       own state is read here too. */
    const verdict = assessHealth(
      healthy({ lastStateChangeAt: T0 - 40 * MINUTE, nodeSocket: 'dead' }),
    );
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.socketFault, true, 'so the remedy is a rebuild, not another wallet read');
    assert.match(verdict.reason, /indices have not moved in 40 min, and the submission socket reads dead/);
  });

  it('says so plainly when a stalled wallet’s socket is fine', () => {
    const verdict = assessHealth(healthy({ lastStateChangeAt: T0 - 40 * MINUTE }));
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.socketFault, undefined);
    assert.match(verdict.reason, /the submission socket is answering/);
    assert.equal(verdict.restartEligible, false, 'a quiet chain is still too soft to restart on');
  });
});

describe('the remedy for a dead submission socket', () => {
  it('rebuilds on the FIRST unhealthy tick rather than climbing the ladder', () => {
    /* `refresh` was tried on the deployed service and repairs nothing — it
        reads the wallet, which is a different connection. `rewarm` fetches
        proving keys, which is a different subsystem again. Every tick spent on
        either is registrations failing. */
    const facts = healthy({ consecutiveSocketFailures: 5, consecutiveUnhealthy: 0 });
    const choice = chooseRemedy(assessHealth(facts), facts, state());
    assert.equal(choice.remedy, 'reconnect');
    assert.match(choice.reason, /5 submission\(s\) have failed on the socket in a row/);
  });

  it('rebuilds even while a job is in flight, because that job’s submission is the thing failing', () => {
    /* The one remedy that is safe mid-spend, and the only one: it opens a
       socket. It abandons no proof and drops no transaction — and the job
       waiting on it is waiting on exactly this. */
    const assessment: HealthAssessment = {
      verdict: 'degraded',
      reason: 'contrived',
      act: true,
      restartEligible: false,
      socketFault: true,
    };
    for (const inUse of [{ reserved: true }, { busy: true }]) {
      const facts = healthy({ ...inUse, consecutiveSocketFailures: 5 });
      assert.equal(chooseRemedy(assessment, facts, state()).remedy, 'reconnect');
    }
  });

  it('exits the process once M rebuilds in a row have failed', () => {
    const facts = healthy({
      consecutiveSocketFailures: 9,
      consecutiveRebuildFailures: DEFAULT_HEALTH_POLICY.rebuildFailuresForRestart,
      nodeSocket: 'dead',
    });
    const choice = chooseRemedy(assessHealth(facts), facts, state());
    assert.equal(choice.remedy, 'restart');
    assert.match(choice.reason, /3 rebuilds of the submission socket have failed in a row/);
  });

  it('will not exit mid-spend, and rebuilds once more instead', () => {
    const facts = healthy({
      busy: true,
      consecutiveSocketFailures: 9,
      consecutiveRebuildFailures: 5,
      nodeSocket: 'dead',
    });
    const assessment: HealthAssessment = {
      verdict: 'degraded',
      reason: 'contrived',
      act: true,
      restartEligible: true,
      socketFault: true,
    };
    const choice = chooseRemedy(assessment, facts, state());
    assert.equal(choice.remedy, 'reconnect');
    assert.match(choice.reason, /the wallet is in use/);
  });

  it('holds a five-minute floor between two restarts asked for by the socket', () => {
    /* Five minutes and not the general thirty: M bounded rebuilds have all
       failed, so this is proved rather than inferred, and every minute of it is
       a sponsor that cannot put a transaction on chain. */
    const facts = healthy({
      consecutiveSocketFailures: 9,
      consecutiveRebuildFailures: 4,
      nodeSocket: 'dead',
    });
    const recent = state({ lastRestartRequestAt: new Date(T0 - MINUTE).toISOString() });
    assert.equal(chooseRemedy(assessHealth(facts), facts, recent).remedy, 'reconnect');

    const elapsed = state({
      lastRestartRequestAt: new Date(
        T0 - DEFAULT_REMEDY_POLICY.socketRestartCooldownMs,
      ).toISOString(),
    });
    assert.equal(chooseRemedy(assessHealth(facts), facts, elapsed).remedy, 'restart');
  });

  it('drives the whole outage through the loop, from first failure to exit', async () => {
    /* Tick by tick: the socket starts failing, the loop rebuilds it, the
       rebuilds fail too, and the process asks systemd for a new one — which is
       what an operator did by hand at 20:12, four and a half hours late. */
    const dead = (rebuildFailures: number) =>
      reading({
        nodeSocket: 'dead' as const,
        consecutiveSocketFailures: 6,
        consecutiveRebuildFailures: rebuildFailures,
        fingerprint: `f${rebuildFailures}`,
      });
    const h = harness([dead(0), dead(1), dead(3), reading({})]);

    assert.equal((await h.monitor.tick())?.verdict, 'degraded');
    assert.deepEqual(h.calls, ['reconnect'], 'no refresh-then-rewarm ladder in front of it');
    await h.monitor.tick();
    assert.deepEqual(h.calls, ['reconnect', 'reconnect']);
    await h.monitor.tick();
    assert.deepEqual(h.calls, ['reconnect', 'reconnect', 'restart']);
    assert.equal(h.record().awaitingHealthyTick, true, 'and the restart is recorded before the exit');
    assert.match(h.record().lastRestartReason ?? '', /submission socket/);

    /* And a socket that comes back is simply healthy again. */
    h.advance(MINUTE);
    assert.equal((await h.monitor.tick())?.verdict, 'healthy');
    h.monitor.stop();
  });
});

/* -------------------------------------------------------------------------- */
/* The socket's own head, against a reference it does not carry               */
/* -------------------------------------------------------------------------- */

/**
 * The reference head as the classifier sees it, HEALTHY BY DEFAULT: read this
 * instant, no failures against either observer, level with the socket's own
 * head, and nothing lagging or silent for any length of time. Every case below
 * is this minus exactly one thing.
 *
 * The default matters more here than in most of these helpers. The rule this
 * replaces fired on a well sponsor 614 times in a day, so the case that has to
 * be easiest to write — and hardest to break by accident — is the one where
 * nothing at all is wrong.
 */
const head = (overrides: Partial<ChainHeadFacts> = {}): ChainHeadFacts => ({
  nodeHeight: 342_015,
  indexerHeight: 342_015,
  referenceHead: 342_015,
  ageMs: 0,
  probeFailures: 0,
  socketLagBlocks: 0,
  socketLaggingForMs: 0,
  socketSilentForMs: 6_000,
  advancedWhileSocketSilent: 1,
  indexerBehindHeadBlocks: 0,
  indexerBehindForMs: 0,
  ...overrides,
});

/** Fifty blocks: five minutes of a six-second chain. */
const FIVE_MINUTES_OF_BLOCKS = 50;

describe('the stall verdict on the submission socket', () => {
  it('says NOTHING about a healthy idle sponsor, whatever its sync indices do', () => {
    /* THE CORRECTION OF 2026/09/06, and the first case in this file for a
       reason. The rule this replaces compared the public head against the
       WALLET'S sync indices, and on a live drill it called a perfectly well
       sponsor degraded on every tick — 614 lines in a day — because those
       indices only move on ledger activity that concerns the wallet, and a
       quiet stagenet has none for hours at a time.

       Here the wallet has been still for fifty-nine minutes and the chain has
       climbed six hundred blocks meanwhile. The socket is following it. There
       is nothing wrong, and the verdict says nothing. */
    for (const stillFor of [5, 10, 29, 59]) {
      const verdict = assessHealth(
        healthy({
          lastStateChangeAt: T0 - stillFor * MINUTE,
          socketHead: { height: 342_015, at: T0 - 6_000, subscribed: true, headers: 9_000 },
          chainHead: head(),
        }),
      );
      assert.equal(
        verdict.verdict,
        stillFor >= 30 ? 'degraded' : 'healthy',
        `at ${stillFor} min still`,
      );
      if (stillFor < 30) continue;
      /* Past half an hour the OLD indices rule speaks, as it always did, and it
         is deliberately the only thing that does. It is a different signal
         reported in different words. */
      assert.match(verdict.reason, /sync indices have not moved/);
      assert.doesNotMatch(verdict.reason, /block\(s\) behind|no block header/);
    }
  });

  it('calls a socket that has frozen behind the chain at five minutes', () => {
    /* The lag limb. The socket's own head has stopped at a height while the
       reference has run fifty blocks past it, and it has been that way for the
       whole window. Nothing about the wallet is consulted. */
    const verdict = assessHealth(
      healthy({
        socketHead: { height: 342_015, at: T0 - 5 * MINUTE, subscribed: true, headers: 9_000 },
        chainHead: head({
          nodeHeight: 342_065,
          indexerHeight: 342_065,
          referenceHead: 342_065,
          socketLagBlocks: FIVE_MINUTES_OF_BLOCKS,
          socketLaggingForMs: 5 * MINUTE,
          socketSilentForMs: 5 * MINUTE,
          advancedWhileSocketSilent: FIVE_MINUTES_OF_BLOCKS,
        }),
      }),
    );
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.act, true);
    assert.equal(verdict.socketFault, true, 'this is the connection, not the wallet');
    assert.match(verdict.reason, /submission socket is 50 block\(s\) behind a chain that has reached 342065/);
    assert.doesNotMatch(verdict.reason, /sync indices/);
  });

  it('takes the reconnect rung for it on the first tick', () => {
    /* A rebuild is one websocket, and it is what repairs this. The soft ladder
       exists to protect a possibly-transient signal from acting on a live
       sponsor; five minutes of a socket not following the chain is neither. */
    const facts = healthy({
      socketHead: { height: 342_015, at: T0 - 5 * MINUTE, subscribed: true, headers: 9_000 },
      chainHead: head({
        referenceHead: 342_065,
        socketLagBlocks: FIVE_MINUTES_OF_BLOCKS,
        socketLaggingForMs: 5 * MINUTE,
      }),
    });
    const choice = chooseRemedy(assessHealth(facts), facts, {
      lastRewarmAt: null,
      lastResyncDustAt: null,
      record: { ...EMPTY_HEALTH_RECORD },
    });
    assert.equal(choice.remedy, 'reconnect');
  });

  it('calls a subscription that has gone silent, even with no head to be behind with', () => {
    /* The silence limb, and why it is not redundant: a connection whose stream
       never opened has delivered NO header, so there is no height for the lag
       limb to compare. Five minutes of nothing while the chain produced fifty
       blocks is the same fault seen from the other side. */
    const verdict = assessHealth(
      healthy({
        socketHead: { height: null, at: null, subscribed: true, headers: 0 },
        chainHead: head({
          referenceHead: 342_065,
          socketLagBlocks: null,
          socketLaggingForMs: 0,
          socketSilentForMs: 5 * MINUTE,
          advancedWhileSocketSilent: FIVE_MINUTES_OF_BLOCKS,
        }),
      }),
    );
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.socketFault, true);
    assert.match(verdict.reason, /no block header for 5 min while the chain climbed 50 block\(s\)/);
  });

  it('says nothing at four minutes, or under forty blocks, however bad it looks', () => {
    /* Both thresholds are thresholds. A socket a moment behind is a socket, and
       a chain that has barely produced is exactly the case this must not claim
       to have diagnosed. */
    const nearlyLate = assessHealth(
      healthy({
        chainHead: head({
          socketLagBlocks: 400,
          socketLaggingForMs: 4 * MINUTE,
          socketSilentForMs: 4 * MINUTE,
          advancedWhileSocketSilent: 400,
        }),
      }),
    );
    assert.equal(nearlyLate.verdict, 'healthy');

    const barelyMoving = assessHealth(
      healthy({
        chainHead: head({
          socketLagBlocks: 39,
          socketLaggingForMs: 20 * MINUTE,
          socketSilentForMs: 20 * MINUTE,
          advancedWhileSocketSilent: 39,
        }),
      }),
    );
    assert.equal(barelyMoving.verdict, 'healthy');
  });

  it('leaves a busy wallet alone, whatever the socket is doing', () => {
    /* The asymmetry this whole module is built on: acting on a wallet somebody
       is spending from is worse than any diagnosis is worth. */
    const dead = {
      socketHead: { height: 342_015, at: T0 - 60 * MINUTE, subscribed: true, headers: 9_000 },
      chainHead: head({
        referenceHead: 348_015,
        socketLagBlocks: 6_000,
        socketLaggingForMs: 60 * MINUTE,
        socketSilentForMs: 60 * MINUTE,
        advancedWhileSocketSilent: 6_000,
      }),
    };
    assert.equal(assessHealth(healthy({ ...dead, reserved: true })).verdict, 'busy');
    assert.equal(assessHealth(healthy({ ...dead, busy: true })).verdict, 'busy');
    assert.equal(
      assessHealth(healthy({ ...dead, syncAhead: 'unshielded applied 9549 > highest 9521' }))
        .verdict,
      'settling',
    );
  });

  it('treats a connection with no subscription as unknown, never as stalled', () => {
    /* A node client that does not offer `subscribeNewHeads`, or one that
       refused it. `subscribed: false` with no header ever is NO EVIDENCE, and
       reading it as a dead socket would restart a connection that is submitting
       perfectly well. */
    const verdict = assessHealth(
      healthy({
        socketHead: { height: null, at: null, subscribed: false, headers: 0 },
        chainHead: head({
          referenceHead: 348_015,
          socketLagBlocks: null,
          socketSilentForMs: 60 * MINUTE,
          advancedWhileSocketSilent: 6_000,
        }),
      }),
    );
    assert.equal(verdict.verdict, 'healthy');
  });

  it('escalates to a restart only once rebuilding itself has failed', () => {
    const stalled = {
      socketHead: { height: 342_015, at: T0 - 5 * MINUTE, subscribed: true, headers: 9_000 },
      chainHead: head({
        referenceHead: 342_065,
        socketLagBlocks: FIVE_MINUTES_OF_BLOCKS,
        socketLaggingForMs: 5 * MINUTE,
      }),
    };
    assert.equal(assessHealth(healthy(stalled)).restartEligible, false);
    assert.equal(
      assessHealth(
        healthy({
          ...stalled,
          consecutiveRebuildFailures: DEFAULT_HEALTH_POLICY.rebuildFailuresForRestart,
        }),
      ).restartEligible,
      true,
    );
  });
});

describe('the reference head, when one observer goes blind', () => {
  it('still catches a stalled socket when the NODE probe has failed and the indexer climbs', () => {
    /* THE SECOND LIVE FINDING OF 2026/09/06. The node's addresses were
       black-holed, so the HTTPS head probe went blind at the same instant the
       socket did — and the rule that depended on it turned itself off and said
       nothing for seven and a half minutes while `/status` reported connected
       and synced. A reference that shares a host with the thing it checks is not
       a reference; the indexer is a different host answering a different
       protocol, and on its own it is enough. */
    const verdict = assessHealth(
      healthy({
        socketHead: { height: 342_015, at: T0 - 5 * MINUTE, subscribed: true, headers: 9_000 },
        chainHead: head({
          nodeHeight: null,
          probeFailures: 12,
          indexerHeight: 342_065,
          referenceHead: 342_065,
          socketLagBlocks: FIVE_MINUTES_OF_BLOCKS,
          socketLaggingForMs: 5 * MINUTE,
        }),
      }),
    );
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.socketFault, true);
    assert.match(verdict.reason, /reached 342065/);
  });

  it('concludes nothing at all when NEITHER observer answered', () => {
    /* No observation, which is not an observation of nothing. The wallet's own
       thirty-minute rule is what is left, exactly as it was before any of this
       existed. */
    const blind = {
      socketHead: { height: 342_015, at: T0 - 60 * MINUTE, subscribed: true, headers: 9_000 },
    };
    assert.equal(
      assessHealth(healthy({ ...blind, lastStateChangeAt: T0 - 10 * MINUTE })).verdict,
      'healthy',
    );
    const late = assessHealth(healthy({ ...blind, lastStateChangeAt: T0 - 40 * MINUTE }));
    assert.equal(late.verdict, 'degraded');
    assert.match(late.reason, /sync indices have not moved in 40 min/);
  });

  it('ignores a reference reading that has gone stale', () => {
    /* The node's reading is sticky across failed probes, so an old height and a
       running clock would eventually read as a chain that had stopped — a
       conclusion no probe here is entitled to. */
    const verdict = assessHealth(
      healthy({
        socketHead: { height: 342_015, at: T0 - 10 * MINUTE, subscribed: true, headers: 9_000 },
        chainHead: head({
          ageMs: DEFAULT_HEALTH_POLICY.chainHeadMaxAgeMs + 1,
          referenceHead: 342_415,
          socketLagBlocks: 400,
          socketLaggingForMs: 10 * MINUTE,
        }),
      }),
    );
    assert.equal(verdict.verdict, 'healthy');
  });

  it('behaves exactly as it did when there is no observer configured at all', () => {
    assert.equal(assessHealth(healthy({ lastStateChangeAt: T0 - 10 * MINUTE })).verdict, 'healthy');
    assert.equal(assessHealth(healthy({ lastStateChangeAt: T0 - 31 * MINUTE })).verdict, 'degraded');
  });
});

describe('an indexer that has fallen behind', () => {
  it('reports it as degraded with NO remedy', () => {
    /* The only verdict in this module that names a fault in somebody else's
       service, and the only one that acts on nothing. There is no rung that
       reaches it: a refresh re-reads the same stale answers, a reconnect
       rebuilds a socket that is fine, and a restart asks the same indexer
       again. What it buys is the diagnosis — everything this wallet knows about
       the chain it learns from the indexer. */
    const facts = healthy({
      chainHead: head({
        nodeHeight: 342_015,
        indexerHeight: 341_815,
        referenceHead: 342_015,
        indexerBehindHeadBlocks: 200,
        indexerBehindForMs: 5 * MINUTE,
      }),
    });
    const verdict = assessHealth(facts);
    assert.equal(verdict.verdict, 'degraded');
    assert.equal(verdict.act, false, 'alert-only');
    assert.equal(verdict.restartEligible, false);
    assert.equal(verdict.socketFault, undefined);
    assert.match(verdict.reason, /indexer is 200 block\(s\) behind/);
    assert.equal(
      chooseRemedy(verdict, facts, {
        lastRewarmAt: null,
        lastResyncDustAt: null,
        record: { ...EMPTY_HEALTH_RECORD },
      }).remedy,
      'none',
    );
  });

  it('holds under a hundred blocks, and under five minutes', () => {
    assert.equal(
      assessHealth(
        healthy({ chainHead: head({ indexerBehindHeadBlocks: 99, indexerBehindForMs: 60 * MINUTE }) }),
      ).verdict,
      'healthy',
    );
    assert.equal(
      assessHealth(
        healthy({
          chainHead: head({ indexerBehindHeadBlocks: 5_000, indexerBehindForMs: 4 * MINUTE }),
        }),
      ).verdict,
      'healthy',
    );
  });

  it('never masks a fault this service could actually repair', () => {
    /* It is the LAST branch, so a stalled socket and a behind indexer together
       report the socket — which is the one of the two anything can be done
       about. */
    const verdict = assessHealth(
      healthy({
        socketHead: { height: 342_015, at: T0 - 5 * MINUTE, subscribed: true, headers: 9_000 },
        chainHead: head({
          referenceHead: 342_065,
          socketLagBlocks: FIVE_MINUTES_OF_BLOCKS,
          socketLaggingForMs: 5 * MINUTE,
          indexerHeight: 341_815,
          indexerBehindHeadBlocks: 250,
          indexerBehindForMs: 30 * MINUTE,
        }),
      }),
    );
    assert.equal(verdict.socketFault, true);
    assert.match(verdict.reason, /submission socket/);
  });
});

/**
 * A head probe under the test's control: it answers whatever the script says
 * for the current clock, and reports a failure as the real one does — by
 * counting it and keeping the last good height, never by throwing.
 */
function fakeHead(now: () => number, script: { height: () => number | null }): ChainHeadProbe {
  const state: ChainHeadReading = {
    height: null,
    at: null,
    probeFailures: 0,
    probes: 0,
    failures: 0,
    lastError: null,
    urlInUse: 'https://rpc.stagenet.shielded.tools',
  };
  return {
    url: 'https://rpc.stagenet.shielded.tools',
    urls: ['https://rpc.stagenet.shielded.tools'],
    reading: () => ({ ...state }),
    read: async () => {
      state.probes += 1;
      const height = script.height();
      if (height === null) {
        state.failures += 1;
        state.probeFailures += 1;
        state.lastError = 'fetch failed';
      } else {
        state.height = height;
        state.at = now();
        state.probeFailures = 0;
        state.lastError = null;
      }
      return { ...state };
    },
  };
}

/** Ten blocks a minute from `342,015`, which is stagenet's own cadence. */
const climbingFrom = (at: number): number => 342_015 + Math.floor((at - T0) / MINUTE) * 10;

/**
 * A handle on the harness's own clock.
 *
 * `startHealthLoop` is given `now` by the harness and hands it back through
 * `makeHead`; this captures it so a case can script the indexer and the socket
 * against the SAME clock the loop is ticking on. Without it a case would be
 * scripting the chain against a clock that never moves, which is how a socket
 * that was meant to keep up appeared to freeze.
 */
function clockHandle() {
  let read: () => number = () => T0;
  return {
    at: (): number => read(),
    head: (script: (at: number) => number | null) => (now: () => number): ChainHeadProbe => {
      read = now;
      return fakeHead(now, { height: () => script(now()) });
    },
  };
}

/** A socket head frozen at a height, as a reading the harness can replay. */
const frozenSocket = (at: number) => ({
  height: 342_015,
  at,
  subscribed: true,
  headers: 9_000,
});

describe('the loop watching the socket against the chain', () => {
  it('leaves a healthy IDLE sponsor entirely alone while the chain climbs', async () => {
    /* The regression this whole change exists for. The wallet's fingerprint
       never moves — a quiet stagenet, which is most of them — and the chain
       runs an hour ahead of where it started. The socket is following it, so
       there is nothing to report, and the old rule would have reported it
       thirty times over. */
    const clock = clockHandle();
    const h = harness(
      [reading({ fingerprint: 'frozen' })],
      clock.head(climbingFrom),
      () => climbingFrom(clock.at()),
      () => ({
        height: climbingFrom(clock.at()),
        at: clock.at(),
        subscribed: true,
        headers: 9_000,
      }),
    );
    for (let minute = 0; minute < 29; minute += 1) {
      const verdict = await h.monitor.tick();
      assert.equal(verdict?.verdict, 'healthy', `fired at minute ${minute}`);
      h.advance(MINUTE);
    }
    assert.deepEqual(h.calls, [], 'not one remedy on a sponsor that is perfectly well');
    h.monitor.stop();
  });

  it('acts at five minutes on a socket the chain has left behind', async () => {
    const clock = clockHandle();
    const h = harness(
      [reading({ fingerprint: 'frozen' })],
      clock.head(climbingFrom),
      () => climbingFrom(clock.at()),
      () => frozenSocket(T0),
    );

    /* Tick one: the socket is level with the chain and nothing is wrong. */
    assert.equal((await h.monitor.tick())?.verdict, 'healthy');
    assert.deepEqual(h.calls, []);
    assert.equal(h.monitor.snapshot().socketHead?.socketHeadLagBlocks, 0);

    /* Four minutes on, forty blocks: at the block threshold, under the clock. */
    h.advance(4 * MINUTE);
    assert.equal((await h.monitor.tick())?.verdict, 'healthy');
    assert.deepEqual(h.calls, []);

    /* Five minutes. A socket frozen at a height is silent AND behind, and the
       silence limb is what reaches the window first — the lag limb's clock only
       starts once the lag itself passes forty, which here is at minute four.
       Both are the same fault; the silence is simply the earlier evidence, and
       it is the wording an operator gets. */
    h.advance(MINUTE);
    const verdict = await h.monitor.tick();
    assert.equal(verdict?.verdict, 'degraded');
    assert.match(verdict!.reason, /no block header for 5 min while the chain climbed 50 block\(s\) to 342065/);
    assert.deepEqual(h.calls, ['reconnect'], 'a rebuild, on the first tick that earns it');

    const published = h.monitor.snapshot();
    assert.equal(published.socketHead?.socketHeadLagBlocks, 50);
    assert.equal(published.socketHead?.height, 342_015);
    assert.equal(published.chainHead?.referenceHead, 342_065);
    h.monitor.stop();
  });

  it('acts on a socket still delivering headers at a height that never moves', async () => {
    /* The lag limb through the loop, and the one shape the silence limb cannot
       see: headers keep arriving — so the socket is never silent — but every
       one of them carries the same height. A node that has stopped importing
       looks exactly like this. The lag reaches forty at minute four and has to
       hold there for five more, so this is reported at minute nine. */
    const clock = clockHandle();
    const h = harness(
      [reading({ fingerprint: 'a' })],
      clock.head(climbingFrom),
      () => climbingFrom(clock.at()),
      () => ({ height: 342_015, at: clock.at(), subscribed: true, headers: 9_000 }),
    );
    assert.equal((await h.monitor.tick())?.verdict, 'healthy');
    h.advance(4 * MINUTE);
    assert.equal((await h.monitor.tick())?.verdict, 'healthy', 'forty behind, but only just');
    h.advance(4 * MINUTE);
    assert.equal((await h.monitor.tick())?.verdict, 'healthy', 'behind, but not yet for long');
    h.advance(MINUTE);
    const verdict = await h.monitor.tick();
    assert.equal(verdict?.verdict, 'degraded');
    assert.match(verdict!.reason, /submission socket is 90 block\(s\) behind a chain that has reached 342105/);
    assert.deepEqual(h.calls, ['reconnect']);
    assert.equal(h.monitor.snapshot().socketHead?.socketHeadLagBlocks, 90);
    h.monitor.stop();
  });

  it('acts on a subscription that has simply gone silent', async () => {
    /* No header since the connection was built, and fifty blocks produced
       meanwhile. There is no height to be behind with, so only the silence limb
       can see this. */
    const clock = clockHandle();
    const h = harness(
      [reading({ fingerprint: 'frozen' })],
      clock.head(climbingFrom),
      () => climbingFrom(clock.at()),
      () => ({ height: null, at: null, subscribed: true, headers: 0 }),
    );
    assert.equal((await h.monitor.tick())?.verdict, 'healthy');
    h.advance(5 * MINUTE);
    const verdict = await h.monitor.tick();
    assert.equal(verdict?.verdict, 'degraded');
    assert.match(verdict!.reason, /no block header for 5 min while the chain climbed 50 block\(s\)/);
    assert.deepEqual(h.calls, ['reconnect']);
    h.monitor.stop();
  });

  it('still catches it with the node probe failing, on the indexer alone', async () => {
    /* The black-holed node of 2026/09/06: the HTTPS probe goes blind at the
       same instant the socket does, and without a second observer the rule
       would turn itself off for exactly as long as the fault lasted. */
    const clock = clockHandle();
    const h = harness(
      [reading({ fingerprint: 'frozen' })],
      clock.head(() => null),
      () => climbingFrom(clock.at()),
      () => frozenSocket(T0),
    );
    assert.equal((await h.monitor.tick())?.verdict, 'healthy');
    h.advance(5 * MINUTE);
    const verdict = await h.monitor.tick();
    assert.equal(verdict?.verdict, 'degraded');
    assert.match(verdict!.reason, /no block header for 5 min while the chain climbed 50 block\(s\)/);
    assert.deepEqual(h.calls, ['reconnect']);

    const published = h.monitor.snapshot();
    assert.equal(published.chainHeadProbe, 'ok', 'two failures is not ten');
    assert.equal(published.chainHead?.height, null, 'the node never answered');
    assert.equal(published.chainHead?.indexerHead, 342_065);
    assert.equal(published.chainHead?.referenceHead, 342_065);
    h.monitor.stop();
  });

  it('concludes nothing when BOTH observers are blind', async () => {
    const clock = clockHandle();
    const h = harness(
      [reading({ fingerprint: 'frozen' })],
      clock.head(() => null),
      () => null,
      () => frozenSocket(T0),
    );
    for (let minute = 0; minute < 10; minute += 1) {
      assert.equal((await h.monitor.tick())?.verdict, 'healthy', `fired at minute ${minute}`);
      h.advance(MINUTE);
    }
    assert.deepEqual(h.calls, [], 'losing both observers is not evidence about this socket');
    assert.equal(h.monitor.snapshot().socketHead?.socketHeadLagBlocks, null);
    h.monitor.stop();
  });

  it('reports an indexer that has fallen behind, and does nothing about it', async () => {
    /* The node climbs; the indexer stopped 200 blocks ago. Everything else is
       well, so this is the branch that speaks — and it is the branch with no
       remedy. */
    const clock = clockHandle();
    const h = harness(
      [reading({ fingerprint: 'a' })],
      clock.head(climbingFrom),
      () => 341_815,
      () => ({
        height: climbingFrom(clock.at()),
        at: clock.at(),
        subscribed: true,
        headers: 9_000,
      }),
    );
    assert.equal((await h.monitor.tick())?.verdict, 'healthy', 'two hundred behind, but only just');
    h.advance(5 * MINUTE);
    const verdict = await h.monitor.tick();
    assert.equal(verdict?.verdict, 'degraded');
    assert.equal(verdict?.act, false);
    assert.match(verdict!.reason, /indexer is 250 block\(s\) behind/);
    assert.deepEqual(h.calls, [], 'there is no rung that reaches somebody else’s server');
    assert.equal(h.monitor.snapshot().chainHead?.indexerBehindHeadBlocks, 250);
    /* And it does not build a streak, so it can never hurry a later, genuine
       fault towards a restart. */
    assert.equal(h.monitor.snapshot().consecutiveUnhealthy, 0);
    h.monitor.stop();
  });

  it('publishes a failing node probe and does nothing whatever about it', async () => {
    const clock = clockHandle();
    const h = harness(
      [reading({ fingerprint: 'a' })],
      clock.head(() => null),
      () => climbingFrom(clock.at()),
      () => ({
        height: climbingFrom(clock.at()),
        at: clock.at(),
        subscribed: true,
        headers: 9_000,
      }),
    );
    for (let n = 0; n < 10; n += 1) {
      assert.equal((await h.monitor.tick())?.verdict, 'healthy');
      h.advance(MINUTE);
    }
    const published = h.monitor.snapshot();
    assert.equal(published.chainHeadProbe, 'failing');
    assert.equal(published.chainHead?.probeFailures, 10);
    assert.equal(published.chainHead?.height, null);
    assert.equal(published.chainHead?.lastError, 'fetch failed');
    assert.deepEqual(h.calls, [], 'a public node that will not answer is not a fault in this wallet');
    h.monitor.stop();
  });

  it('publishes nothing about a chain it was given no observer for', async () => {
    const h = harness([reading({})]);
    await h.monitor.tick();
    assert.equal(h.monitor.snapshot().chainHead, null);
    assert.equal(h.monitor.snapshot().chainHeadProbe, 'off');
    assert.equal(
      h.monitor.snapshot().socketHead?.socketHeadLagBlocks,
      null,
      'the socket is still published; there is simply nothing to compare it with',
    );
    h.monitor.stop();
  });
});
