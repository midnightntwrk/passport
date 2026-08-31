/**
 * Which shielded note a Passport-to-Passport transfer moves, and how it is told
 * apart from every other note the sender already held.
 *
 * WHY THIS EXISTS (2026/08/31)
 * ----------------------------
 * Paying a `.night` name in a shielded asset is two transactions, and the join
 * between them is a single NOTE rather than a colour and an amount. The account
 * contract's deposit side consumes one whole note — it needs that note's own
 * nonce, which only the wallet holds — so the second leg cannot be described by
 * "deposit 100 of this colour". It has to name the exact note the first leg
 * produced.
 *
 * That makes "which note?" a question with a wrong answer, and the wrong answer
 * costs somebody the difference. A wallet that already held 100 of the same
 * colour before the transfer began has two notes matching "100 of this colour"
 * the moment the first leg lands, and depositing the older one would leave the
 * new one stranded and pay the recipient out of money the sender had put aside.
 * Matching on colour and value alone is therefore not a shortcut, it is a bug.
 *
 * So the rule here is IDENTITY, not resemblance. The nonces the wallet holds are
 * recorded before the first leg goes out; the note the second leg deposits is
 * the one whose nonce was not among them. Colour and value are still checked —
 * a note that arrived from somewhere else while this was running is not this
 * transfer's note either — but the nonce is what makes the answer exact.
 *
 * A note whose colour or nonce cannot be read as 32 bytes of hex is never
 * matched and never counted as already held. Both halves of that fail CLOSED:
 * an unreadable note is not deposited, and its absence from the "already held"
 * set cannot make some other note look new, because it could not have been
 * picked either way.
 *
 * Nothing here touches the DOM, React, the network, or the wallet SDK. The
 * wallet is the only place these notes exist and `identity/accountCustody.ts`
 * is the only place they are read from; this module is handed the answer and
 * decides what it means, which is why the rule is drilled directly in
 * `src/lib/shieldedNote.test.ts` rather than through a transfer.
 */

import { normalisedColourHex } from './colour.js';

/*
 * A nonce is 32 bytes of hex, exactly as a colour is, so it goes through the
 * same normaliser rather than a second copy of the same regular expression —
 * two copies being two places for the same rule to drift. The alias is here so
 * a reader of {@link shieldedNoteId} is not left wondering why a nonce is being
 * asked a question about colours.
 */
const normalisedNonce = normalisedColourHex;

/**
 * One shielded note the sending wallet holds, in the only three fields that
 * decide anything here.
 *
 * `tokenType` is the raw ledger colour, `nonce` is that note's own nonce, and
 * `value` is its whole value in that colour's atomic units. A note is spent or
 * deposited WHOLE, so `value` is not an amount that can be drawn down — it is
 * the size of the thing itself.
 */
export interface WalletShieldedNote {
  readonly tokenType: string;
  readonly nonce: string;
  readonly value: bigint;
}

/**
 * A note's identity, or `null` when it has none this module can use.
 *
 * The colour is part of the identity as well as the nonce. A nonce is unique in
 * practice, but the pair costs nothing and means a malformed half can never
 * make two different notes collide into one key.
 */
export function shieldedNoteId(note: WalletShieldedNote): string | null {
  const colour = normalisedColourHex(note.tokenType);
  const nonce = normalisedNonce(note.nonce);
  if (colour === null || nonce === null) return null;
  return `${colour}:${nonce}`;
}

/**
 * The identities of every note in a list — the snapshot taken BEFORE the first
 * leg goes out, and the thing the arrival is checked against.
 *
 * Notes with no usable identity are simply absent, which is safe for the reason
 * the module header gives: they could not be picked either.
 */
export function shieldedNoteIds(notes: readonly WalletShieldedNote[]): Set<string> {
  const ids = new Set<string>();
  for (const note of notes) {
    const id = shieldedNoteId(note);
    if (id !== null) ids.add(id);
  }
  return ids;
}

/** What the second leg is looking for. */
export interface ArrivedNoteQuery {
  /** The colour the transfer is in. */
  tokenType: string;
  /** The transfer amount, which the arriving note's value must equal EXACTLY. */
  amount: bigint;
  /** Every note identity the wallet held before the first leg was submitted. */
  heldBefore: ReadonlySet<string>;
}

/**
 * The note the first leg produced, or `null` while it has not arrived.
 *
 * `null` is not a failure — it is the answer for every poll before the wallet
 * has synced the arrival, which is most of them. The caller's own deadline
 * decides when a run of `null`s stops being a wait and starts being a refusal.
 *
 * EXACT VALUE, not "at least". The first leg is submitted for precisely the
 * transfer amount so that the note it produces can be deposited whole; a larger
 * note is somebody else's money arriving mid-transfer and depositing it would
 * overpay the recipient out of the sender's balance.
 *
 * When two notes somehow qualify — an inbound payment of the same colour and
 * the same value landing in the same window — the one with the lower identity
 * is taken, so the answer is the same on every poll rather than depending on
 * the order the wallet happened to list its notes in. Either is genuinely this
 * sender's note of exactly this size, so there is no wrong one to pick; what
 * would be wrong is being unable to say which was chosen.
 */
export function findArrivedNote(
  notes: readonly WalletShieldedNote[],
  query: ArrivedNoteQuery,
): WalletShieldedNote | null {
  const wanted = normalisedColourHex(query.tokenType);
  if (wanted === null) return null;
  let best: { id: string; note: WalletShieldedNote } | null = null;
  for (const note of notes) {
    if (note.value !== query.amount) continue;
    if (normalisedColourHex(note.tokenType) !== wanted) continue;
    const id = shieldedNoteId(note);
    if (id === null || query.heldBefore.has(id)) continue;
    if (best === null || id < best.id) best = { id, note };
  }
  return best === null ? null : best.note;
}
