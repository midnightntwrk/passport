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
 *   - and the card contributes NO sentence of its own. It carried one until
 *     2026/09/03, beneath a refusal that had already said the name was kept and
 *     a host addition that had said it again — see the module header. The one
 *     sentence on the card is `aliasRefusalMessage`'s, drilled where it is
 *     composed (`identity/sponsoredAlias.test.ts`).
 */

import { describe, expect, it } from 'vitest';

import { claimFailureCard } from './claimFailure.js';

/** The screen's ordinary state, one field at a time overridden per case. */
const card = (over: Partial<Parameters<typeof claimFailureCard>[0]> = {}) =>
  claimFailureCard({
    error: 'alice.night was not registered, and your name is kept for you.',
    passkeyWayOut: false,
    canSignOut: true,
    alias: 'alice',
    busy: false,
    ...over,
  });

describe('claimFailureCard', () => {
  it('renders nothing at all when no claim has failed', () => {
    expect(card({ error: null })).toEqual({ way: 'none', canRetry: false });
  });

  it('gives a service refusal the queued pair, and no third sentence with it', () => {
    /* THE REPORTED DEFECT. The account was live, the service answered 500, and
       this card was the whole of what the user had — with nothing on it. What
       it must NOT come back with is a `note`: the refusal above the pair has
       already said the name is kept, and a card that says it twice more is the
       copy defect fixed on 2026/09/03. */
    expect(card()).toEqual({ way: 'queued', canRetry: true });
  });

  it('gives a passkey ceremony its own pair', () => {
    /* The passkey card carries its own two sentences — what the platform could
       not do, and that signing out keeps the name and the account. */
    expect(card({ passkeyWayOut: true })).toEqual({ way: 'passkey', canRetry: true });
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

  it('contributes no copy of its own, on any answer it can give', () => {
    /* The whole of the 2026/09/03 fix, as an invariant rather than as one
       assertion: whatever the card decides, the only strings on it are the
       heading, the refusal sentence the host composed, and the button labels.
       A `note` reintroduced anywhere here is a third "your name is kept". */
    const answers = [
      card({ error: null }),
      card(),
      card({ passkeyWayOut: true }),
      card({ passkeyWayOut: true, canSignOut: false }),
      card({ alias: null }),
      card({ busy: true }),
    ];
    for (const answer of answers) {
      expect(Object.keys(answer).sort()).toEqual(['canRetry', 'way']);
    }
  });
});
