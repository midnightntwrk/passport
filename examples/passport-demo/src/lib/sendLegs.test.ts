/**
 * Drills for the two-leg send's record and its retry rules.
 *
 * Three things are held to account here, and each of them is a way of losing
 * track of somebody's money rather than a way of looking untidy.
 *
 * The RECORD, because it is the only thing that survives a reload: a field the
 * writer emits and the reader discards is a resume that quietly starts from the
 * wrong leg, and a malformed row accepted is a Home card offering to continue a
 * run that cannot run.
 *
 * The CLASSIFICATION, because it decides whether a person is asked to approve
 * the same failing step twice more. Too eager and a send with nothing behind it
 * burns three passkey prompts; too cautious and a transfer refused by a node
 * for a state that has already moved is abandoned one block before it would
 * have worked.
 *
 * The SENTENCE, because "Nothing was sent" over a first leg that landed is a
 * false statement about where the reader's money is.
 *
 * And the WAIT between the legs, added 2026/09/03, because it was 20 to 30
 * seconds of a 54-second send and most of it was spent not asking. It is
 * drilled with an injected clock and injected probes — no timers are waited
 * out here — so the two cadences, the landing edge, and the deadline are all
 * observable as counted calls rather than as elapsed time.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyLegError,
  pendingSendsStorageKey,
  pendingSendStepLine,
  planOfRecord,
  planShieldedSend,
  sendStepLine,
  SEND_REFUSED_TEXT,
  sendRefusalText,
  readPendingSends,
  resumesWithoutPrompt,
  retryDelayMs,
  SEND_LEG_ATTEMPTS,
  SETTLE_LOOK_AFTER_LANDING_MS,
  SETTLE_LOOK_BEFORE_LANDING_MS,
  sendFailureNotice,
  serialisePendingSends,
  watchForSettlement,
  type PendingSend,
  type SettleProbe,
} from './sendLegs.js';

const NOW = '2026-09-02T14:00:00.000Z';

function nightSend(overrides: Partial<PendingSend> = {}): PendingSend {
  return {
    id: 'send-1',
    kind: 'night',
    recipient: { label: 'alice.night', accountAddress: 'ab'.repeat(32) },
    amount: '1000000',
    colourHex: '00'.repeat(32),
    ownReceivingAddress: 'mn_addr_stagenet1alice',
    leg: 'settle',
    withdrawTxHash: 'cc'.repeat(32),
    expectedNote: { unshieldedBefore: '5' },
    attempts: { withdraw: 1, deposit: 0, change: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function shieldedSend(overrides: Partial<PendingSend> = {}): PendingSend {
  return nightSend({
    id: 'send-2',
    kind: 'shielded',
    tokenType: 'dd'.repeat(32),
    colourHex: 'dd'.repeat(32),
    ownReceivingAddress: 'mn_shield-addr_stagenet1alice',
    leg: 'deposit',
    expectedNote: { heldBeforeIds: [`${'dd'.repeat(32)}:${'ee'.repeat(32)}`] },
    lastError: { message: 'The network turned this step down.', retryable: true },
    activityId: 'row-9',
    ...overrides,
  });
}

describe('pendingSendsStorageKey', () => {
  it('scopes the records to one credential, under a version prefix', () => {
    expect(pendingSendsStorageKey('cred-a')).toBe('midnight.passport.sends.v1:cred-a');
    expect(pendingSendsStorageKey('cred-b')).not.toBe(pendingSendsStorageKey('cred-a'));
  });
});

describe('readPendingSends and serialisePendingSends', () => {
  it('round-trips a NIGHT run and a shielded run whole', () => {
    const records = [nightSend(), shieldedSend()];
    expect(readPendingSends(serialisePendingSends(records))).toEqual(records);
  });

  it('answers an empty list for nothing stored and for anything unreadable', () => {
    expect(readPendingSends(null)).toEqual([]);
    expect(readPendingSends(undefined)).toEqual([]);
    expect(readPendingSends('')).toEqual([]);
    expect(readPendingSends('{not json')).toEqual([]);
    expect(readPendingSends('{"records":[]}')).toEqual([]);
  });

  it('drops a finished run rather than offering to continue it', () => {
    const written = serialisePendingSends([nightSend({ leg: 'done' }), shieldedSend()]);
    expect(readPendingSends(written).map((record) => record.id)).toEqual(['send-2']);
  });

  it('keeps a run that failed, because the value has still moved', () => {
    const written = serialisePendingSends([nightSend({ leg: 'failed' })]);
    expect(readPendingSends(written)).toHaveLength(1);
  });

  it('refuses every row it could not resume', () => {
    const bad: unknown[] = [
      null,
      'a string',
      { ...nightSend(), id: '' },
      { ...nightSend(), kind: 'gold' },
      { ...nightSend(), leg: 'somewhere' },
      { ...nightSend(), amount: '0' },
      { ...nightSend(), amount: '1.5' },
      { ...nightSend(), amount: 1000 },
      { ...nightSend(), colourHex: '' },
      { ...nightSend(), ownReceivingAddress: '' },
      { ...nightSend(), recipient: null },
      { ...nightSend(), recipient: { label: '', accountAddress: 'ab' } },
      { ...nightSend(), recipient: { label: 'alice.night', accountAddress: '' } },
      { ...nightSend(), createdAt: 'the other day' },
      { ...nightSend(), updatedAt: 'later' },
      /* A shielded run with no colour cannot name the note it waits for. */
      { ...shieldedSend(), tokenType: undefined },
    ];
    expect(readPendingSends(JSON.stringify(bad))).toEqual([]);
  });

  it('reads a run back without its optional halves rather than refusing it', () => {
    const bare = {
      ...nightSend(),
      withdrawTxHash: undefined,
      expectedNote: undefined,
      lastError: undefined,
      activityId: undefined,
      attempts: undefined,
      leg: 'withdraw',
    };
    const [read] = readPendingSends(JSON.stringify([bare]));
    expect(read.leg).toBe('withdraw');
    expect(read.withdrawTxHash).toBeUndefined();
    expect(read.expectedNote).toBeUndefined();
    expect(read.lastError).toBeUndefined();
    expect(read.activityId).toBeUndefined();
    /* A record with no attempt counts has made no attempts, not an unknown
       number of them: a resume that started at attempt NaN would never stop. */
    expect(read.attempts).toEqual({ withdraw: 0, deposit: 0, change: 0 });
  });

  it('discards an expectation, an error, and counts it cannot use', () => {
    const [read] = readPendingSends(
      JSON.stringify([
        {
          ...nightSend(),
          expectedNote: { unshieldedBefore: 'lots' },
          lastError: { message: 'gone', retryable: 'yes' },
          attempts: { withdraw: -1, deposit: 1.5 },
          activityId: '',
        },
      ]),
    );
    expect(read.expectedNote).toBeUndefined();
    expect(read.lastError).toBeUndefined();
    expect(read.attempts).toEqual({ withdraw: 0, deposit: 0, change: 0 });
    expect(read.activityId).toBeUndefined();
  });

  it('keeps a zero opening balance, which is a real answer', () => {
    const [read] = readPendingSends(
      JSON.stringify([{ ...nightSend(), expectedNote: { unshieldedBefore: '0' } }]),
    );
    expect(read.expectedNote).toEqual({ unshieldedBefore: '0' });
  });

  it('keeps only the note identities it can read', () => {
    const [read] = readPendingSends(
      JSON.stringify([{ ...shieldedSend(), expectedNote: { heldBeforeIds: ['a:b', 7, null] } }]),
    );
    expect(read.expectedNote).toEqual({ heldBeforeIds: ['a:b'] });
  });

  it('discards an expectation that is neither of the two shapes', () => {
    const [read] = readPendingSends(
      JSON.stringify([{ ...nightSend(), expectedNote: 'soon' }]),
    );
    expect(read.expectedNote).toBeUndefined();
  });
});

describe('classifyLegError', () => {
  it('honours a classification the transaction runtime already made', () => {
    const balancing = Object.assign(new Error('balancing failed'), {
      name: 'BalancingFailure',
      retryable: true,
      userMessage: 'The fee sponsor was busy. Passport is trying again.',
      stage: 'sponsor',
    });
    /* Wrapped twice, exactly as it reaches the orchestrator: the account module
       says which circuit was called, and the sheet sees only the outermost. */
    const wrapped = new Error('The account contract rejected deposit_shielded.', {
      cause: new Error('balanceWithSponsor', { cause: balancing }),
    });
    expect(classifyLegError(wrapped)).toEqual({
      retryable: true,
      rebuild: true,
      message: 'The fee sponsor was busy. Passport is trying again.',
    });
  });

  it('honours a runtime classification that says do not try again', () => {
    const balancing = Object.assign(new Error('nope'), {
      name: 'BalancingFailure',
      retryable: false,
      userMessage: 'The fee sponsor will not cover this transfer.',
      stage: 'sponsor',
    });
    expect(classifyLegError(balancing)).toEqual({
      retryable: false,
      rebuild: false,
      message: 'The fee sponsor will not cover this transfer.',
    });
  });

  it('ignores a half-formed BalancingFailure rather than trusting it', () => {
    const half = Object.assign(new Error('Invalid Transaction: custom error 239'), {
      name: 'BalancingFailure',
      retryable: 'maybe',
      userMessage: 'ignored',
    });
    expect(classifyLegError(half).retryable).toBe(true);
    const noMessage = Object.assign(new Error('something else entirely'), {
      name: 'BalancingFailure',
      retryable: true,
      userMessage: '',
    });
    expect(classifyLegError(noMessage).retryable).toBe(false);
  });

  it('never retries a shortfall, however deeply it is wrapped', () => {
    const verdict = classifyLegError(
      new Error('The account contract rejected deposit_night.', {
        cause: new Error('Insufficient funds to balance transaction'),
      }),
    );
    expect(verdict.retryable).toBe(false);
    expect(verdict.rebuild).toBe(false);
    expect(verdict.message).toBe(
      'There was not enough to cover this step, so nothing further was sent.',
    );
  });

  it('prefers the shortfall to a node refusal that carries it', () => {
    const submission = Object.assign(
      new Error('Invalid Transaction: insufficient funds'),
      { name: 'SubmissionError' },
    );
    expect(classifyLegError(submission).retryable).toBe(false);
  });

  it('rebuilds after a node refusal or a failed submission', () => {
    const rebuilt = {
      retryable: true,
      rebuild: true,
      message: 'The network turned this step down. Passport is building it again.',
    };
    expect(
      classifyLegError(Object.assign(new Error('rejected'), { name: 'SubmissionError' })),
    ).toEqual(rebuilt);
    expect(
      classifyLegError(Object.assign(new Error('call failed'), { name: 'CallTxFailedError' })),
    ).toEqual(rebuilt);
    expect(classifyLegError(new Error('Invalid Transaction: Custom error: 239'))).toEqual(rebuilt);
  });

  it('reports anything else as it came, and does not retry it', () => {
    expect(classifyLegError(new Error('The proof server is unreachable.'))).toEqual({
      retryable: false,
      rebuild: false,
      message: 'The proof server is unreachable.',
    });
    expect(classifyLegError('a bare string').message).toBe('a bare string');
    expect(classifyLegError(null).message).toBe('This step could not be finished.');
    expect(classifyLegError({}).message).toBe('This step could not be finished.');
    expect(classifyLegError({ message: 42 }).message).toBe('This step could not be finished.');
    expect(classifyLegError({ name: 7, message: '' }).message).toBe(
      'This step could not be finished.',
    );
  });

  it('stops walking a cause chain that loops', () => {
    const loop: { message: string; cause?: unknown } = { message: 'round and round' };
    loop.cause = loop;
    expect(classifyLegError(loop).message).toBe('round and round');
  });
});

describe('retryDelayMs', () => {
  it('waits two, five, ten, then twenty seconds and no longer', () => {
    expect(retryDelayMs(0)).toBe(2_000);
    expect(retryDelayMs(1)).toBe(5_000);
    expect(retryDelayMs(2)).toBe(10_000);
    expect(retryDelayMs(3)).toBe(20_000);
    expect(retryDelayMs(4)).toBe(20_000);
    expect(retryDelayMs(50)).toBe(20_000);
    // A caller counting from something other than zero still waits.
    expect(retryDelayMs(-1)).toBe(2_000);
  });

  it('attempts a leg three times', () => {
    expect(SEND_LEG_ATTEMPTS).toBe(3);
  });
});

describe('sendFailureNotice', () => {
  it('says nothing moved only when nothing moved', () => {
    expect(
      sendFailureNotice({
        legLanded: false,
        message: 'The fee sponsor will not cover this transfer.',
        amountLabel: '10 mUSD',
        assetSymbol: 'mUSD',
      }),
    ).toBe(
      'Nothing was sent — no mUSD moved from your account. ' +
        'The fee sponsor will not cover this transfer.',
    );
  });

  it('names the item rather than a balance when there is only one of it', () => {
    expect(
      sendFailureNotice({
        legLanded: false,
        message: 'The network turned this step down.',
        amountLabel: '1 Item · a1b2',
        assetSymbol: 'Item · a1b2',
        item: true,
      }),
    ).toContain('Nothing was sent — the item is still in your account.');
  });

  it('says where the money is when the first step landed', () => {
    expect(
      sendFailureNotice({
        legLanded: true,
        message: 'The fee sponsor was busy.',
        amountLabel: '10 mUSD',
        assetSymbol: 'mUSD',
      }),
    ).toBe(
      'Step 1 landed: 10 mUSD left your account and is waiting at your Passport. ' +
        'Step 2 did not finish: The fee sponsor was busy. Continue from Home.',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The wait between the legs                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A clock that only ever moves because something SLEPT.
 *
 * That is the whole instrument: every millisecond in these drills is one the
 * code under test asked for, so an assertion about elapsed time is an assertion
 * about the schedule rather than about how long the test took to run.
 */
function fakeClock() {
  let at = 1_000;
  const slept: number[] = [];
  return {
    now: () => at,
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
      at += ms;
    },
  };
}

/** A wallet that reports the arrival on the nth look and not before. */
function walletArrivingOnLook(nth: number, note: string | null = null) {
  let looks = 0;
  return {
    get looks() {
      return looks;
    },
    read: async (): Promise<SettleProbe<string | null>> => {
      looks += 1;
      return looks >= nth ? { arrived: true, note } : { arrived: false };
    },
  };
}

describe('watchForSettlement', () => {
  it('returns the note the moment the wallet has it, having slept for nothing', async () => {
    const clock = fakeClock();
    const wallet = walletArrivingOnLook(1, 'note-1');
    const outcome = await watchForSettlement<string | null>({
      readWallet: wallet.read,
      landed: true,
      deadlineMs: 180_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(outcome).toEqual({ settled: true, note: 'note-1', landed: true, looks: 1 });
    // A wallet that already holds it is not made to wait a tick first.
    expect(clock.slept).toEqual([]);
  });

  it('reports a NIGHT arrival, which has no note, as an arrival all the same', async () => {
    /* `null` is the answer for a run that arrives as a rise in a balance. It
       must not read as "nothing yet": a null that meant both is how the paying
       leg gets built against money that has not come. */
    const clock = fakeClock();
    const outcome = await watchForSettlement<string | null>({
      readWallet: walletArrivingOnLook(1, null).read,
      landed: true,
      deadlineMs: 180_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(outcome).toEqual({ settled: true, note: null, landed: true, looks: 1 });
  });

  it('looks again the INSTANT the chain has leg one, with no tick in between', async () => {
    /* THE 2026/09/03 FIX, as a schedule. Two slow turns while the indexer has
       nothing, then the landing — and the look that follows the landing is not
       separated from it by a sleep. That sleep was the two-or-three seconds a
       send paid for the news it already had. */
    const clock = fakeClock();
    const wallet = walletArrivingOnLook(4, 'note-2');
    let asked = 0;
    const outcome = await watchForSettlement<string | null>({
      readWallet: wallet.read,
      confirmLanded: async () => {
        asked += 1;
        return asked >= 3;
      },
      deadlineMs: 180_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(outcome.settled).toBe(true);
    expect(asked).toBe(3);
    /* Two intervals at the slow cadence, and then nothing: the fourth look —
       the one that found the note — happened on the landing edge itself. */
    expect(clock.slept).toEqual([
      SETTLE_LOOK_BEFORE_LANDING_MS,
      SETTLE_LOOK_BEFORE_LANDING_MS,
    ]);
    expect(outcome.landed).toBe(true);
  });

  it('runs at the fast cadence once it has landed, and asks the indexer no more', async () => {
    const clock = fakeClock();
    let asked = 0;
    const outcome = await watchForSettlement<string | null>({
      readWallet: walletArrivingOnLook(4, 'note-3').read,
      confirmLanded: async () => {
        asked += 1;
        return true;
      },
      deadlineMs: 180_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(outcome.settled).toBe(true);
    // Asked once, answered yes, never asked again.
    expect(asked).toBe(1);
    expect(clock.slept).toEqual([
      SETTLE_LOOK_AFTER_LANDING_MS,
      SETTLE_LOOK_AFTER_LANDING_MS,
    ]);
  });

  it('starts a run whose leg one resolved its own hash at the fast cadence', async () => {
    /* The common case, and the reason `landed` is an input: `txIdResolved` IS
       an indexer answer for that transaction, so asking again would be paying
       for a fact already in hand. */
    const clock = fakeClock();
    const outcome = await watchForSettlement<string | null>({
      readWallet: walletArrivingOnLook(3, 'note-4').read,
      landed: true,
      confirmLanded: async () => {
        throw new Error('the indexer must not be asked about a resolved hash');
      },
      deadlineMs: 180_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(outcome).toEqual({ settled: true, note: 'note-4', landed: true, looks: 3 });
    expect(clock.slept).toEqual([
      SETTLE_LOOK_AFTER_LANDING_MS,
      SETTLE_LOOK_AFTER_LANDING_MS,
    ]);
  });

  it('tells the orchestrator once, on the landing edge, so leg two can be prepared', async () => {
    const clock = fakeClock();
    let told = 0;
    let asked = 0;
    await watchForSettlement<string | null>({
      readWallet: walletArrivingOnLook(5, 'note-5').read,
      confirmLanded: async () => {
        asked += 1;
        return asked >= 2;
      },
      onLanded: () => {
        told += 1;
      },
      deadlineMs: 180_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(told).toBe(1);
  });

  it('tells it immediately for a run that starts landed', async () => {
    const clock = fakeClock();
    const told: number[] = [];
    await watchForSettlement<string | null>({
      readWallet: walletArrivingOnLook(2, 'note-6').read,
      landed: true,
      onLanded: () => told.push(clock.now()),
      deadlineMs: 180_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    // Before the first look, not after the first sleep.
    expect(told).toEqual([1_000]);
  });

  it('waits without asking the chain at all when there is nothing to ask about', async () => {
    const clock = fakeClock();
    const outcome = await watchForSettlement<string | null>({
      readWallet: walletArrivingOnLook(3, 'note-7').read,
      deadlineMs: 180_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(outcome.settled).toBe(true);
    expect(outcome.landed).toBe(false);
    // The slow cadence throughout: nothing has said the chain has it.
    expect(clock.slept).toEqual([
      SETTLE_LOOK_BEFORE_LANDING_MS,
      SETTLE_LOOK_BEFORE_LANDING_MS,
    ]);
  });

  it('gives up on the deadline as an OUTCOME, never as a throw', async () => {
    /* The money has moved. A wait that ran out has to leave the record at
       `settle` and say so, which the orchestrator cannot do if this raises. */
    const clock = fakeClock();
    const outcome = await watchForSettlement<string | null>({
      readWallet: async () => ({ arrived: false }),
      landed: true,
      deadlineMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
      afterLandingMs: 400,
    });
    /* Four looks and three waits inside one second, and then the honest
       answer — not a fifth wait that would take it past the deadline. */
    expect(outcome).toEqual({ settled: false, landed: true, looks: 4 });
    expect(clock.slept).toEqual([400, 400, 400]);
  });

  it('honours the cadences a caller names instead of the defaults', async () => {
    const clock = fakeClock();
    let asked = 0;
    await watchForSettlement<string | null>({
      readWallet: walletArrivingOnLook(3, 'note-8').read,
      confirmLanded: async () => {
        asked += 1;
        return asked >= 2;
      },
      deadlineMs: 180_000,
      now: clock.now,
      sleep: clock.sleep,
      beforeLandingMs: 7,
      afterLandingMs: 3,
    });
    /* One slow interval, then the landing edge with no sleep on it, then the
       look that found it. Nothing at the fast cadence was needed. */
    expect(clock.slept).toEqual([7]);
  });

  it('lets a probe failure travel, rather than reporting it as an arrival', async () => {
    const clock = fakeClock();
    await expect(
      watchForSettlement<string | null>({
        readWallet: async () => {
          throw new Error('the wallet state could not be read');
        },
        landed: true,
        deadlineMs: 180_000,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow('the wallet state could not be read');
  });

  it('keeps the two cadences the right way round', async () => {
    /* Not a value assertion: the point of the pair is that the wait AFTER the
       chain has it is the shorter one, because that read touches no network. */
    expect(SETTLE_LOOK_AFTER_LANDING_MS).toBeLessThan(SETTLE_LOOK_BEFORE_LANDING_MS);
  });
});

/* -------------------------------------------------------------------------- */
/* What a refused transfer is TOLD                                            */
/* -------------------------------------------------------------------------- */

describe('sendRefusalText', () => {
  /** The machinery a panel must never show, in the words it showed them in. */
  const MACHINERY = /account contract|withdraw_shielded|withdraw_night|deposit_shielded|SubmissionError|Custom error|circuit|contract|1010|239/i;

  it('says one sentence about the send a user reported, not the node’s', () => {
    /* Verbatim from production, 2026/09/03: a second mUSD send. The chain is
       the one the app builds — the account module's sentence about the circuit,
       wrapping the node's refusal. */
    const refusal = Object.assign(new Error('SubmissionError: 1010: Invalid Transaction: Custom error: 239'), {
      name: 'SubmissionError',
    });
    const wrapped = Object.assign(
      new Error('The account contract rejected withdraw_shielded.'),
      { detail: 'SubmissionError: 1010: Invalid Transaction: Custom error: 239', cause: refusal },
    );
    const said = sendRefusalText(wrapped);
    expect(said).toBe(SEND_REFUSED_TEXT);
    expect(said).not.toMatch(MACHINERY);
  });

  it('says it for a failure nobody has classified, rather than quoting it', () => {
    const said = sendRefusalText(
      new Error('The account contract rejected withdraw_shielded.'),
    );
    expect(said).toBe(SEND_REFUSED_TEXT);
    expect(said).not.toMatch(MACHINERY);
  });

  it('says it for a plain string, an object, and nothing at all', () => {
    expect(sendRefusalText('boom')).toBe(SEND_REFUSED_TEXT);
    expect(sendRefusalText({ nope: true })).toBe(SEND_REFUSED_TEXT);
    expect(sendRefusalText(undefined)).toBe(SEND_REFUSED_TEXT);
  });

  it('keeps a message that was written for a reader in the first place', () => {
    /* The runtime classified this one and wrote the sentence itself; replacing
       it with a generic one would be a worse screen, not a cleaner one. */
    const balancing = Object.assign(new Error('balancing failed'), {
      name: 'BalancingFailure',
      retryable: true,
      userMessage: 'The fee sponsor is busy. Passport will try again.',
      stage: 'balance',
    });
    expect(sendRefusalText(balancing)).toBe('The fee sponsor is busy. Passport will try again.');
    expect(sendRefusalText(balancing)).not.toMatch(MACHINERY);
  });

  it('keeps the not-enough-money sentence, wherever in the chain it was said', () => {
    const inner = new Error('insufficient funds for the shielded offer');
    const outer = Object.assign(new Error('The account contract rejected withdraw_shielded.'), {
      cause: inner,
    });
    const said = sendRefusalText(outer);
    expect(said).toBe('There was not enough to cover this step, so nothing further was sent.');
    expect(said).not.toMatch(MACHINERY);
  });

  it('never lets a node refusal through as the retry sentence', () => {
    /* `classifyLegError` says "Passport is building it again" because it drives
       a retry; that is a decision, not a thing to leave on a panel after the
       last attempt has been spent. */
    const refused = Object.assign(new Error('Invalid Transaction: Custom error: 239'), {
      name: 'SubmissionError',
    });
    expect(classifyLegError(refused).rebuild).toBe(true);
    expect(sendRefusalText(refused)).toBe(SEND_REFUSED_TEXT);
  });
});

/**
 * THE THIRD LEG (2026/09/03).
 *
 * A shielded payment is three transactions rather than two whenever the account
 * holds more of a colour than is being paid away, and the reason is the
 * deployed contract's: a partial `withdraw_shielded` re-registers its own
 * change, and the node then refuses every later withdrawal against what it left
 * behind. The client stopped asking for partial withdrawals, and the rules that
 * decide how many transactions a payment is, what each of them moves, and what
 * the person watching is told about them are drilled here.
 *
 * The wrong answers are the point. A plan that paid the recipient the WHOLE
 * coin, or one that counted to two through a three-step run, or a card on Home
 * that told somebody their finished payment had not happened, are all failures
 * of arithmetic or of copy that this file exists to catch.
 */
describe('planShieldedSend', () => {
  it('takes the whole coin and leaves change when the account holds more', () => {
    expect(planShieldedSend({ held: 100n, amount: 2n })).toEqual({
      withdraw: 100n,
      pay: 2n,
      change: 98n,
      steps: 3,
    });
  });

  it('is the two-step send it has always been when the payment IS the coin', () => {
    expect(planShieldedSend({ held: 7n, amount: 7n })).toEqual({
      withdraw: 7n,
      pay: 7n,
      change: null,
      steps: 2,
    });
  });

  it('refuses rather than paying less than was asked for', () => {
    expect(planShieldedSend({ held: 1n, amount: 2n })).toBeNull();
  });

  it('refuses an amount that is not a payment at all', () => {
    expect(planShieldedSend({ held: 100n, amount: 0n })).toBeNull();
    expect(planShieldedSend({ held: 100n, amount: -1n })).toBeNull();
  });
});

describe('planOfRecord', () => {
  it('reads three legs out of a record that took the whole coin', () => {
    const plan = planOfRecord(shieldedSend({ amount: '2', withdrawAmount: '100' }));
    expect(plan).toEqual({ withdraw: 100n, pay: 2n, change: 98n, steps: 3 });
  });

  it('reads two legs out of a record with no withdrawn figure', () => {
    const plan = planOfRecord(nightSend({ amount: '1000000' }));
    expect(plan).toEqual({ withdraw: 1_000_000n, pay: 1_000_000n, change: null, steps: 2 });
  });

  it('reads two legs where the whole coin WAS the payment', () => {
    const plan = planOfRecord(shieldedSend({ amount: '5', withdrawAmount: '5' }));
    expect(plan.change).toBeNull();
    expect(plan.steps).toBe(2);
  });
});

describe('readPendingSends, on a three-leg record', () => {
  it('keeps the withdrawn figure, the paying hash, and the third count', () => {
    const stored = serialisePendingSends([
      shieldedSend({
        amount: '2',
        withdrawAmount: '100',
        depositTxHash: 'ff'.repeat(32),
        leg: 'change',
        attempts: { withdraw: 1, deposit: 1, change: 2 },
      }),
    ]);
    const [read] = readPendingSends(stored);
    expect(read.withdrawAmount).toBe('100');
    expect(read.depositTxHash).toBe('ff'.repeat(32));
    expect(read.leg).toBe('change');
    expect(read.attempts).toEqual({ withdraw: 1, deposit: 1, change: 2 });
  });

  it('discards a withdrawn figure smaller than the payment, and an empty hash', () => {
    /* Never a record this app wrote: leg one takes the whole coin, so it is at
       least what is being paid. Read back as absent, which leaves the run
       behaving as the two-leg one it looks like rather than as a run owed
       change nobody has. */
    const stored = JSON.stringify([
      { ...shieldedSend({ amount: '10' }), withdrawAmount: '4', depositTxHash: '' },
    ]);
    const [read] = readPendingSends(stored);
    expect(read.withdrawAmount).toBeUndefined();
    expect(read.depositTxHash).toBeUndefined();
    expect(planOfRecord(read).steps).toBe(2);
  });

  it('accepts `change` as a leg a run can be carried on from', () => {
    const [read] = readPendingSends(JSON.stringify([shieldedSend({ leg: 'change' })]));
    expect(read).toBeDefined();
    expect(read.leg).toBe('change');
  });
});

describe('sendStepLine', () => {
  const three = { steps: 3 as const, recipient: 'alice.night' };
  const two = { steps: 2 as const, recipient: 'alice.night' };

  it('counts a three-step payment in plain words', () => {
    expect(sendStepLine({ ...three, step: 'withdrawing' })).toBe(
      'Step 1 of 3 · Taking the coin out.',
    );
    expect(sendStepLine({ ...three, step: 'settling' })).toBe(
      'Step 1 done. Waiting for it to clear before it goes on.',
    );
    expect(sendStepLine({ ...three, step: 'depositing' })).toBe(
      'Step 2 of 3 · Paying alice.night.',
    );
    expect(sendStepLine({ ...three, step: 'changing' })).toBe(
      'Step 3 of 3 · Returning the change.',
    );
  });

  it('still counts a two-step payment to two', () => {
    expect(sendStepLine({ ...two, step: 'withdrawing' })).toBe(
      'Step 1 of 2 — taking the amount out of your account.',
    );
    expect(sendStepLine({ ...two, step: 'settling' })).toBe(
      'Step 1 of 2 done. Waiting for the amount to clear before it goes on.',
    );
    expect(sendStepLine({ ...two, step: 'depositing' })).toBe(
      'Step 2 of 2 — paying it into alice.night’s account.',
    );
  });

  it('shows a retry on the step that is being attempted again', () => {
    expect(sendStepLine({ ...three, step: 'withdrawing', attemptSuffix: ' (retry 1 of 2)' })).toBe(
      'Step 1 of 3 · Taking the coin out (retry 1 of 2).',
    );
    expect(sendStepLine({ ...three, step: 'depositing', attemptSuffix: ' (retry 1 of 2)' })).toBe(
      'Step 2 of 3 · Paying alice.night (retry 1 of 2).',
    );
    expect(sendStepLine({ ...three, step: 'changing', attemptSuffix: ' (retry 1 of 2)' })).toBe(
      'Step 3 of 3 · Returning the change (retry 1 of 2).',
    );
    expect(sendStepLine({ ...two, step: 'depositing', attemptSuffix: ' (retry 1 of 2)' })).toBe(
      'Step 2 of 2 — paying it into alice.night’s account (retry 1 of 2).',
    );
  });

  it('never numbers the amount going back after a refusal', () => {
    const said = sendStepLine({ ...three, step: 'returning' });
    expect(said).toBe('alice.night was not paid. Putting the amount back into your account.');
    expect(said).not.toMatch(/Step/);
  });

  it('says none of it in machinery', () => {
    const machinery = /contract|circuit|withdraw_|deposit_|nonce|note|coin ledger|token type/i;
    for (const step of ['withdrawing', 'settling', 'depositing', 'changing', 'returning'] as const) {
      for (const steps of [2, 3] as const) {
        expect(sendStepLine({ step, steps, recipient: 'alice.night' })).not.toMatch(machinery);
      }
    }
  });
});

describe('pendingSendStepLine', () => {
  it('says nothing has moved when the first leg never went', () => {
    expect(pendingSendStepLine(shieldedSend({ leg: 'withdraw', withdrawTxHash: undefined }))).toBe(
      'Nothing has left your account yet.',
    );
  });

  it('says the arrival is still coming while the run waits', () => {
    expect(pendingSendStepLine(shieldedSend({ leg: 'settle' }))).toBe(
      'Step 1 done. Waiting for the amount to reach your Passport.',
    );
  });

  it('says the recipient HAS been paid when only the change is outstanding', () => {
    const said = pendingSendStepLine(
      shieldedSend({ leg: 'change', amount: '2', withdrawAmount: '100' }),
    );
    expect(said).toBe(
      'alice.night has been paid. Your change has not come back to your account yet.',
    );
  });

  it('names the paying leg differently for a two-step and a three-step run', () => {
    expect(
      pendingSendStepLine(shieldedSend({ leg: 'deposit', amount: '2', withdrawAmount: '100' })),
    ).toBe('Step 1 done. Paying alice.night has not finished.');
    expect(pendingSendStepLine(shieldedSend({ leg: 'deposit' }))).toBe(
      'Step 1 done. Step 2 — paying it into alice.night’s account — has not finished.',
    );
  });
});

describe('resumesWithoutPrompt', () => {
  it('carries on every leg the first one already paid for', () => {
    /* THE 2026/09/04 STABILITY AUDIT. A reload 33 seconds into a mUSD send left
       the card on Home for three minutes waiting for `Continue`; pressing it
       then finished the payment. Leg one's assertion covered the whole run, and
       what is left — the wait, the paying leg, the change going back — is
       permissionless, so there is nothing left to ask anybody. */
    for (const leg of ['withdraw', 'settle', 'deposit', 'change'] as const) {
      expect(resumesWithoutPrompt(shieldedSend({ leg }))).toBe(true);
    }
  });

  it('needs the reader for a run that has not spent anything yet', () => {
    /* Leg one raises the account's own assertion, which is a passkey prompt,
       and a prompt nobody asked for is exactly what this must not produce. */
    expect(
      resumesWithoutPrompt(shieldedSend({ leg: 'withdraw', withdrawTxHash: undefined })),
    ).toBe(false);
    expect(resumesWithoutPrompt(shieldedSend({ leg: 'withdraw', withdrawTxHash: '' }))).toBe(
      false,
    );
  });

  it('leaves a run that stopped with a reason on it alone', () => {
    /* The card is showing why it did not work. Starting again underneath
       somebody reading that is the screen acting on a decision they have not
       made — so `Continue` stays theirs to press. */
    expect(
      resumesWithoutPrompt(
        shieldedSend({ leg: 'failed', lastError: { message: 'no', retryable: true } }),
      ),
    ).toBe(false);
  });

  it('has nothing to carry on for a finished run', () => {
    expect(resumesWithoutPrompt(shieldedSend({ leg: 'done' }))).toBe(false);
  });

  it('reads a NIGHT run by the same rule', () => {
    expect(resumesWithoutPrompt(nightSend())).toBe(true);
    expect(resumesWithoutPrompt(nightSend({ withdrawTxHash: undefined }))).toBe(false);
  });
});

describe('sendFailureNotice, on a payment that worked', () => {
  it('never tells somebody to chase a payment that has already happened', () => {
    const said = sendFailureNotice({
      legLanded: true,
      recipientPaid: true,
      message: 'The network turned this step down.',
      amountLabel: '2 units',
      assetSymbol: 'mUSD',
    });
    expect(said).toBe(
      'Your payment went through. Your change has not come back to your account yet — ' +
        'finish that from Home.',
    );
    expect(said).not.toMatch(/not paid|nothing was sent/i);
  });
});
