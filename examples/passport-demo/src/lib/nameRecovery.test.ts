/**
 * Drills for the rule that decides whether somebody still has a Passport.
 *
 * What is worth holding to here is one distinction, and it is the reason the
 * module exists at all: "that account is not yours" and "we could not ask" are
 * different sentences, and the first must never be said on the strength of the
 * second. A chain read that throws is an indexer having a bad minute; a device
 * set that does not contain this passkey is a different Passport. Collapse them
 * — which any `catch { return false }` around the read would — and a person on
 * a poor connection is told their identity is gone.
 *
 * The second thing held to is that a NAME PROVES NOTHING. It is public, in a
 * registry anybody can read, so it can only ever say which account to look at.
 * Nothing below returns `found` on the strength of a resolution.
 */

import { describe, expect, it } from 'vitest';

import {
  nameOwnershipOutcome,
  nameRecoveryStillOpening,
  nameResolutionOutcome,
  normaliseNameForRecovery,
  registryUnavailableFor,
  unreachableBecause,
  type ResolvedName,
} from './nameRecovery.js';

const RESOLVER = 'dd'.repeat(32);
const ACCOUNT = 'ab'.repeat(32);

function resolvedTo(kind: ResolvedName['target']['kind']): ResolvedName {
  return { resolverAddress: RESOLVER, target: { kind, hex: ACCOUNT } };
}

describe('nameRecoveryStillOpening', () => {
  it('asks the reader to try again rather than reporting a fault', () => {
    /* An ordinary state a second away from resolving itself. It must never
       read as "that is not your Passport", which is the other thing a failure
       here could be mistaken for. */
    expect(nameRecoveryStillOpening()).toEqual({
      kind: 'unreachable',
      detail: 'Your Passport is still opening. Try again in a moment.',
    });
  });
});

describe('registryUnavailableFor', () => {
  it('lets the look-up run on a network with a registry', () => {
    expect(registryUnavailableFor('stagenet', ['stagenet', 'preview'])).toBeNull();
  });

  it('says which network it cannot read a registry for', () => {
    /* Named, because "it did not work" on a network Passport was never able to
       read is the kind of message that sends somebody looking for a problem
       with their phone. */
    expect(registryUnavailableFor('devnet', ['stagenet', 'preview'])).toEqual({
      kind: 'unreachable',
      detail: 'Passport cannot read the devnet registry from here.',
    });
  });
});

describe('nameResolutionOutcome', () => {
  it('carries on when the name resolves to an account-custody contract', () => {
    /* `null` is "keep going". A resolution is the QUESTION answered, not the
       ownership proof, and nothing is restored on it. */
    expect(nameResolutionOutcome(resolvedTo('contract'))).toBeNull();
  });

  it('says a name the registry does not hold is unknown', () => {
    expect(nameResolutionOutcome(null)).toEqual({ kind: 'unknown' });
  });

  it('treats a name bound to anything but an account as not the user\'s', () => {
    /* Passport binds names to account-custody contracts. A name pointing at a
       bare wallet address or a shielded key is somebody else's arrangement,
       and there is nothing here this app could open even if it tried — so it
       is the same answer as a Passport that is not yours, rather than a fourth
       one nobody could act on differently. */
    expect(nameResolutionOutcome(resolvedTo('wallet'))).toEqual({ kind: 'not-yours' });
    expect(nameResolutionOutcome(resolvedTo('shielded'))).toEqual({ kind: 'not-yours' });
  });
});

describe('nameOwnershipOutcome', () => {
  it('hands back the account only once the chain has said the device is on it', () => {
    expect(nameOwnershipOutcome(resolvedTo('contract'), true)).toEqual({
      kind: 'found',
      address: ACCOUNT,
      resolverAddress: RESOLVER,
    });
  });

  it('refuses an account this passkey is not a device on', () => {
    /* The whole security of the path. Knowing a name gets an attacker to
       exactly here and no further: the device set inside the contract is what
       answers, and it answers on chain. */
    expect(nameOwnershipOutcome(resolvedTo('contract'), false)).toEqual({ kind: 'not-yours' });
  });
});

describe('unreachableBecause', () => {
  it('carries the failure\'s own words', () => {
    expect(unreachableBecause(new Error('the indexer timed out'))).toEqual({
      kind: 'unreachable',
      detail: 'the indexer timed out',
    });
  });

  it('carries a thrown value that is not an Error', () => {
    /* Some browsers and some SDKs throw bare strings. The reason must still
       reach the screen as words rather than as "[object Object]". */
    expect(unreachableBecause('NetworkError')).toEqual({
      kind: 'unreachable',
      detail: 'NetworkError',
    });
  });

  it('is never a `not-yours`, whatever was thrown', () => {
    /* Stated as its own test because this is the invariant the module exists
       for: a question that could not be put never becomes an answer of no. */
    expect(unreachableBecause(new Error('boom')).kind).toBe('unreachable');
  });
});

describe('normaliseNameForRecovery', () => {
  it('takes the name as the registry holds it', () => {
    expect(normaliseNameForRecovery('alice')).toBe('alice');
  });

  it('takes the whole name a person will reasonably type', () => {
    /* Every surface in the app shows `alice.night`, so that is what somebody
       reads off their own Home screen and types back in. A lookup that failed
       on it would be the app punishing a person for believing it. */
    expect(normaliseNameForRecovery('alice.night')).toBe('alice');
    expect(normaliseNameForRecovery('Alice.NIGHT')).toBe('alice');
  });

  it('takes a name pasted with space around it', () => {
    /* A name copied out of a message carries it, and a failure on an invisible
       character is indisputably the app's fault and completely opaque. */
    expect(normaliseNameForRecovery('  alice.night  ')).toBe('alice');
    expect(normaliseNameForRecovery(' alice .night')).toBe('alice');
  });

  it('leaves nothing to look up when nothing was typed', () => {
    expect(normaliseNameForRecovery('   ')).toBe('');
    expect(normaliseNameForRecovery('.night')).toBe('');
  });
});
