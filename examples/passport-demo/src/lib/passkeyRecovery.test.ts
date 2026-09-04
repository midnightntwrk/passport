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
  isMidSessionWayOut,
  KEYLESS_PASSKEY_MESSAGE,
  markMidSessionWayOut,
  MID_SESSION_PASSKEY_MESSAGE,
  midSessionPasskeyMessage,
  PASSKEY_CEREMONY_TIMEOUT_MESSAGE,
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

  it('offers a retry and a way out of the session when the ceremony was mid-session', () => {
    /* The 2026/08/31 report: a session already open, Claim pressed on the name
       step, and the credential is not in this browser's keychain. The screen
       may not offer an enrolment here — a new passkey mid-session is a new
       seed, so it would start a second Passport rather than recover the one
       whose name is on the screen. */
    expect(passkeySignInRecovery({ stage: 'credential', context: 'mid-session' })).toBe(
      'retry-or-sign-out',
    );
  });

  it('offers the same two controls mid-session whatever the platform said', () => {
    /* The one branch that reads neither `reason` nor `timedOut`, because both
       controls are right under every reading: the passkey may be on a phone
       the user is still fetching, in which case trying again and following the
       QR is the answer, and signing out costs nothing either way. */
    for (const reason of [null, 'cancelled', 'prf-missing', 'failed'] as (
      | PasskeyCeremonyReason
      | null
    )[]) {
      expect(
        passkeySignInRecovery({ stage: 'credential', context: 'mid-session', reason }),
      ).toBe('retry-or-sign-out');
    }
  });

  it('still offers the way out mid-session when the watchdog fired', () => {
    /* Photographed on the live name step, 2026/08/31: the watchdog gave up
       beneath a cross-device sheet the user was still working through, and the
       card it produced carried no control at all. Unlike the sign-in path —
       where a timeout has learnt nothing that would justify offering an
       enrolment — the two mid-session controls are safe under a timeout too,
       and it is the timeout a real user hits. */
    expect(
      passkeySignInRecovery({ stage: 'credential', context: 'mid-session', timedOut: true }),
    ).toBe('retry-or-sign-out');
  });

  it('offers nothing new mid-session once the ceremony itself has succeeded', () => {
    /* Past the credential, a mid-session failure is a proof, a submission, or a
       chain read — none of which a passkey control can help with. */
    expect(passkeySignInRecovery({ stage: 'open', context: 'mid-session' })).toBe('none');
  });

  it('reads an absent context as the landing screen, so sign-in is unchanged', () => {
    /* Every existing caller omits it, and the behaviour they were written
       against has to survive the field being added. */
    expect(passkeySignInRecovery({ stage: 'credential', context: 'sign-in' })).toBe('keyless');
    expect(passkeySignInRecovery({ stage: 'credential' })).toBe('keyless');
  });

  it('reads an absent or false timeout flag as "the platform answered"', () => {
    /* The flag is optional at every call site, and the default must be the one
       that still offers a way out. */
    expect(passkeySignInRecovery({ stage: 'credential', timedOut: false })).toBe('keyless');
    expect(passkeySignInRecovery({ stage: 'credential', reason: null })).toBe('keyless');
  });

  it('never answers a PRF-less ENROLMENT with another enrolment', () => {
    /* The Android shape, found by `e2e/android-shapes.spec.ts` on 2026/09/04.
       The platform made the passkey it was asked for and left out the
       extension the wallet seed derives from, so the passkey it makes next
       time is the same passkey — and "create a new passkey" is a button that
       returns the reader to this panel for ever. It is the same `prf-missing`
       the discoverable path reports, and it must NOT reach the same answer. */
    expect(passkeySignInRecovery({ stage: 'enrolment', reason: 'prf-missing' })).toBe(
      'unusable-device',
    );
    expect(passkeySignInRecovery({ stage: 'credential', reason: 'prf-missing' })).toBe(
      'unusable-credential',
    );
  });

  it('leaves every other enrolment failure to the button that was just pressed', () => {
    /* A dismissed sheet or a keystore that was busy has said nothing about
       what this platform can do, so there is nothing to explain and nothing to
       offer that is not already on the screen. */
    expect(passkeySignInRecovery({ stage: 'enrolment', reason: 'cancelled' })).toBe('none');
    expect(passkeySignInRecovery({ stage: 'enrolment', reason: 'failed' })).toBe('none');
    expect(passkeySignInRecovery({ stage: 'enrolment' })).toBe('none');
    /* And the watchdog does not change it either way: an enrolment nobody
       answered is not evidence about the platform's extensions. */
    expect(passkeySignInRecovery({ stage: 'enrolment', timedOut: true })).toBe('none');
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

describe('MID_SESSION_PASSKEY_MESSAGE', () => {
  it('names the QR path before the loss, because the QR path often works', () => {
    /* The screenshot that started this: the OS was showing "Scan QR Code"
       because the passkey is on the user's phone, and that sheet was CORRECT.
       Copy that led with "your passkey is gone" would talk somebody out of the
       thing that was about to work. */
    const qr = MID_SESSION_PASSKEY_MESSAGE.indexOf('QR');
    const gone = MID_SESSION_PASSKEY_MESSAGE.indexOf('gone');
    expect(qr).toBeGreaterThan(-1);
    expect(gone).toBeGreaterThan(qr);
  });

  it('offers a sign-out rather than a new passkey, and says what survives it', () => {
    /* Mid-session, a new passkey is a new seed and therefore a NEW Passport.
       So the offer is different from the landing screen's, and it has to
       account for what happens to the Passport being left: the name and the
       account are on chain, and the local records come back from a file. */
    expect(MID_SESSION_PASSKEY_MESSAGE).toMatch(/sign out/i);
    expect(MID_SESSION_PASSKEY_MESSAGE).toMatch(/stay on chain/);
    expect(MID_SESSION_PASSKEY_MESSAGE).toMatch(/backup file/);
  });

  it('does not claim the passkey is gone, only that it could not be used', () => {
    expect(MID_SESSION_PASSKEY_MESSAGE).toMatch(/could not be used on this device/);
    expect(MID_SESSION_PASSKEY_MESSAGE).not.toMatch(/your passkey (is|was) (gone|deleted)/i);
  });
});

describe('PASSKEY_CEREMONY_TIMEOUT_MESSAGE', () => {
  it('never asserts that no prompt appeared, because the watchdog cannot see one', () => {
    /* The defect in the copy it replaces. "Your device never showed the passkey
       prompt" was photographed underneath a macOS cross-device sheet that had
       been shown — the watchdog fired beneath it and contradicted the user's
       own screen. */
    expect(PASSKEY_CEREMONY_TIMEOUT_MESSAGE).not.toMatch(/never showed/i);
    expect(PASSKEY_CEREMONY_TIMEOUT_MESSAGE).toMatch(/did not finish/);
  });

  it('accounts for the cross-device wait, and keeps the extension hint', () => {
    /* Both causes are real. A QR sign-in takes as long as fetching a phone
       takes, and a wallet extension holding the dialog was observed on
       2026/08/06 — the copy no longer picks one and calls it the truth. */
    expect(PASSKEY_CEREMONY_TIMEOUT_MESSAGE).toMatch(/QR code/);
    expect(PASSKEY_CEREMONY_TIMEOUT_MESSAGE).toMatch(/leave the prompt open/);
    expect(PASSKEY_CEREMONY_TIMEOUT_MESSAGE).toMatch(/extension/);
    expect(PASSKEY_CEREMONY_TIMEOUT_MESSAGE).toMatch(/private window/);
  });
});

describe('midSessionPasskeyMessage', () => {
  it('keeps the watchdog’s own words when the watchdog is what gave up', () => {
    /* A timeout and a refusal are different facts, and only one of them can
       tell somebody to leave the prompt open. Both end at the same controls. */
    expect(midSessionPasskeyMessage({ timedOut: true })).toBe(PASSKEY_CEREMONY_TIMEOUT_MESSAGE);
  });

  it('says the passkey could not be used when the platform is what refused', () => {
    expect(midSessionPasskeyMessage({ timedOut: false })).toBe(MID_SESSION_PASSKEY_MESSAGE);
    expect(midSessionPasskeyMessage({})).toBe(MID_SESSION_PASSKEY_MESSAGE);
  });
});

describe('the mid-session way-out mark', () => {
  it('travels on the error the surfaces already receive', () => {
    /* The mark cannot be a new error class: the failure has to keep arriving as
       whatever the seam downstream already reads — a `PasskeyPresenceError`
       with the code the app transfer protocol maps, for instance. */
    const failure = Object.assign(new Error('nothing was signed'), { code: 'approval-cancelled' });
    expect(isMidSessionWayOut(failure)).toBe(false);
    expect(markMidSessionWayOut(failure)).toBe(failure);
    expect(isMidSessionWayOut(failure)).toBe(true);
    expect(failure.code).toBe('approval-cancelled');
    // And it does not travel where it was never put: not on the wire, not in a
    // structured clone, not in anything that enumerates the error's own keys.
    expect(Object.keys(failure)).toEqual(['code']);
  });

  it('answers false for everything that is not a marked object', () => {
    /* Surfaces call this on whatever `catch` handed them, which is anything. */
    expect(isMidSessionWayOut(null)).toBe(false);
    expect(isMidSessionWayOut(undefined)).toBe(false);
    expect(isMidSessionWayOut('cancelled')).toBe(false);
    expect(isMidSessionWayOut(new Error('ordinary'))).toBe(false);
  });
});
