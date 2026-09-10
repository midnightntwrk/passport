/**
 * WHAT A BALANCE WILL BE, WHILE IT IS STILL ON ITS WAY TO BEING IT.
 *
 * Both balance surfaces — Home's strip and the Assets shelf — paint exactly
 * what the account contract's ledger reports. That is the right default and it
 * is wrong twice, in both directions, and both were reported:
 *
 *   1. A PASSPORT THAT HAS JUST BEEN SET UP (issue #19). The name is claimed,
 *      the sponsor has been asked for the opening grant, and until the two
 *      deposits land the ledger honestly reports nothing. The strip therefore
 *      read `NIGHT 0` and `mUSD 0` — which a person reads as "I own nothing",
 *      not as "it is coming". The grant is the sponsor's fixed one, so both
 *      figures are known from the moment there is an account to deposit into,
 *      and there is no reason to show a zero instead of them.
 *
 *   2. A NAME SEND IN PROGRESS (reviewer, 2026/09/08). A shielded payment takes
 *      the WHOLE coin out of the account and puts the remainder back three
 *      transactions later — see `planShieldedSend` in `lib/sendLegs.ts` for why
 *      a partial withdrawal is not an option. Between the first leg landing and
 *      the third, the account genuinely holds none of that colour, so the strip
 *      showed `mUSD 0` for minutes over a Passport that was mid-transfer and
 *      would end up with most of it back. The observed report was exactly that:
 *      the balance showed 0 until the change came back minutes later.
 *
 * Both are the same defect — a figure that is momentarily true and reads as
 * permanent — so both get the same answer: paint the figure the account is
 * ABOUT to hold, and say in one word why it is not the settled one yet.
 * `arriving` for a grant on its way in, `transferring` for a send on its way
 * out and back. The word is what keeps this from being a lie: an unmarked
 * figure claims to be the ledger's, and these two are not.
 *
 * NOTHING HERE IS SPENDABLE. This is a DISPLAY projection and no caller may
 * treat it as a holding: the Send sheet's picker, its "you hold enough" check,
 * and every circuit call read `account` directly and are untouched by this
 * module. Offering a figure that has not arrived as something to send would
 * turn a cosmetic fix into a refused transaction.
 *
 * Pure — no React, no network, no storage. Drilled in `pendingBalances.test.ts`.
 */

import { OPENING_MUSD, OPENING_NIGHT } from './activation.js';
import type { HoldingsSnapshot } from './balanceWatch.js';
import { NIGHT_COLOUR_HEX } from './colour.js';
import { planOfRecord, type PendingSend } from './sendLegs.js';

/** Why a painted figure is not the ledger's own. */
export type PendingBalanceState =
  /** The sponsor's opening grant, asked for and not landed. */
  | 'arriving'
  /** A send that has left the account and has not finished. */
  | 'transferring';

/** The one word each state puts under the figure. */
export const PENDING_BALANCE_WORD: Record<PendingBalanceState, string> = {
  arriving: 'Arriving',
  /**
   * "the copy for the in-between state should simply say Transferring"
   * (reviewer, 2026/09/08). One word, and deliberately not a sentence: it sits
   * under a number in a column of numbers, and anything longer would be read as
   * part of the figure rather than as a note about it.
   */
  transferring: 'Transferring',
};

/** One row's projected figure, and why it is projected. */
export interface PendingBalanceNote {
  /**
   * What to paint INSTEAD of the account's own figure, already on that
   * colour's own scale — the same string the row would have carried, so the
   * screens need no second formatter and cannot disagree with themselves.
   */
  value: string;
  state: PendingBalanceState;
}

/** Keyed by colour, with NIGHT under {@link NIGHT_COLOUR_HEX}. */
export type PendingBalanceNotes = ReadonlyMap<string, PendingBalanceNote>;

/** Nothing is projected. A shared constant so a screen can compare identity. */
export const NO_PENDING_BALANCES: PendingBalanceNotes = new Map();

export interface PendingBalancesInput {
  /** What the account holds right now, or `null` when there is no account. */
  account: HoldingsSnapshot | null;
  /**
   * Whether the sponsor's opening grant is still on its way — the answer
   * `openingBalanceOnTheWay` in `lib/activation.ts` already gives both screens,
   * passed in rather than recomputed so this module and the line under the
   * balances cannot disagree about whether a Passport is still waiting.
   */
  openingBalanceOnTheWay: boolean;
  /** Every unfinished send this Passport has written down. */
  pendingSends?: readonly PendingSend[];
}

/**
 * WHAT IS STILL OUT OF THE ACCOUNT BECAUSE OF A SEND, BY COLOUR.
 *
 * The sender's own change, and only that: the part being paid AWAY is gone for
 * good and belongs in nobody's balance, while the remainder is coming back into
 * this account and is the whole reason the figure on screen dips. A two-leg run
 * — a NIGHT payment, or a shielded one that happened to be the whole coin —
 * has no change at all, so it contributes nothing here and its balance simply
 * falls by what was sent, which is the truth.
 *
 * A run counts from the moment its first leg is ACCEPTED (`withdrawTxHash` is
 * what says so) until it is `done`. A run that has stopped with a reason on it
 * is counted too, and deliberately: the coin is still out of the account, so
 * the figure is still not the settled one, and the card on Home beside these
 * balances is where "it stopped, press Continue" is said. Dropping it here
 * would put the zero back on screen underneath a card explaining why.
 *
 * A run that has never spent — no `withdrawTxHash` — contributes nothing: the
 * account still holds every unit of it, and the figure on screen is already
 * right.
 */
function outstandingChangeByColour(
  records: readonly PendingSend[],
): ReadonlyMap<string, bigint> {
  const out = new Map<string, bigint>();
  for (const record of records) {
    if (record.leg === 'done') continue;
    /* NIGHT never has change. The third leg exists because a shielded
       withdrawal must take the whole coin; a NIGHT payment takes the amount and
       nothing else, so its balance falls by exactly what was sent and that IS
       the settled figure. Guarded rather than assumed because the amounts here
       are a shielded colour's own whole units and NIGHT's are not — a NIGHT
       figure painted on this scale would be off by a million. */
    if (record.colourHex === NIGHT_COLOUR_HEX) continue;
    if (typeof record.withdrawTxHash !== 'string' || record.withdrawTxHash.length === 0) continue;
    const change = planOfRecord(record).change;
    if (change === null || change <= 0n) continue;
    out.set(record.colourHex, (out.get(record.colourHex) ?? 0n) + change);
  }
  return out;
}

/** What the account holds of one colour, as the strip already reads it. */
function heldOf(account: HoldingsSnapshot, colourHex: string): bigint {
  if (account.stablecoin && account.stablecoin.colourHex === colourHex) {
    return account.stablecoin.amount;
  }
  for (const held of account.otherShielded) {
    if (held.colourHex === colourHex) return held.amount;
  }
  return 0n;
}

/**
 * The figures the balance surfaces should paint in place of the ledger's, and
 * the word that goes under each.
 *
 * THE PROJECTION NEVER OVERSTATES, and the way it cannot is worth stating: a
 * transferring colour is painted at `max(held now, change still outstanding)`
 * rather than at their sum. Before the first leg is visible on the ledger the
 * account still reports the whole coin, which is both the larger figure and the
 * true one; after it, the account reports none of that colour and the change is
 * the larger. Adding the two would, for the seconds between the leg being
 * accepted and the read catching up, show a Passport more money than it has
 * ever had — which is the one failure worse than the zero this replaces.
 *
 * The opening grant is projected only over a REAL zero. A `null` NIGHT figure
 * is a read nobody has finished, not an empty account: the row says "Syncing"
 * for that, which is already honest, and replacing it with a grant figure would
 * claim the read had come back. A colour the account already holds some of is
 * left alone for the same reason — its figure is the true one, and the line
 * under the balances is still saying the grant is on its way.
 *
 * A colour that is both is `transferring`: a send in flight is the more recent
 * fact about it, and it is the one that explains the figure.
 */
export function pendingBalances(input: PendingBalancesInput): PendingBalanceNotes {
  const account = input.account;
  if (!account) return NO_PENDING_BALANCES;
  const notes = new Map<string, PendingBalanceNote>();

  if (input.openingBalanceOnTheWay) {
    /* The two figures the sponsor deposits, from the single place they are
       written down — see `lib/activation.ts`. A figure repeated in a screen is
       a figure that drifts from the one actually deposited. */
    if (account.nightBalance === '0') {
      notes.set(NIGHT_COLOUR_HEX, { value: OPENING_NIGHT, state: 'arriving' });
    }
    if (account.stablecoin && account.stablecoin.amount === 0n) {
      notes.set(account.stablecoin.colourHex, {
        value: String(OPENING_MUSD),
        state: 'arriving',
      });
    }
  }

  for (const [colourHex, change] of outstandingChangeByColour(input.pendingSends ?? [])) {
    const held = heldOf(account, colourHex);
    const projected = held > change ? held : change;
    notes.set(colourHex, { value: projected.toString(), state: 'transferring' });
  }

  return notes;
}
