/**
 * Drills for the rule that decides what a failed sign-in OFFERS.
 *
 * What is worth holding to here is not that a function returns one of three
 * strings. It is that no failure of the sign-in path can end with the user
 * holding nothing but an explanation — which is the state this rule was
 * written to abolish — and that it does not overcorrect into offering a new
 * passkey where a new passkey would not help. Each test below is one of those
 * two ways of being wrong.
 */

import { describe, expect, it } from 'vitest';

import {
  KEYLESS_PASSKEY_MESSAGE,
  passkeySignInRecovery,
  type PasskeyCeremonyReason,
} from './passkeyRecovery.js';

describe('passkeySignInRecovery', () => {
  it('offers a new passkey when the ceremony produced no credential', () => {
    /* The reported dead end: local records exist, the keystore cannot produce
       the credential they name, and WebAuthn says only `NotAllowedError`. */
    expect(passkeySignInRecovery({ stage: 'credential' })).toBe('keyless');
  });

  it('treats a dismissed sheet and an empty picker alike, because WebAuthn does', () => {
    /* `cancelled` covers both — the platform reports a picker the user closed
       and a picker with nothing in it as the same error, and refuses to say
       which. A rule that guessed would be guessing on the user's behalf about
       whether their Passport still exists. */
    expect(passkeySignInRecovery({ stage: 'credential', reason: 'cancelled' })).toBe('keyless');
  });

  it('offers a new passkey when the authenticator failed for reasons it will not name', () => {
    expect(passkeySignInRecovery({ stage: 'credential', reason: 'failed' })).toBe('keyless');
  });

  it('routes a credential that answered without PRF to its own panel', () => {
    /* Not `keyless`: something DID answer, it just cannot open a Passport.
       That state already has an explanation of its own, and it is a different
       explanation — the way out happens to be the same button. */
    expect(passkeySignInRecovery({ stage: 'credential', reason: 'prf-missing' })).toBe(
      'unusable-credential',
    );
  });

  it('offers nothing new once a credential has already worked', () => {
    /* A decryption, a seed derivation, or a wallet bring-up failed. The passkey
       is fine; enrolling a second one would leave the first one's Passport
       exactly as unreadable and cost a credential nobody needed. */
    for (const reason of [null, 'cancelled', 'prf-missing', 'failed'] as (
      | PasskeyCeremonyReason
      | null
    )[]) {
      expect(passkeySignInRecovery({ stage: 'open', reason })).toBe('none');
    }
  });

  it('offers nothing new when Passport stopped waiting rather than the platform answering', () => {
    /* The watchdog fires when a wallet extension holds the passkey dialog and
       it never appears. Nothing has been learnt about whether a credential
       exists, so "it may be gone" would be an invention — and the timeout
       carries its own, correct advice. */
    expect(passkeySignInRecovery({ stage: 'credential', timedOut: true })).toBe('none');
    expect(passkeySignInRecovery({ stage: 'credential', reason: 'prf-missing', timedOut: true })).toBe(
      'none',
    );
  });

  it('reads an absent or false timeout flag as "the platform answered"', () => {
    /* The flag is optional at every call site, and the default must be the one
       that still offers a way out. */
    expect(passkeySignInRecovery({ stage: 'credential', timedOut: false })).toBe('keyless');
    expect(passkeySignInRecovery({ stage: 'credential', reason: null })).toBe('keyless');
  });
});

describe('KEYLESS_PASSKEY_MESSAGE', () => {
  it('claims the passkey could not be loaded, never that it is gone', () => {
    /* WebAuthn does not tell us it is gone, so the copy must not say so. */
    expect(KEYLESS_PASSKEY_MESSAGE).toMatch(/Could not load your passkey/);
    expect(KEYLESS_PASSKEY_MESSAGE).not.toMatch(/your passkey (is|was) (gone|deleted)/i);
  });

  it('says what happens to a Passport this browser still holds', () => {
    /* The fear this sentence exists to answer: a user with a second, working
       Passport in the same browser reading "create a new passkey" and assuming
       they are about to lose it. */
    expect(KEYLESS_PASSKEY_MESSAGE).toMatch(/stays untouched/);
  });
});
