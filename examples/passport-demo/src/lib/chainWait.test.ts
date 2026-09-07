/**
 * The bound on every wait Passport makes on the chain.
 *
 * The defect is in `./chainWait.ts`'s header: a reviewer left on "Setting up
 * your account…" for ever because a polkadot-js subscription that had lost its
 * socket was never going to speak again, and nothing above it had a deadline.
 * Every case below is a way that wait can end — and, as importantly, a way it
 * must NOT end: a refusal has to keep travelling, and an abandoned wait must
 * not turn into an unhandled rejection in a tab that has moved on.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connectionWatchFor,
  deviceConnectionWatch,
  pollUntilTrue,
  providerConnectionWatch,
  transactionIdentifierOf,
  waitBounded,
  SETTLE_WATCH_MS,
  SUBMIT_WAIT_MS,
} from './chainWait.js';

/* -------------------------------------------------------------------------- */
/* Connection watches                                                         */
/* -------------------------------------------------------------------------- */

/** A polkadot-js-shaped provider whose connection can be taken away. */
function fakeProvider(connected = true) {
  const handlers = new Map<string, Set<() => void>>();
  return {
    isConnected: connected,
    on(event: string, handler: () => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event: string, handler: () => void) {
      handlers.get(event)?.delete(handler);
    },
    listenerCount: (event: string) => handlers.get(event)?.size ?? 0,
    drop: () => {
      for (const handler of handlers.get('disconnected') ?? []) handler();
    },
  };
}

/** A `window`-shaped device whose radio can be taken away. */
function fakeDevice(online = true) {
  const handlers = new Map<string, Set<() => void>>();
  return {
    navigator: { onLine: online },
    addEventListener(event: string, handler: () => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    removeEventListener(event: string, handler: () => void) {
      handlers.get(event)?.delete(handler);
    },
    listenerCount: (event: string) => handlers.get(event)?.size ?? 0,
    goOffline: () => {
      for (const handler of handlers.get('offline') ?? []) handler();
    },
  };
}

describe('providerConnectionWatch', () => {
  it('answers for anything that presents a polkadot-js provider', () => {
    const provider = fakeProvider();
    const watch = providerConnectionWatch(provider)!;
    expect(watch.isDown()).toBe(false);
    provider.isConnected = false;
    expect(watch.isDown()).toBe(true);
  });

  it('calls back when the connection drops, and unregisters on request', () => {
    const provider = fakeProvider();
    const watch = providerConnectionWatch(provider)!;
    const reasons: string[] = [];
    const stop = watch.onDown((reason) => reasons.push(reason));
    expect(provider.listenerCount('disconnected')).toBe(1);
    provider.drop();
    expect(reasons).toEqual(['the connection to Midnight dropped']);
    stop();
    expect(provider.listenerCount('disconnected')).toBe(0);
  });

  it('refuses everything that is not one, rather than half-watching it', () => {
    expect(providerConnectionWatch(null)).toBeNull();
    expect(providerConnectionWatch('a provider')).toBeNull();
    // No `isConnected` to read.
    expect(providerConnectionWatch({ on: () => {}, off: () => {} })).toBeNull();
    // `isConnected` but nothing to listen to.
    expect(providerConnectionWatch({ isConnected: true })).toBeNull();
    expect(providerConnectionWatch({ isConnected: true, on: () => {} })).toBeNull();
  });
});

describe('deviceConnectionWatch', () => {
  it('reads the device’s own radio, and hears it go', () => {
    const device = fakeDevice();
    const watch = deviceConnectionWatch(device)!;
    expect(watch.isDown()).toBe(false);
    const reasons: string[] = [];
    const stop = watch.onDown((reason) => reasons.push(reason));
    device.navigator.onLine = false;
    device.goOffline();
    expect(watch.isDown()).toBe(true);
    expect(reasons).toEqual(['this device lost its network connection']);
    stop();
    expect(device.listenerCount('offline')).toBe(0);
  });

  it('refuses everything that cannot answer', () => {
    expect(deviceConnectionWatch(null)).toBeNull();
    expect(deviceConnectionWatch(42)).toBeNull();
    expect(deviceConnectionWatch({ navigator: { onLine: true } })).toBeNull();
    expect(
      deviceConnectionWatch({ addEventListener: () => {}, navigator: { onLine: true } }),
    ).toBeNull();
    // A host with listeners but no radio to read — node, for instance.
    expect(
      deviceConnectionWatch({ addEventListener: () => {}, removeEventListener: () => {} }),
    ).toBeNull();
  });
});

describe('connectionWatchFor', () => {
  it('prefers the node’s own provider over the device', () => {
    const provider = fakeProvider();
    const device = fakeDevice();
    const watch = connectionWatchFor([null, {}, provider], device)!;
    provider.isConnected = false;
    expect(watch.isDown()).toBe(true);
  });

  it('falls back to the device when no candidate is a provider', () => {
    const device = fakeDevice(false);
    expect(connectionWatchFor([null, 'nope'], device)!.isDown()).toBe(true);
  });

  it('answers null when nothing can say — a wait bounded by time alone', () => {
    expect(connectionWatchFor([], null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The bounded wait                                                           */
/* -------------------------------------------------------------------------- */

describe('waitBounded', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers with the value when the work answers first', async () => {
    const outcome = await waitBounded(Promise.resolve('landed'), { deadlineMs: 1_000 });
    expect(outcome).toEqual({ via: 'answer', value: 'landed' });
  });

  it('lets a refusal travel, unchanged', async () => {
    const cause = new Error('the node refused it');
    await expect(waitBounded(Promise.reject(cause), { deadlineMs: 1_000 })).rejects.toBe(cause);
  });

  it('gives up at the deadline, saying how long it waited', async () => {
    vi.useFakeTimers();
    const outcome = waitBounded(new Promise(() => {}), { deadlineMs: SUBMIT_WAIT_MS });
    await vi.advanceTimersByTimeAsync(SUBMIT_WAIT_MS);
    expect(await outcome).toEqual({ via: 'deadline', reason: 'nothing answered within 60s' });
  });

  it('stops the moment the connection carrying it goes away', async () => {
    const provider = fakeProvider();
    const outcome = waitBounded(new Promise(() => {}), {
      deadlineMs: SETTLE_WATCH_MS,
      watch: providerConnectionWatch(provider),
    });
    provider.drop();
    expect(await outcome).toEqual({
      via: 'disconnected',
      reason: 'the connection to Midnight dropped',
    });
    // The listener is taken back off: an abandoned wait leaves nothing behind.
    expect(provider.listenerCount('disconnected')).toBe(0);
  });

  it('does not even start waiting on a connection that is already down', async () => {
    const provider = fakeProvider(false);
    const outcome = await waitBounded(new Promise(() => {}), {
      deadlineMs: SETTLE_WATCH_MS,
      watch: providerConnectionWatch(provider),
    });
    expect(outcome).toEqual({ via: 'disconnected', reason: 'the connection was already down' });
    expect(provider.listenerCount('disconnected')).toBe(0);
  });

  it('clears its timer once the work answers, so nothing fires afterwards', async () => {
    vi.useFakeTimers();
    const outcome = await waitBounded(Promise.resolve(1), { deadlineMs: 5_000 });
    expect(outcome).toEqual({ via: 'answer', value: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles a rejection that arrives after the wait was abandoned', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    let refuse: (cause: unknown) => void = () => {};
    const work = new Promise<never>((_resolve, reject) => {
      refuse = reject;
    });
    const outcome = waitBounded(work, { deadlineMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toEqual({ via: 'deadline', reason: 'nothing answered within 1s' });
    refuse(new Error('the node answered a minute late, and refused'));
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Asking instead of listening                                                */
/* -------------------------------------------------------------------------- */

describe('pollUntilTrue', () => {
  /** A hand-wound clock, so a two-minute window costs no time to drill. */
  function handWound() {
    let clock = 0;
    return {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      elapsed: () => clock,
    };
  }

  it('answers as soon as the read says yes, without sleeping first', async () => {
    const timing = handWound();
    const read = vi.fn(async () => true);
    expect(await pollUntilTrue(read, { windowMs: 60_000, intervalMs: 5_000, ...timing })).toBe(
      true,
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(timing.elapsed()).toBe(0);
  });

  it('keeps asking until it does, and counts the window down as it goes', async () => {
    const timing = handWound();
    let asked = 0;
    const answer = async () => {
      asked += 1;
      return asked === 3;
    };
    expect(await pollUntilTrue(answer, { windowMs: 60_000, intervalMs: 5_000, ...timing })).toBe(
      true,
    );
    expect(asked).toBe(3);
    expect(timing.elapsed()).toBe(10_000);
  });

  it('counts a read that threw as a no rather than abandoning the window', async () => {
    const timing = handWound();
    let asked = 0;
    const answer = async () => {
      asked += 1;
      if (asked === 1) throw new Error('the indexer could not be reached');
      return true;
    };
    expect(await pollUntilTrue(answer, { windowMs: 30_000, intervalMs: 5_000, ...timing })).toBe(
      true,
    );
    expect(asked).toBe(2);
  });

  it('closes the window without a yes, and never sleeps past it', async () => {
    const timing = handWound();
    const read = vi.fn(async () => false);
    expect(await pollUntilTrue(read, { windowMs: 12_000, intervalMs: 5_000, ...timing })).toBe(
      false,
    );
    // 0s, 5s, 10s — and no fourth, because 15s is past the window.
    expect(read).toHaveBeenCalledTimes(3);
    expect(timing.elapsed()).toBe(10_000);
  });

  it('asks exactly once when there is no window at all', async () => {
    const timing = handWound();
    const read = vi.fn(async () => false);
    expect(await pollUntilTrue(read, { windowMs: 0, intervalMs: 5_000, ...timing })).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('uses a real clock and a real sleep when it is given neither', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => false);
    const answered = pollUntilTrue(read, { windowMs: 20, intervalMs: 10 });
    await vi.advanceTimersByTimeAsync(50);
    expect(await answered).toBe(false);
    expect(read.mock.calls.length).toBeGreaterThan(1);
    vi.useRealTimers();
  });
});

/* -------------------------------------------------------------------------- */
/* The identifier a submit already holds                                      */
/* -------------------------------------------------------------------------- */

describe('transactionIdentifierOf', () => {
  it('reads the last identifier, which is what the SDK answers with', () => {
    const tx = { identifiers: () => ['first', 'last'] };
    expect(transactionIdentifierOf(tx)).toBe('last');
  });

  it('answers null for every shape that is not one, rather than guessing', () => {
    expect(transactionIdentifierOf(null)).toBeNull();
    expect(transactionIdentifierOf('0xabc')).toBeNull();
    expect(transactionIdentifierOf({})).toBeNull();
    expect(transactionIdentifierOf({ identifiers: 'not a function' })).toBeNull();
    expect(transactionIdentifierOf({ identifiers: () => 'not a list' })).toBeNull();
    expect(transactionIdentifierOf({ identifiers: () => [] })).toBeNull();
    expect(transactionIdentifierOf({ identifiers: () => [''] })).toBeNull();
    expect(transactionIdentifierOf({ identifiers: () => [7] })).toBeNull();
    expect(
      transactionIdentifierOf({
        identifiers: () => {
          throw new Error('wasm is gone');
        },
      }),
    ).toBeNull();
  });
});
