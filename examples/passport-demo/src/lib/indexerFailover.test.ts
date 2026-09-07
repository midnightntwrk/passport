/**
 * Drills for the second indexer: which one a wallet opens on, and when the one
 * it opened on has stopped serving it.
 *
 * The indexer is the endpoint that cannot be chosen per request. `WalletFacade
 * .init` takes one connection and holds it, so there are exactly two moments
 * worth a rule — the choice made before the facade exists, and the judgement
 * that the choice has gone bad — and both of them are here, with the probe and
 * the clock injected so neither needs a network.
 *
 * The stall rule is the half most easily got wrong, and the shape of the
 * mistake is specific: a wallet that has caught up emits NOTHING while the
 * chain is quiet, because `subscribeSyncProgress` publishes only when the
 * answer changes. A watch that counted down against silence would rebuild a
 * perfectly healthy wallet every ninety seconds. So "synced and connected" is
 * re-affirmed by the tick rather than timed out, and that is drilled first.
 *
 * Run from the workspace root: `npx vitest run examples/passport-demo/src/lib`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  INDEXER_STALL_MS,
  INDEXER_STALL_TICK_MS,
  firstIndexerThatAnswers,
  indexerEndpointList,
  indexerWsFrom,
  indexersAfter,
  watchIndexerStall,
  type IndexerEndpoint,
  type IndexerSyncHealth,
} from './indexerFailover.js';

const PRIMARY = 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const STANDBY = 'https://indexer-2.stagenet.example/api/v4/graphql';

describe('indexerWsFrom', () => {
  it('appends /ws and upgrades the scheme', () => {
    expect(indexerWsFrom(PRIMARY)).toBe(
      'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws',
    );
    expect(indexerWsFrom('http://localhost:8088/api/v4/graphql/')).toBe(
      'ws://localhost:8088/api/v4/graphql/ws',
    );
  });
});

describe('indexerEndpointList', () => {
  it('reads one URL as a list of one, with its websocket derived', () => {
    /* THE compatibility property: every deployment writes one URL today and
       must go on behaving exactly as it did. */
    expect(indexerEndpointList(PRIMARY)).toEqual([
      { httpUrl: PRIMARY, wsUrl: indexerWsFrom(PRIMARY) },
    ]);
  });

  it('reads several in the operator’s order, websockets following position by position', () => {
    expect(indexerEndpointList(`${PRIMARY}, ${STANDBY}`)).toEqual([
      { httpUrl: PRIMARY, wsUrl: indexerWsFrom(PRIMARY) },
      { httpUrl: STANDBY, wsUrl: indexerWsFrom(STANDBY) },
    ]);
  });

  it('lets an override cover the endpoints it reaches and derives the rest', () => {
    /* The usual shape of a second indexer arriving: `VITE_INDEXER_WS_URL` was
       already set for the primary and nobody remembers to extend it. The
       standby derives its own rather than borrowing the primary's, which would
       query one host and subscribe to another. */
    const endpoints = indexerEndpointList(
      `${PRIMARY},${STANDBY}`,
      'wss://ws.stagenet.example/graphql/ws',
    );
    expect(endpoints).toEqual([
      { httpUrl: PRIMARY, wsUrl: 'wss://ws.stagenet.example/graphql/ws' },
      { httpUrl: STANDBY, wsUrl: indexerWsFrom(STANDBY) },
    ]);
  });

  it('reads an unset variable as no indexers at all', () => {
    expect(indexerEndpointList(undefined)).toEqual([]);
    expect(indexerEndpointList('  ')).toEqual([]);
  });
});

describe('indexersAfter', () => {
  const endpoints = indexerEndpointList(`${PRIMARY},${STANDBY}`);

  it('rotates so the next endpoint leads and the current one comes last', () => {
    /* A rotation rather than a truncation: the primary coming back is the
       expected end of an outage, and it should be reachable on the rebuild
       after next rather than after a redeploy. */
    expect(indexersAfter(endpoints, PRIMARY)?.map((e) => e.httpUrl)).toEqual([STANDBY, PRIMARY]);
    expect(indexersAfter(endpoints, STANDBY)?.map((e) => e.httpUrl)).toEqual([PRIMARY, STANDBY]);
  });

  it('has nowhere to go with one indexer, or with a URL it does not know', () => {
    expect(indexersAfter(indexerEndpointList(PRIMARY), PRIMARY)).toBeNull();
    expect(indexersAfter(endpoints, 'https://somewhere.else/graphql')).toBeNull();
  });
});

describe('firstIndexerThatAnswers', () => {
  const endpoints = indexerEndpointList(`${PRIMARY},${STANDBY}`);

  it('opens on the first that answers, asking nobody else, and logging nothing', async () => {
    const probed: string[] = [];
    const log = vi.fn();
    const chosen = await firstIndexerThatAnswers(
      endpoints,
      async (url) => {
        probed.push(url);
        return true;
      },
      log,
    );
    expect(probed).toEqual([PRIMARY]);
    expect(chosen).toEqual({ index: 0, endpoint: endpoints[0] });
    expect(log).not.toHaveBeenCalled();
  });

  it('falls through to the standby and names the index it landed on', async () => {
    const log = vi.fn();
    const chosen = await firstIndexerThatAnswers(
      endpoints,
      async (url) => url !== PRIMARY,
      log,
    );
    expect(chosen).toEqual({ index: 1, endpoint: endpoints[1] });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('[indexer] opened on endpoint 1');
    expect(log.mock.calls[0]?.[0]).toContain(STANDBY);
  });

  it('reads a probe that throws as an indexer that did not answer', async () => {
    const chosen = await firstIndexerThatAnswers(
      endpoints,
      async (url) => {
        if (url === PRIMARY) throw new Error('Failed to fetch');
        return true;
      },
      vi.fn(),
    );
    expect(chosen?.index).toBe(1);
  });

  it('answers null when nothing answered, so the caller can open anyway', async () => {
    /* A probe is a PREFERENCE between endpoints, never a gate: a probe that is
       wrong about a healthy indexer must not be the reason a Passport will not
       open. */
    expect(await firstIndexerThatAnswers(endpoints, async () => false, vi.fn())).toBeNull();
    expect(await firstIndexerThatAnswers([], async () => true, vi.fn())).toBeNull();
  });

  it('logs through console.info when no logger is given', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await firstIndexerThatAnswers(endpoints, async (url) => url !== PRIMARY);
      expect(info).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
    }
  });
});

describe('watchIndexerStall', () => {
  /** A hand-driven clock and interval, so a stall is reached without waiting. */
  function harness() {
    let clock = 0;
    let tick: (() => void) | null = null;
    let cleared = 0;
    const onStalled = vi.fn();
    const watch = watchIndexerStall({
      onStalled,
      stallMs: 90_000,
      tickMs: 15_000,
      now: () => clock,
      setTimer: (run) => {
        tick = run;
        return 'timer';
      },
      clearTimer: (handle) => {
        expect(handle).toBe('timer');
        cleared += 1;
      },
    });
    return {
      watch,
      onStalled,
      advance(ms: number) {
        clock += ms;
        tick?.();
      },
      get cleared() {
        return cleared;
      },
    };
  }

  const health = (over: Partial<IndexerSyncHealth> = {}): IndexerSyncHealth => ({
    percent: 100,
    synced: true,
    connected: true,
    ...over,
  });

  it('never stalls a synced wallet that has gone quiet', async () => {
    /* THE BUG THIS SHAPE EXISTS TO AVOID. A caught-up Passport left open on a
       desk emits nothing at all, and a watch that timed out on emissions would
       rebuild it — and every wallet after it — every ninety seconds. */
    const h = harness();
    h.watch.observe(health());
    for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 15_000) h.advance(15_000);
    expect(h.onStalled).not.toHaveBeenCalled();
  });

  it('never stalls a chain walk that is still advancing', async () => {
    const h = harness();
    for (let percent = 1; percent <= 40; percent += 1) {
      h.watch.observe(health({ percent, synced: false }));
      h.advance(15_000);
    }
    expect(h.onStalled).not.toHaveBeenCalled();
  });

  it('stalls a walk whose percentage has not moved for the window', async () => {
    const h = harness();
    h.watch.observe(health({ percent: 43, synced: false }));
    h.advance(45_000);
    // Same reading again: an emission is not progress.
    h.watch.observe(health({ percent: 43, synced: false }));
    expect(h.onStalled).not.toHaveBeenCalled();
    h.advance(45_000);
    expect(h.onStalled).toHaveBeenCalledTimes(1);
    expect(h.onStalled.mock.calls[0]?.[0]).toMatchObject({ percent: 43, synced: false });
  });

  it('stalls a connection that has dropped, synced or not', async () => {
    const h = harness();
    h.watch.observe(health({ connected: false }));
    h.advance(45_000);
    expect(h.onStalled).not.toHaveBeenCalled();
    h.advance(45_000);
    expect(h.onStalled).toHaveBeenCalledTimes(1);
  });

  it('stalls a wallet that never reported anything at all', async () => {
    /* A facade that connected to nothing publishes no reading, and a Passport
       sitting at "opening" for ever is exactly the outage a standby exists
       for. */
    const h = harness();
    h.advance(90_000);
    expect(h.onStalled).toHaveBeenCalledWith(null);
  });

  it('fires once, then stops watching and ignores everything after', async () => {
    const h = harness();
    h.watch.observe(health({ connected: false }));
    h.advance(90_000);
    expect(h.onStalled).toHaveBeenCalledTimes(1);
    expect(h.cleared).toBe(1);
    h.watch.observe(health({ connected: false }));
    h.advance(90_000);
    expect(h.onStalled).toHaveBeenCalledTimes(1);
    // Stopping an already-stopped watch is not an error and clears nothing twice.
    h.watch.stop();
    expect(h.cleared).toBe(1);
  });

  it('runs on real timers and a real clock when none are injected', async () => {
    vi.useFakeTimers();
    try {
      const onStalled = vi.fn();
      const watch = watchIndexerStall({ onStalled, tickMs: 1_000, stallMs: 5_000 });
      watch.observe({ percent: 12, synced: false, connected: false });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(onStalled).toHaveBeenCalledTimes(1);
      watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the shipped window and tick when neither is given', async () => {
    /* The values a Passport actually runs on. Every drill above names its own
       so a stall is reached without waiting; this one names none, so the
       defaults are the thing under test — a watch that silently shipped a
       zero tick would spin, and one that shipped no window would never fire. */
    vi.useFakeTimers();
    try {
      const onStalled = vi.fn();
      const watch = watchIndexerStall({ onStalled });
      watch.observe({ percent: 12, synced: false, connected: false });
      await vi.advanceTimersByTimeAsync(INDEXER_STALL_MS - INDEXER_STALL_TICK_MS);
      expect(onStalled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2 * INDEXER_STALL_TICK_MS);
      expect(onStalled).toHaveBeenCalledTimes(1);
      watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a stall window longer than any flat stretch a walk really has', () => {
    // Documented rather than asserted-on elsewhere: ninety seconds, and shorter
    // than the ten minutes an activation grant is given to land.
    expect(INDEXER_STALL_MS).toBe(90_000);
    expect(INDEXER_STALL_MS).toBeLessThan(10 * 60_000);
  });
});

describe('an endpoint list is a list of one until somebody adds to it', () => {
  it('keeps a single-indexer build on exactly the behaviour it has', async () => {
    const endpoints: IndexerEndpoint[] = indexerEndpointList(PRIMARY);
    expect(endpoints).toHaveLength(1);
    expect(indexersAfter(endpoints, PRIMARY)).toBeNull();
    const probe = vi.fn(async () => true);
    expect((await firstIndexerThatAnswers(endpoints, probe, vi.fn()))?.index).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
