/**
 * What a claim's failure card CARRIES — the rule, not the painting.
 *
 * THE DEAD END THIS CLOSES (live acceptance, 2026/09/02).
 * ------------------------------------------------------------------------
 * A Passport reached the end of its ceremony with the account live, and the
 * service then refused the name — a 500 during a forced blackout of the read
 * side. The card said, correctly, that the name had not been registered and
 * was being kept. Then it stopped. There was no control on it at all: no way
 * to run the claim again, and no way to reach the "Register now" the name's
 * own card on Home had been carrying for a fortnight. The user was told their
 * name was safe and given nothing to do about it.
 *
 * The panel that DID carry controls was the passkey one, and only that one —
 * see `screens/PasskeyWayOut.tsx` for the failure it was written for. So the
 * card had two states, one of which was furnished and one of which was not,
 * and which one you got depended on a fault nobody chooses.
 *
 * WHY THE RULE IS HERE AND NOT IN THE SCREEN
 * ------------------------------------------------------------------------
 * There is no jsdom in this workspace, so a `.tsx` cannot be drilled at all —
 * see `vitest.config.ts` for that ruling and its consequences. Every way this
 * card can be wrong is a way of stranding somebody:
 *
 *   - a card with no controls, which is the reported defect;
 *   - BOTH pairs at once, which is two "Try again" buttons on one card and,
 *     in a browser, an ambiguous control;
 *   - a retry offered when there is no name to retry, which can only fail;
 *   - a retry offered while the claim is still running, which is how a second
 *     ceremony gets started on top of the first.
 *
 * A card that has no name and no way home would be the same dead end with more
 * words on it, so the shape is decided here — from the four facts the screen
 * knows — and the screen paints the answer.
 *
 * WHAT THE SECOND CONTROL IS FOR. "Continue to Home" is not a skip. A claim
 * that failed has ALREADY left the name queued (see `claimOrQueueAlias` in
 * `App.tsx`, which persists the record with the failure as its reason), so
 * Home is where that name is waiting with its own "Register now" beside it.
 * The control says where it goes and the label is the whole of it.
 *
 * WHY THERE IS NO NOTE ANY MORE (2026/09/03)
 * ------------------------------------------------------------------------
 * This module used to contribute a sentence of its own — `CLAIM_QUEUED_NOTE`,
 * "Your name is kept for you. Try again now, or carry on to your Passport…" —
 * and with it the card read: a heading with no full stop on it, the service's
 * refusal ("… was not registered. Your name is kept for you and can be
 * registered again."), the host's addition to that ("… the name is kept for you
 * to register again shortly."), and then the note. Three sentences saying the
 * name is kept, and a fourth clause describing the two buttons directly beneath
 * the two buttons.
 *
 * The refusal sentence itself now carries the fact, once — see
 * `aliasRefusalMessage` in `identity/sponsoredAlias.ts` — so the card is a
 * punctuated heading, that one sentence, and the pair. It is also the only
 * shape that stays TRUE for every refusal: a fixed note promising the name is
 * kept was wrong beside "has already been taken", which is the one refusal
 * where it is not.
 *
 * What survives here is the part a screen cannot get right on its own: WHICH
 * pair the card carries, and whether the retry may be pressed.
 */

/** Which pair of controls the failure card carries, if any. */
export type ClaimFailureWay =
  /** No failure on screen. The card is not rendered at all. */
  | 'none'
  /**
   * A passkey ceremony the platform would not complete, on a screen that can
   * leave the session. `PasskeyWayOutActions` — try again, or sign out.
   */
  | 'passkey'
  /**
   * Everything else, which is every refusal the service can make. Try again,
   * or carry on to Home where the name is queued and can be registered.
   */
  | 'queued';

export interface ClaimFailureCard {
  way: ClaimFailureWay;
  /**
   * Whether "Try again" may be pressed. False with no name to claim and false
   * while a claim is running — a control that could only fail, or could start
   * a second ceremony on top of the first, is worse than no control.
   *
   * It governs the retry the CARD owns, which is the `queued` pair's. The
   * `passkey` pair is `screens/PasskeyWayOut.tsx`, whose single busy flag
   * disables its sign-out as well — and a way out that an empty name field
   * could take away would be the dead end again — so that surface passes its
   * own busy through and lets the claim itself refuse a nameless retry. The
   * answer is still computed for both, because it is the same fact either way.
   */
  canRetry: boolean;
}

/**
 * The failure card's shape, from what the screen knows.
 *
 * `passkeyWayOut` without `canSignOut` deliberately falls through to `queued`
 * rather than to nothing: a screen that cannot leave the session can still
 * offer the claim again and the way to Home, and the alternative is the empty
 * card this module exists to remove.
 */
export function claimFailureCard(input: {
  /** The failure sentence the host has already composed, or `null`. */
  error: string | null;
  /** True when the failure was a passkey ceremony rather than the service. */
  passkeyWayOut: boolean;
  /** True when the screen was given a way to leave the session. */
  canSignOut: boolean;
  /** The name the claim was for, or `null` when the field holds nothing. */
  alias: string | null;
  /** True while a claim is running. */
  busy: boolean;
}): ClaimFailureCard {
  if (input.error === null) {
    return { way: 'none', canRetry: false };
  }
  const canRetry = input.alias !== null && !input.busy;
  if (input.passkeyWayOut && input.canSignOut) {
    /* The passkey card says its own two sentences — what the platform could
       not do, and that signing out costs neither the name nor the account. */
    return { way: 'passkey', canRetry };
  }
  return { way: 'queued', canRetry };
}
