/**
 * The warm cache, held to the four rules that make reusing an answer safe.
 *
 * Every probe here is a counter and a fake clock, because the whole point of
 * the module is that it decides WHETHER to probe — so what has to be asserted
 * is the number of probes and the answer each caller got, never a network.
 */

import { describe, expect, it } from 'vitest';

import { CLAIM_WARMUP_TTL_MS, createClaimWarmup } from './claimWarmup.js';

type Availability = { status: 'available' } | { status: 'taken' } | { status: 'unreachable' };

/** A clock the test moves by hand, so the TTL is exercised rather than waited on. */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

interface Harness {
  warmup: ReturnType<typeof createClaimWarmup<Availability>>;
  clock: ReturnType<typeof fakeClock>;
  availabilityCalls: Array<{ network: string; alias: string }>;
  sponsorshipCalls: string[];
  /** What the next availability probe answers. */
  setAvailability(next: Availability | (() => Promise<Availability>)): void;
  /** What the next sponsorship probe answers. */
  setSponsored(next: boolean): void;
}

function harness(): Harness {
  const clock = fakeClock();
  const availabilityCalls: Array<{ network: string; alias: string }> = [];
  const sponsorshipCalls: string[] = [];
  let availability: Availability | (() => Promise<Availability>) = { status: 'available' };
  let sponsored = true;
  const warmup = createClaimWarmup<Availability>(
    {
      availability: async (network, alias) => {
        availabilityCalls.push({ network, alias });
        return typeof availability === 'function' ? availability() : availability;
      },
      sponsorship: async (network) => {
        sponsorshipCalls.push(network);
        return sponsored;
      },
      /* The app's own rule: an unreachable registry is a non-answer, so it is
         never kept. `taken` IS an answer and is kept — it can only refuse. */
      trustworthy: (answer) => answer.status !== 'unreachable',
    },
    { now: clock.now },
  );
  return {
    warmup,
    clock,
    availabilityCalls,
    sponsorshipCalls,
    setAvailability: (next) => { availability = next; },
    setSponsored: (next) => { sponsored = next; },
  };
}

describe('createClaimWarmup', () => {
  it('probes once for a name and network, and reuses that answer', async () => {
    const h = harness();
    h.warmup.warm('stagenet', 'alice');
    const first = await h.warmup.answers('stagenet', 'alice').availability;
    const second = await h.warmup.answers('stagenet', 'alice').availability;

    expect(first).toEqual({ status: 'available' });
    expect(second).toEqual({ status: 'available' });
    expect(h.availabilityCalls).toHaveLength(1);
    expect(h.sponsorshipCalls).toEqual(['stagenet']);
  });

  it('hands a claim the probe that is still in flight rather than starting a second', async () => {
    const h = harness();
    let release: (answer: Availability) => void = () => undefined;
    h.setAvailability(() => new Promise<Availability>((resolve) => { release = resolve; }));

    h.warmup.warm('stagenet', 'alice');
    // The claim arrives while the warm probe is still out.
    const claim = h.warmup.answers('stagenet', 'alice').availability;
    release({ status: 'available' });

    await expect(claim).resolves.toEqual({ status: 'available' });
    expect(h.availabilityCalls).toHaveLength(1);
  });

  it('never lets one name reuse another name\'s answer', async () => {
    const h = harness();
    await h.warmup.answers('stagenet', 'alice').availability;
    h.setAvailability({ status: 'taken' });
    const other = await h.warmup.answers('stagenet', 'alicia').availability;

    expect(other).toEqual({ status: 'taken' });
    expect(h.availabilityCalls).toEqual([
      { network: 'stagenet', alias: 'alice' },
      { network: 'stagenet', alias: 'alicia' },
    ]);
  });

  it('never lets one network reuse another network\'s answer', async () => {
    const h = harness();
    await h.warmup.answers('stagenet', 'alice').availability;
    h.setAvailability({ status: 'taken' });
    const other = await h.warmup.answers('preview', 'alice').availability;

    expect(other).toEqual({ status: 'taken' });
    expect(h.availabilityCalls).toHaveLength(2);
    expect(h.sponsorshipCalls).toEqual(['stagenet', 'preview']);
  });

  it('re-probes once the answer is older than the TTL, and a name taken since does not slip through', async () => {
    const h = harness();
    await h.warmup.answers('stagenet', 'alice').availability;
    expect(h.availabilityCalls).toHaveLength(1);

    // Still inside the window: the same answer, no second probe.
    h.clock.advance(CLAIM_WARMUP_TTL_MS);
    await h.warmup.answers('stagenet', 'alice').availability;
    expect(h.availabilityCalls).toHaveLength(1);

    // Past it: somebody registered the name in the meantime, and the claim
    // must be told so rather than handed the stale 'available'.
    h.clock.advance(1);
    h.setAvailability({ status: 'taken' });
    await expect(h.warmup.answers('stagenet', 'alice').availability).resolves.toEqual({
      status: 'taken',
    });
    expect(h.availabilityCalls).toHaveLength(2);
  });

  it('caches a refusal as a refusal — never as an approval', async () => {
    const h = harness();
    h.setAvailability({ status: 'taken' });
    h.setSponsored(false);

    h.warmup.warm('stagenet', 'alice');
    const answers = h.warmup.answers('stagenet', 'alice');
    await expect(answers.availability).resolves.toEqual({ status: 'taken' });
    await expect(answers.sponsored).resolves.toBe(false);

    // And the reused answer is the same refusal, not a fresh optimistic one.
    h.setAvailability({ status: 'available' });
    h.setSponsored(true);
    const again = h.warmup.answers('stagenet', 'alice');
    await expect(again.availability).resolves.toEqual({ status: 'taken' });
    await expect(again.sponsored).resolves.toBe(false);
    expect(h.availabilityCalls).toHaveLength(1);
  });

  it('does not cache a non-answer: an unreachable registry is re-probed at once', async () => {
    const h = harness();
    h.setAvailability({ status: 'unreachable' });
    await expect(h.warmup.answers('stagenet', 'alice').availability).resolves.toEqual({
      status: 'unreachable',
    });

    h.setAvailability({ status: 'available' });
    await expect(h.warmup.answers('stagenet', 'alice').availability).resolves.toEqual({
      status: 'available',
    });
    expect(h.availabilityCalls).toHaveLength(2);
  });

  it('does not cache a rejected probe, and a warm probe never rejects unhandled', async () => {
    const h = harness();
    h.setAvailability(() => Promise.reject(new Error('indexer down')));
    // `warm` swallows the rejection; nothing is awaiting it yet.
    h.warmup.warm('stagenet', 'alice');
    await expect(h.warmup.answers('stagenet', 'alice').availability).rejects.toThrow('indexer down');

    h.setAvailability({ status: 'available' });
    await expect(h.warmup.answers('stagenet', 'alice').availability).resolves.toEqual({
      status: 'available',
    });
    /* Two: the warm probe (which the claim joined while it was still out, and
       whose rejection it therefore saw), and the re-probe after it spoiled. */
    expect(h.availabilityCalls).toHaveLength(2);
  });

  it('ages the two halves independently', async () => {
    const h = harness();
    const first = h.warmup.answers('stagenet', 'alice');
    await Promise.all([first.availability, first.sponsored]);
    expect(h.sponsorshipCalls).toHaveLength(1);

    h.clock.advance(CLAIM_WARMUP_TTL_MS + 1);
    const second = h.warmup.answers('stagenet', 'alice');
    await Promise.all([second.availability, second.sponsored]);
    // Both expired together here, which is the ordinary case.
    expect(h.availabilityCalls).toHaveLength(2);
    expect(h.sponsorshipCalls).toHaveLength(2);
  });

  it('honours an explicit TTL', async () => {
    const clock = fakeClock();
    let calls = 0;
    const warmup = createClaimWarmup<Availability>(
      {
        availability: async () => { calls += 1; return { status: 'available' }; },
        sponsorship: async () => true,
        trustworthy: () => true,
      },
      { now: clock.now, ttlMs: 1 },
    );
    await warmup.answers('stagenet', 'alice').availability;
    clock.advance(2);
    await warmup.answers('stagenet', 'alice').availability;
    expect(calls).toBe(2);
  });

  it('defaults to the real clock when none is injected', async () => {
    let calls = 0;
    const warmup = createClaimWarmup<Availability>({
      availability: async () => { calls += 1; return { status: 'available' }; },
      sponsorship: async () => true,
      trustworthy: () => true,
    });
    await warmup.answers('stagenet', 'alice').availability;
    await warmup.answers('stagenet', 'alice').availability;
    expect(calls).toBe(1);
  });

  it('forgets everything on demand', async () => {
    const h = harness();
    await h.warmup.answers('stagenet', 'alice').availability;
    h.warmup.forget();
    await h.warmup.answers('stagenet', 'alice').availability;
    expect(h.availabilityCalls).toHaveLength(2);
  });
});
