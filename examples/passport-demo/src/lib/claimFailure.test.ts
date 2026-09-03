/**
 * Drills for the failure card's rule.
 *
 * What is worth holding to here is not that a function returns a string. It is
 * that a person whose claim did not complete is never left with a card they
 * cannot act on, and never given a control that could only make things worse:
 *
 *   - every failure carries a pair of controls, including the one the reported
 *     defect produced (the service refusing after the account was live);
 *   - exactly one pair, never both, because two "Try again" buttons on one card
 *     is an ambiguous control in a real browser;
 *   - no retry with no name to claim, and none while a claim is running;
 *   - the queued card says where the name went, in words that name none of the
 *     machinery the claim screen's vocabulary sweep refuses.
 */

import { describe, expect, it } from 'vitest';

import { CLAIM_QUEUED_NOTE, claimFailureCard } from './claimFailure.js';

/** The screen's ordinary state, one field at a time overridden per case. */
const card = (over: Partial<Parameters<typeof claimFailureCard>[0]> = {}) =>
  claimFailureCard({
    error: 'alice.night was not registered. Your name is kept for you and can be registered again.',
    passkeyWayOut: false,
    canSignOut: true,
    alias: 'alice',
    busy: false,
    ...over,
  });

describe('claimFailureCard', () => {
  it('renders nothing at all when no claim has failed', () => {
    expect(card({ error: null })).toEqual({ way: 'none', canRetry: false, note: null });
  });

  it('gives a service refusal the queued pair and the sentence that says where the name is', () => {
    /* THE REPORTED DEFECT. The account was live, the service answered 500, and
       this card was the whole of what the user had — with nothing on it. */
    expect(card()).toEqual({ way: 'queued', canRetry: true, note: CLAIM_QUEUED_NOTE });
  });

  it('gives a passkey ceremony its own pair, and does not repeat the note', () => {
    /* The passkey card carries its own two sentences — what the platform could
       not do, and that signing out keeps the name and the account — so a third
       one here would say the same thing a second time. */
    expect(card({ passkeyWayOut: true })).toEqual({
      way: 'passkey',
      canRetry: true,
      note: null,
    });
  });

  it('never offers both pairs for one failure', () => {
    /* Not an assertion about a value: it is the invariant that keeps two "Try
       again" buttons off one card. `way` is one of three, so asking for the
       passkey pair is asking not to have the queued one. */
    expect(card({ passkeyWayOut: true }).way).not.toBe('queued');
    expect(card().way).not.toBe('passkey');
  });

  it('falls through to the queued pair when the screen cannot leave the session', () => {
    /* A passkey failure on a surface with no sign-out used to render NOTHING —
       the empty card again, by a different route. Try again and the way to
       Home are both still true here, so both are still offered. */
    expect(card({ passkeyWayOut: true, canSignOut: false })).toEqual({
      way: 'queued',
      canRetry: true,
      note: CLAIM_QUEUED_NOTE,
    });
  });

  it('refuses a retry with no name to claim', () => {
    expect(card({ alias: null }).canRetry).toBe(false);
    expect(card({ alias: null, passkeyWayOut: true }).canRetry).toBe(false);
  });

  it('refuses a retry while a claim is running', () => {
    /* A second ceremony started on top of the first is the one way this card
       can cost somebody more than it gives them. */
    expect(card({ busy: true }).canRetry).toBe(false);
    expect(card({ busy: true, passkeyWayOut: true }).canRetry).toBe(false);
  });

  it('names none of the machinery in the sentence it puts on screen', () => {
    /* The same sweep `e2e/claim-progress.spec.ts` makes over the whole screen,
       made here over the one sentence this module contributes to it. */
    for (const word of [/\bcontract\b/i, /\bresolver\b/i, /\bregistry\b/i, /\bindexer\b/i, /\bwallet\b/i, /\bDUST\b/]) {
      expect(CLAIM_QUEUED_NOTE).not.toMatch(word);
    }
    // And it does say the two things a reader can act on.
    expect(CLAIM_QUEUED_NOTE).toMatch(/kept for you/i);
    expect(CLAIM_QUEUED_NOTE).toMatch(/registered whenever you like/i);
  });
});
