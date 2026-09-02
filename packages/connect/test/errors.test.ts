/**
 * The error taxonomy. Both vocabularies are arrays now, both have guards, and
 * every code has exactly one sentence — which is what stops each integrating
 * app keeping its own drifting copy of the sentences and showing a user a bare
 * code wherever it forgot an entry.
 */

import { describe, expect, it } from 'vitest';

import {
  PASSPORT_ERROR_CODES,
  PASSPORT_LOCAL_ERROR_CODES,
  PASSPORT_PROFILE_ERROR_CODES,
  PASSPORT_TX_ERROR_CODES,
  PassportProtocolError,
  isPassportErrorCode,
  isPassportLocalErrorCode,
  isPassportProfileErrorCode,
  isPassportTxErrorCode,
  passportErrorMessage,
} from '../src/protocol/errors.js';

describe('the exported vocabularies', () => {
  it('is the union of the two halves, with nothing lost', () => {
    expect(PASSPORT_ERROR_CODES).toEqual([
      ...PASSPORT_PROFILE_ERROR_CODES,
      ...PASSPORT_TX_ERROR_CODES,
    ]);
    for (const code of PASSPORT_ERROR_CODES) expect(isPassportErrorCode(code)).toBe(true);
  });

  it('keeps the two halves disjoint, so a guard is an answer', () => {
    /* The punctuation differs — `profile_unavailable`, `insufficient-funds` —
       because both spellings are on the wire and already deployed. What
       matters is that no string is in both halves, so `isPassport*ErrorCode`
       actually decides which protocol a code came from. */
    for (const code of PASSPORT_PROFILE_ERROR_CODES) {
      expect(isPassportProfileErrorCode(code)).toBe(true);
      expect(isPassportTxErrorCode(code)).toBe(false);
    }
    for (const code of PASSPORT_TX_ERROR_CODES) {
      expect(isPassportTxErrorCode(code)).toBe(true);
      expect(isPassportProfileErrorCode(code)).toBe(false);
    }
  });

  it('rejects everything else', () => {
    for (const value of ['nope', '', 42, null, undefined, {}]) {
      expect(isPassportErrorCode(value)).toBe(false);
      expect(isPassportLocalErrorCode(value)).toBe(false);
    }
  });

  it('keeps local failures out of the wire vocabulary except where they mean the same thing', () => {
    /* `invalid-request` is deliberately in both: it means the same thing on
       either side of the boundary, and `source` is what tells them apart. */
    const shared = PASSPORT_LOCAL_ERROR_CODES.filter((code) => isPassportErrorCode(code));
    expect(shared).toEqual(['invalid-request']);
  });
});

describe('the sentences', () => {
  it('has one for every code in every vocabulary', () => {
    for (const code of [...PASSPORT_ERROR_CODES, ...PASSPORT_LOCAL_ERROR_CODES]) {
      const message = passportErrorMessage(code);
      expect(message.length).toBeGreaterThan(20);
      /* Never the identifier itself. The punctuated codes are the ones that
         would read as machine output if they leaked into a sentence, so those
         must not appear at all; the single-word ones are ordinary English and
         only have to not BE the whole sentence. */
      if (/[_-]/.test(code)) expect(message).not.toContain(code);
      else expect(message).not.toBe(code);
    }
  });

  it('is total — an unknown code still gets a sentence, not undefined', () => {
    expect(passportErrorMessage('something-nobody-has-shipped')).toMatch(/did not say why/);
  });

  it('says who the fault belongs to where that is knowable', () => {
    expect(passportErrorMessage('invalid_request')).toMatch(/this app’s bug/);
    expect(passportErrorMessage('version_mismatch')).toMatch(/Nothing was shared/);
    expect(passportErrorMessage('version-mismatch')).toMatch(/nothing was paid/);
    expect(passportErrorMessage('popup-blocked')).toMatch(/Allow pop-ups/);
  });
});

describe('PassportProtocolError', () => {
  it('names the protocol it belongs to and keeps the reason readable', () => {
    const profile = new PassportProtocolError('invalid_request', 'fields is empty');
    expect(profile.name).toBe('PassportProtocolError');
    expect(profile.code).toBe('invalid_request');
    expect(profile.reason).toBe('fields is empty');
    expect(profile.message).toMatch(/profile request is not valid: fields is empty/);

    const tx = new PassportProtocolError('invalid-request', 'amount must be greater than zero');
    expect(tx.message).toMatch(/transaction request is not valid/);
  });
});
