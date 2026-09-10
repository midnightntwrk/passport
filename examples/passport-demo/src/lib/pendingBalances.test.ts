/**
 * The two moments a balance surface must not paint a zero.
 *
 * Both were reported against production. A Passport that had just been set up
 * showed `NIGHT 0` and `mUSD 0` while the sponsor's grant was on its way
 * (issue #19), and a name send showed `mUSD 0` for the minutes between the coin
 * leaving the account and the change coming back (reviewer, 2026/09/08). Every
 * rule that decides what is painted instead — and, just as importantly, every
 * rule about when NOTHING is painted instead — is drilled here.
 */

import { describe, expect, it } from 'vitest';

import { OPENING_MUSD, OPENING_NIGHT } from './activation.js';
import type { HoldingsSnapshot } from './balanceWatch.js';
import { NIGHT_COLOUR_HEX } from './colour.js';
import {
  NO_PENDING_BALANCES,
  PENDING_BALANCE_WORD,
  pendingBalances,
} from './pendingBalances.js';
import type { PendingSend } from './sendLegs.js';

const MUSD = 'ab'.repeat(32);

function account(over: Partial<HoldingsSnapshot> = {}): HoldingsSnapshot {
  return {
    nightBalance: '0',
    stablecoin: { colourHex: MUSD, amount: 0n },
    otherShielded: [],
    ...over,
  };
}

/** A shielded run that took the whole 100-unit coin out to pay 10 of it away. */
function send(over: Partial<PendingSend> = {}): PendingSend {
  return {
    id: 'send-1',
    kind: 'shielded',
    recipient: { label: 'alice.night', accountAddress: 'mn_addr_stagenet1recipient' },
    amount: '10',
    tokenType: MUSD,
    colourHex: MUSD,
    ownReceivingAddress: 'mn_addr_stagenet1own',
    leg: 'deposit',
    withdrawTxHash: 'aa'.repeat(32),
    withdrawAmount: '100',
    attempts: { withdraw: 1, deposit: 1, change: 0 },
    createdAt: '2026-09-08T09:15:00.000Z',
    updatedAt: '2026-09-08T09:16:00.000Z',
    ...over,
  };
}

describe('pendingBalances — the opening grant', () => {
  it('projects nothing at all without an account', () => {
    expect(
      pendingBalances({ account: null, openingBalanceOnTheWay: true, pendingSends: [] }),
    ).toBe(NO_PENDING_BALANCES);
  });

  it('names both figures the sponsor is about to deposit, instead of two zeros', () => {
    const notes = pendingBalances({ account: account(), openingBalanceOnTheWay: true });
    expect(notes.get(NIGHT_COLOUR_HEX)).toEqual({ value: OPENING_NIGHT, state: 'arriving' });
    expect(notes.get(MUSD)).toEqual({ value: String(OPENING_MUSD), state: 'arriving' });
  });

  it('says the one word, and it is not a sentence', () => {
    expect(PENDING_BALANCE_WORD.arriving).toBe('Arriving');
    expect(PENDING_BALANCE_WORD.transferring).toBe('Transferring');
  });

  it('projects nothing once the grant is no longer on its way', () => {
    expect(pendingBalances({ account: account(), openingBalanceOnTheWay: false }).size).toBe(0);
  });

  it('leaves a leg that has already landed alone, and keeps projecting the other', () => {
    const notes = pendingBalances({
      account: account({ nightBalance: '0.002' }),
      openingBalanceOnTheWay: true,
    });
    expect(notes.has(NIGHT_COLOUR_HEX)).toBe(false);
    expect(notes.get(MUSD)?.value).toBe(String(OPENING_MUSD));
  });

  /* A `null` figure is a read nobody has finished, not an empty account. The
     row already says "Syncing" for that, and replacing it with a grant figure
     would claim the read had come back. */
  it('does not paint a grant figure over a balance that has not been read', () => {
    const notes = pendingBalances({
      account: account({ nightBalance: null }),
      openingBalanceOnTheWay: true,
    });
    expect(notes.has(NIGHT_COLOUR_HEX)).toBe(false);
  });

  it('projects no stablecoin figure where this build knows no stablecoin colour', () => {
    const notes = pendingBalances({
      account: account({ stablecoin: null }),
      openingBalanceOnTheWay: true,
    });
    expect(notes.size).toBe(1);
    expect(notes.has(NIGHT_COLOUR_HEX)).toBe(true);
  });
});

describe('pendingBalances — a send in flight', () => {
  it('keeps the balance the sender will end up with, rather than a zero', () => {
    /* The coin has left: the account reports none of that colour, and the
       change is what is coming back. */
    const notes = pendingBalances({
      account: account({ nightBalance: '0.002', stablecoin: { colourHex: MUSD, amount: 0n } }),
      openingBalanceOnTheWay: false,
      pendingSends: [send()],
    });
    expect(notes.get(MUSD)).toEqual({ value: '90', state: 'transferring' });
  });

  it('never adds the change to a coin the account still reports holding', () => {
    /* The seconds between the first leg being accepted and the read catching
       up. The larger figure is the true one, and the sum would be more money
       than this Passport has ever had. */
    const notes = pendingBalances({
      account: account({ nightBalance: '0.002', stablecoin: { colourHex: MUSD, amount: 100n } }),
      openingBalanceOnTheWay: false,
      pendingSends: [send()],
    });
    expect(notes.get(MUSD)?.value).toBe('100');
  });

  it('holds the figure through every leg the run passes, including one that stopped', () => {
    for (const leg of ['withdraw', 'settle', 'deposit', 'change', 'failed'] as const) {
      const notes = pendingBalances({
        account: account({ nightBalance: '0.002', stablecoin: { colourHex: MUSD, amount: 0n } }),
        openingBalanceOnTheWay: false,
        pendingSends: [send({ leg, lastError: { message: 'stopped', retryable: true } })],
      });
      expect(notes.get(MUSD), leg).toEqual({ value: '90', state: 'transferring' });
    }
  });

  it('projects nothing for a run that has finished', () => {
    const notes = pendingBalances({
      account: account({ nightBalance: '0.002' }),
      openingBalanceOnTheWay: false,
      pendingSends: [send({ leg: 'done' })],
    });
    expect(notes.size).toBe(0);
  });

  it('projects nothing for a run that has not spent anything', () => {
    const { withdrawTxHash: _dropped, ...unspent } = send({ leg: 'withdraw' });
    const notes = pendingBalances({
      account: account({ nightBalance: '0.002', stablecoin: { colourHex: MUSD, amount: 100n } }),
      openingBalanceOnTheWay: false,
      pendingSends: [unspent as PendingSend],
    });
    expect(notes.size).toBe(0);
  });

  it('projects nothing for a payment that was the whole coin, because none comes back', () => {
    const notes = pendingBalances({
      account: account({ nightBalance: '0.002' }),
      openingBalanceOnTheWay: false,
      pendingSends: [send({ amount: '100', withdrawAmount: '100' })],
    });
    expect(notes.size).toBe(0);
  });

  it('leaves NIGHT alone, whose balance simply falls by what was sent', () => {
    const notes = pendingBalances({
      account: account({ nightBalance: '0.001', stablecoin: null }),
      openingBalanceOnTheWay: false,
      pendingSends: [
        send({
          kind: 'night',
          colourHex: NIGHT_COLOUR_HEX,
          tokenType: undefined,
          withdrawAmount: '1000000',
          amount: '1',
        }),
      ],
    });
    expect(notes.has(NIGHT_COLOUR_HEX)).toBe(false);
  });

  it('adds up two runs of the same colour', () => {
    const notes = pendingBalances({
      account: account({ nightBalance: '0.002', stablecoin: { colourHex: MUSD, amount: 0n } }),
      openingBalanceOnTheWay: false,
      pendingSends: [send(), send({ id: 'send-2', amount: '25', withdrawAmount: '50' })],
    });
    expect(notes.get(MUSD)?.value).toBe('115');
  });

  it('reads a colour the account holds outside the stablecoin row', () => {
    const other = 'cd'.repeat(32);
    const notes = pendingBalances({
      account: account({
        nightBalance: '0.002',
        stablecoin: null,
        otherShielded: [{ colourHex: other, amount: 100n }],
      }),
      openingBalanceOnTheWay: false,
      pendingSends: [send({ colourHex: other, tokenType: other })],
    });
    expect(notes.get(other)?.value).toBe('100');
  });

  /* A send is the more recent fact about a colour, and it is the one that
     explains the figure. */
  it('prefers the send over the grant where a colour is both', () => {
    const notes = pendingBalances({
      account: account(),
      openingBalanceOnTheWay: true,
      pendingSends: [send()],
    });
    expect(notes.get(MUSD)).toEqual({ value: '90', state: 'transferring' });
    expect(notes.get(NIGHT_COLOUR_HEX)?.state).toBe('arriving');
  });
});
