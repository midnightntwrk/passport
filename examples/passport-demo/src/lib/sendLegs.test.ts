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
 */

import { describe, expect, it } from 'vitest';

import {
  classifyLegError,
  pendingSendsStorageKey,
  readPendingSends,
  retryDelayMs,
  SEND_LEG_ATTEMPTS,
  sendFailureNotice,
  serialisePendingSends,
  type PendingSend,
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
    attempts: { withdraw: 1, deposit: 0 },
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
    expect(read.attempts).toEqual({ withdraw: 0, deposit: 0 });
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
    expect(read.attempts).toEqual({ withdraw: 0, deposit: 0 });
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
