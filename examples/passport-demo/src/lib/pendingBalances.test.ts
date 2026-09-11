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

/* -------------------------------------------------------------------------- */
/* A one-transaction transfer in flight                                        */
/* -------------------------------------------------------------------------- */

/**
 * The one-leg send of 5 out of a 45-unit coin: the recipient gets 5, the
 * circuit persists 40 in the same transaction, and nobody moves anything
 * afterwards.
 *
 * There is no dip to cover here — the account never holds none of the colour —
 * so what is being drilled is the other half: that the figure on screen shows
 * where this account is GOING while the transfer is in flight, and that it
 * never overstates, never understates, and never falls to a zero the account
 * was never at.
 */
function transfer(over: Partial<PendingSend> = {}): PendingSend {
  return send({
    id: 'transfer-1',
    kind: 'transfer',
    amount: '5',
    withdrawAmount: '45',
    leg: 'pay',
    ...over,
  });
}

describe('pendingBalances — a one-transaction transfer', () => {
  it('projects held − amount, with the word on it, before the read catches up', () => {
    /* The transaction is accepted and the ledger still reports the coin it was
       built against. `45` is true, `40` is where this account is going, and the
       larger is painted — so the figure only ever falls. */
    const notes = pendingBalances({
      account: account({ stablecoin: { colourHex: MUSD, amount: 45n } }),
      openingBalanceOnTheWay: false,
      pendingSends: [transfer()],
    });
    expect(notes.get(MUSD)).toEqual({ value: '45', state: 'transferring' });
    expect(PENDING_BALANCE_WORD.transferring).toBe('Transferring');
  });

  it('settles on held − amount once the ledger has the transfer', () => {
    const notes = pendingBalances({
      account: account({ stablecoin: { colourHex: MUSD, amount: 40n } }),
      openingBalanceOnTheWay: false,
      pendingSends: [transfer()],
    });
    expect(notes.get(MUSD)).toEqual({ value: '40', state: 'transferring' });
  });

  it('NEVER paints a zero over a transfer that leaves something behind', () => {
    /* THE DEFECT THIS EXISTS FOR, on the other path: a two-leg run takes the
       whole coin out and the account really does hold none of the colour for
       minutes. A one-leg run never does — and the projection must not invent
       that state for it either, whatever a momentary read says. */
    for (const held of [45n, 40n, 0n]) {
      const notes = pendingBalances({
        account: account({ stablecoin: { colourHex: MUSD, amount: held } }),
        openingBalanceOnTheWay: false,
        pendingSends: [transfer()],
      });
      expect(notes.get(MUSD)?.value).not.toBe('0');
    }
  });

  it('projects nothing before the transfer has been submitted', () => {
    /* Nothing has been spent, so the ledger's own figure is already the right
       one and a word on it would be a note about something that is not
       happening. */
    const notes = pendingBalances({
      account: account({ stablecoin: { colourHex: MUSD, amount: 45n } }),
      openingBalanceOnTheWay: false,
      pendingSends: [transfer({ withdrawTxHash: undefined })],
    });
    expect(notes.has(MUSD)).toBe(false);
  });

  it('projects nothing once it is done', () => {
    const notes = pendingBalances({
      account: account({ stablecoin: { colourHex: MUSD, amount: 40n } }),
      openingBalanceOnTheWay: false,
      pendingSends: [transfer({ leg: 'done' })],
    });
    expect(notes.has(MUSD)).toBe(false);
  });

  it('projects nothing when the payment was the whole coin', () => {
    /* Nothing is left, and `0` is then the settled figure rather than a
       momentary one — so the strip paints the ledger's own answer with no word
       on it, which is the truth. */
    const notes = pendingBalances({
      account: account({ stablecoin: { colourHex: MUSD, amount: 0n } }),
      openingBalanceOnTheWay: false,
      pendingSends: [transfer({ amount: '45', withdrawAmount: '45' })],
    });
    expect(notes.has(MUSD)).toBe(false);
  });

  it("leaves yesterday's two-leg projection exactly as it was", () => {
    /* The same colour, the same figures, the two-leg kind: the whole coin is
       out of the account, the ledger reports none of it, and the change is what
       is painted. Nothing about the one-leg branch may move this. */
    const notes = pendingBalances({
      account: account({ stablecoin: { colourHex: MUSD, amount: 0n } }),
      openingBalanceOnTheWay: false,
      pendingSends: [send()],
    });
    expect(notes.get(MUSD)).toEqual({ value: '90', state: 'transferring' });
  });
});
