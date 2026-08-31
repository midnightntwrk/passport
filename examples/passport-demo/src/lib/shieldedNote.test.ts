/**
 * Drills for the note a Passport-to-Passport shielded transfer is joined by.
 *
 * There is one thing being held to account here and it is a way of losing
 * somebody's money: the second leg deposits ONE WHOLE NOTE, so picking a note
 * that merely looks like the right one pays the recipient out of money the
 * sender had put aside and strands the note the transfer actually produced.
 * Every case below is a way that could happen — a note of the same colour and
 * the same size held before the transfer began, a payment arriving from
 * somewhere else mid-transfer, a note whose value is close but not equal — and
 * an assertion that it does not.
 */

import { describe, expect, it } from 'vitest';

import { MUSD_COLOUR_HEX } from './colour.js';
import {
  findArrivedNote,
  shieldedNoteId,
  shieldedNoteIds,
  type WalletShieldedNote,
} from './shieldedNote.js';

const OTHER_COLOUR = 'cd'.repeat(32);
const NONCE_A = '11'.repeat(32);
const NONCE_B = '22'.repeat(32);
const NONCE_C = 'ff'.repeat(32);

function note(
  nonce: string,
  value: bigint,
  tokenType: string = MUSD_COLOUR_HEX,
): WalletShieldedNote {
  return { tokenType, nonce, value };
}

describe('shieldedNoteId', () => {
  it('is the colour and the nonce together, normalised', () => {
    expect(shieldedNoteId(note(NONCE_A, 100n))).toBe(`${MUSD_COLOUR_HEX}:${NONCE_A}`);
  });

  it('reads a 0x prefix and upper case as the same note', () => {
    /* The wallet, the ledger, and a QR code do not agree on either, and a note
       that changed identity between two reads of the same wallet would look
       new — which is exactly what marks a note as this transfer's. */
    const shouted = note(`0x${NONCE_A.toUpperCase()}`, 100n, MUSD_COLOUR_HEX.toUpperCase());
    expect(shieldedNoteId(shouted)).toBe(shieldedNoteId(note(NONCE_A, 100n)));
  });

  it('has none for a note whose colour or nonce is not 32 bytes of hex', () => {
    expect(shieldedNoteId(note(NONCE_A, 100n, 'not-a-colour'))).toBeNull();
    expect(shieldedNoteId(note('short', 100n))).toBeNull();
  });
});

describe('shieldedNoteIds', () => {
  it('collects what the wallet held, and skips what it cannot identify', () => {
    const ids = shieldedNoteIds([
      note(NONCE_A, 100n),
      note(NONCE_B, 5n, OTHER_COLOUR),
      note('short', 1n),
    ]);
    expect(ids.size).toBe(2);
    expect(ids.has(`${MUSD_COLOUR_HEX}:${NONCE_A}`)).toBe(true);
    expect(ids.has(`${OTHER_COLOUR}:${NONCE_B}`)).toBe(true);
  });

  it('is empty for an empty wallet, which is a real answer', () => {
    expect(shieldedNoteIds([]).size).toBe(0);
  });
});

describe('findArrivedNote', () => {
  const held = shieldedNoteIds([note(NONCE_A, 100n)]);

  it('waits — with a null — while nothing new has arrived', () => {
    /* The answer for every poll before the wallet has synced the arrival, which
       is most of them. It is not a failure and the caller's own deadline is
       what decides when a run of these stops being a wait. */
    expect(findArrivedNote([note(NONCE_A, 100n)], {
      tokenType: MUSD_COLOUR_HEX,
      amount: 100n,
      heldBefore: held,
    })).toBeNull();
  });

  it('takes the note the transfer produced, not the identical one held before', () => {
    /* THE DEFECT THIS MODULE EXISTS TO PREVENT. Both notes are 100 of the same
       colour; only one of them is this transfer's, and depositing the other
       pays the recipient out of money the sender had already put aside. */
    const arrived = findArrivedNote([note(NONCE_A, 100n), note(NONCE_B, 100n)], {
      tokenType: MUSD_COLOUR_HEX,
      amount: 100n,
      heldBefore: held,
    });
    expect(arrived?.nonce).toBe(NONCE_B);
  });

  it('refuses a note of the wrong colour, however new and however large', () => {
    expect(findArrivedNote([note(NONCE_B, 100n, OTHER_COLOUR)], {
      tokenType: MUSD_COLOUR_HEX,
      amount: 100n,
      heldBefore: held,
    })).toBeNull();
  });

  it('wants the value EXACTLY, because a note is deposited whole', () => {
    /* A larger note is somebody else's money arriving mid-transfer, and
       depositing it would overpay the recipient out of the sender's balance.
       A smaller one would underpay. Neither is "close enough". */
    for (const value of [99n, 101n]) {
      expect(findArrivedNote([note(NONCE_B, value)], {
        tokenType: MUSD_COLOUR_HEX,
        amount: 100n,
        heldBefore: held,
      })).toBeNull();
    }
  });

  it('never picks a note it cannot identify', () => {
    /* It could not have been in the snapshot either, so it is not "new" — it is
       unreadable, and an unreadable note is not one to build a deposit around. */
    expect(findArrivedNote([note('short', 100n)], {
      tokenType: MUSD_COLOUR_HEX,
      amount: 100n,
      heldBefore: held,
    })).toBeNull();
  });

  it('answers nothing at all when the colour asked about is not a colour', () => {
    expect(findArrivedNote([note(NONCE_B, 100n)], {
      tokenType: 'not-a-colour',
      amount: 100n,
      heldBefore: held,
    })).toBeNull();
  });

  it('gives the same answer whichever order two candidates arrive in', () => {
    /* Two notes of the same colour and the same size, both new — an inbound
       payment landing in the transfer's own window. Either is genuinely this
       sender's note of exactly this size, so there is no wrong one to pick;
       what would be wrong is the answer depending on the wallet's listing
       order, because then two polls could disagree. */
    const candidates = [note(NONCE_B, 100n), note(NONCE_C, 100n)];
    const query = { tokenType: MUSD_COLOUR_HEX, amount: 100n, heldBefore: held };
    expect(findArrivedNote(candidates, query)?.nonce).toBe(NONCE_B);
    expect(findArrivedNote([...candidates].reverse(), query)?.nonce).toBe(NONCE_B);
  });

  it('finds nothing in an empty wallet', () => {
    expect(findArrivedNote([], {
      tokenType: MUSD_COLOUR_HEX,
      amount: 100n,
      heldBefore: held,
    })).toBeNull();
  });
});
