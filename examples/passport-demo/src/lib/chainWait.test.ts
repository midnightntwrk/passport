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
  forgetUnconfirmedSubmissions,
  markSubmissionUnconfirmed,
  nodeAlreadyHasTransaction,
  pollUntilTrue,
  providerConnectionWatch,
  refusalText,
  settleDeadlineFor,
  transactionIdentifierOf,
  waitBounded,
  RESUBMIT_WAIT_MS,
  SETTLE_WATCH_MS,
  SUBMIT_WAIT_MS,
  UNCONFIRMED_SETTLE_WAIT_MS,
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

/* -------------------------------------------------------------------------- */
/* A submission the node never acknowledged                                   */
/* -------------------------------------------------------------------------- */

/**
 * The rule 2026/09/08 bought, and the reason it is not a guess.
 *
 * The bound above used to answer with the identifier and ASSUME the bytes had
 * reached the node. Two transactions balanced by the sponsor that morning were
 * still not on chain 122 seconds later, and the person in front of the screen
 * waited three minutes for a settlement that could never come. So the bound
 * asks the node once more, and what the node says back decides which of four
 * things happens next — including the one case where nothing is said twice, and
 * every wait after it is shortened rather than left to run out.
 */
describe('refusalText', () => {
  it('reads the node’s own words out of the wrappers the SDK puts round them', () => {
    /* The real shape: the capabilities layer's tagged error, the node client's
       own, and the polkadot-js `RpcError` that is the only one carrying the
       node's answer. A matcher on the top message alone would see a constant. */
    const rpc = new Error('1013: Transaction Already Imported');
    const inner = new Error('Transaction submission failed', { cause: rpc });
    const outer = new Error('Transaction submission error', { cause: inner });
    expect(refusalText(outer)).toBe(
      'Transaction submission error | Transaction submission failed | 1013: Transaction Already Imported',
    );
  });

  it('reads an object that is not an Error, and a cause that is a bare string', () => {
    /* Effect's tagged errors and a `reject('…')` are both shapes this has to
       survive; neither is an `Error` with a `cause` chain of Errors. */
    expect(refusalText({ message: 'wrapped', cause: 'the socket went away' })).toBe(
      'wrapped | the socket went away',
    );
    expect(refusalText('1010: Invalid Transaction')).toBe('1010: Invalid Transaction');
  });

  it('says nothing where there is nothing to say, rather than "[object Object]"', () => {
    /* A wrapper with no message of its own is not a message: the node's words
       are further down, and the placeholder would only be noise in front of
       them. */
    expect(refusalText({ _tag: 'SubmissionError' })).toBe('');
    expect(refusalText({ _tag: 'SubmissionError', cause: new Error('1013: x') })).toBe(
      '1013: x',
    );
    expect(refusalText(undefined)).toBe('');
    expect(refusalText(null)).toBe('');
    expect(refusalText(1013)).toBe('');
    expect(refusalText({ message: 'alone', cause: null })).toBe('alone');
  });

  it('stops on a chain that points at itself, rather than taking the tab with it', () => {
    const looped: { message: string; cause?: unknown } = { message: 'round and round' };
    looped.cause = looped;
    expect(refusalText(looped)).toBe('round and round');
  });

  it('stops at a depth, rather than reading a chain somebody built on purpose', () => {
    let deepest: { message: string; cause?: unknown } = { message: 'level 20' };
    for (let level = 19; level >= 0; level -= 1) {
      deepest = { message: `level ${level}`, cause: deepest };
    }
    expect(refusalText(deepest).split(' | ')).toHaveLength(8);
  });
});

describe('nodeAlreadyHasTransaction', () => {
  it('knows each of the three wordings a node uses for a transaction it holds', () => {
    expect(nodeAlreadyHasTransaction(new Error('1013: Transaction Already Imported'))).toBe(true);
    expect(nodeAlreadyHasTransaction(new Error('1013: Transaction is already in the pool'))).toBe(
      true,
    );
    expect(nodeAlreadyHasTransaction(new Error('1012: Transaction is temporarily banned'))).toBe(
      true,
    );
  });

  it('finds them however deeply the SDK has wrapped them', () => {
    const wrapped = new Error('Transaction submission error', {
      cause: new Error('Transaction submission failed', {
        cause: new Error('1013: Transaction Already Imported'),
      }),
    });
    expect(nodeAlreadyHasTransaction(wrapped)).toBe(true);
  });

  it('is NOT fooled by a refusal, which has to keep travelling', () => {
    /* The two the sponsor-abandon rule and the retry rules are built on. A
       transaction the node threw out is not a transaction the node is holding,
       and treating one as the other would carry on with something dead. */
    expect(
      nodeAlreadyHasTransaction(new Error('1010: Invalid Transaction: Custom error: 231')),
    ).toBe(false);
    expect(
      nodeAlreadyHasTransaction(new Error('1010: Invalid Transaction: Custom error: 239')),
    ).toBe(false);
    /* A 1010 whose custom error happens to READ like one of the pool codes.
       This is why the codes are matched with their colon. */
    expect(
      nodeAlreadyHasTransaction(new Error('1010: Invalid Transaction: Custom error: 1013')),
    ).toBe(false);
    expect(nodeAlreadyHasTransaction(new Error('the connection to Midnight dropped'))).toBe(false);
    expect(nodeAlreadyHasTransaction(undefined)).toBe(false);
  });
});

describe('settleDeadlineFor', () => {
  afterEach(() => {
    forgetUnconfirmedSubmissions();
  });

  it('leaves every ordinary wait exactly as its caller set it', () => {
    expect(settleDeadlineFor('ab'.repeat(33), 180_000)).toBe(180_000);
    expect(settleDeadlineFor('ab'.repeat(33), SETTLE_WATCH_MS)).toBe(SETTLE_WATCH_MS);
    /* Leg one resolved its own ledger hash, so there is no identifier to ask
       about — and a wait with nothing to shorten is the ordinary one. */
    expect(settleDeadlineFor(null, 180_000)).toBe(180_000);
  });

  it('shortens BOTH waits an unacknowledged submission is followed by', () => {
    const sent = 'ab'.repeat(33);
    markSubmissionUnconfirmed(sent);
    /* The payment's two steps — three minutes — and a new account's own
       deployment — two. Both become a minute, and neither outcome changes. */
    expect(settleDeadlineFor(sent, 180_000)).toBe(UNCONFIRMED_SETTLE_WAIT_MS);
    expect(settleDeadlineFor(sent, SETTLE_WATCH_MS)).toBe(UNCONFIRMED_SETTLE_WAIT_MS);
    // Only that transaction. Nothing else in the session is hurried along.
    expect(settleDeadlineFor('cd'.repeat(33), 180_000)).toBe(180_000);
  });

  it('never LENGTHENS a wait that was already shorter than a minute', () => {
    const sent = 'ef'.repeat(33);
    markSubmissionUnconfirmed(sent);
    expect(settleDeadlineFor(sent, 10_000)).toBe(10_000);
  });

  it('forgets nothing until it is told to', () => {
    const sent = 'ba'.repeat(33);
    markSubmissionUnconfirmed(sent);
    expect(settleDeadlineFor(sent, 180_000)).toBe(UNCONFIRMED_SETTLE_WAIT_MS);
    forgetUnconfirmedSubmissions();
    expect(settleDeadlineFor(sent, 180_000)).toBe(180_000);
  });
});

describe('the windows themselves', () => {
  it('gives the second attempt a small fraction of the first wait', () => {
    /* Everything expensive is behind it — balanced, signed, and proved — so
       this is one call over a socket that either exists or does not. */
    expect(RESUBMIT_WAIT_MS).toBe(20_000);
    expect(RESUBMIT_WAIT_MS).toBeLessThan(SUBMIT_WAIT_MS);
  });

  it('leaves a minute for a transaction nobody can say was sent', () => {
    expect(UNCONFIRMED_SETTLE_WAIT_MS).toBe(60_000);
    expect(UNCONFIRMED_SETTLE_WAIT_MS).toBeLessThan(SETTLE_WATCH_MS);
  });
});
