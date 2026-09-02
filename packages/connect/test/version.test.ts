/**
 * The version field, and the whole point of it: a mismatch is now
 * DISTINGUISHABLE from an absence and from a malformed message, on both
 * protocols, and it produces a reply rather than a silence.
 */

import { describe, expect, it } from 'vitest';

import {
  PASSPORT_PROTOCOL_VERSION,
  PASSPORT_SUPPORTED_VERSIONS,
  passportParseFailureReason,
  readProtocolVersion,
} from '../src/protocol/version.js';
import {
  PASSPORT_PROFILE_PROTOCOL,
  createPassportProfileErrorResponse,
  parsePassportProfileResponse,
  readPassportProfileReady,
  readPassportProfileRequest,
  readPassportProfileResponse,
} from '../src/protocol/profile.js';
import { PASSPORT_TX_PROTOCOL, readPassportTxRequest } from '../src/protocol/tx.js';

const profileRequest = (patch: Record<string, unknown>): unknown => ({
  protocol: PASSPORT_PROFILE_PROTOCOL,
  type: 'passport.profile.request',
  requestId: 'request-1',
  nonce: 'nonce-1',
  fields: ['displayName'],
  ...patch,
});

describe('readProtocolVersion', () => {
  it('reads an absent version as revision 1', () => {
    /* Every message minted before the field existed is a version 1 message.
       Rejecting them would break the deployment that introduces the field. */
    expect(readProtocolVersion({})).toEqual({ kind: 'ok', version: PASSPORT_PROTOCOL_VERSION });
  });

  it('accepts a supported version and reports an unsupported one as a mismatch', () => {
    expect(readProtocolVersion({ version: 1 })).toEqual({ kind: 'ok', version: 1 });
    expect(readProtocolVersion({ version: 2 })).toEqual({
      kind: 'version-mismatch',
      received: 2,
      supported: PASSPORT_SUPPORTED_VERSIONS,
    });
  });

  it('treats a version that names no revision as malformed, not a mismatch', () => {
    /* `"1"`, `1.5`, `NaN`, `0` and `-1` do not name a revision anybody could
       support, so "we do not speak that one" would be the wrong answer. */
    for (const version of ['1', 1.5, Number.NaN, 0, -1, null]) {
      expect(readProtocolVersion({ version }).kind).toBe('malformed');
    }
  });
});

describe('passportParseFailureReason', () => {
  it('names each of the three outcomes in a sentence somebody can act on', () => {
    expect(passportParseFailureReason({ kind: 'malformed', reason: 'fields is empty' })).toBe(
      'fields is empty',
    );
    expect(
      passportParseFailureReason({ kind: 'version-mismatch', received: 9, supported: [1] }),
    ).toBe('the message is revision 9; this build speaks 1');
    expect(passportParseFailureReason({ kind: 'not-passport' })).toMatch(/not this protocol/);
  });
});

describe('the three outcomes are distinguishable — profile', () => {
  it('says not-passport for something that was never addressed to us', () => {
    /* Silence is right HERE and only here: a page receives messages from
       extensions, analytics, and its own framework, and answering them would
       be noise at best. */
    expect(readPassportProfileRequest({ protocol: 'org.evil/v1' })).toEqual({
      kind: 'not-passport',
    });
    expect(readPassportProfileRequest(null)).toEqual({ kind: 'not-passport' });
    expect(readPassportProfileRequest(profileRequest({ type: 'passport.profile.ready' }))).toEqual({
      kind: 'not-passport',
    });
  });

  it('says version-mismatch, with the number and what we do support', () => {
    const result = readPassportProfileRequest(profileRequest({ version: 9 }));
    expect(result).toEqual({
      kind: 'version-mismatch',
      received: 9,
      supported: PASSPORT_SUPPORTED_VERSIONS,
    });
  });

  it('says malformed, and names the rule that was broken', () => {
    const result = readPassportProfileRequest(profileRequest({ fields: [] }));
    expect(result.kind).toBe('malformed');
    expect(result.kind === 'malformed' && result.reason).toMatch(/fields is empty/);
  });

  it('carries the mismatch through ready and response too', () => {
    expect(
      readPassportProfileReady({
        protocol: PASSPORT_PROFILE_PROTOCOL,
        type: 'passport.profile.ready',
        version: 9,
        requestId: 'r',
        nonce: 'n',
      }).kind,
    ).toBe('version-mismatch');
    expect(
      readPassportProfileResponse({
        protocol: PASSPORT_PROFILE_PROTOCOL,
        type: 'passport.profile.response',
        version: 9,
        requestId: 'r',
        nonce: 'n',
        approved: false,
        error: 'denied',
      }).kind,
    ).toBe('version-mismatch');
  });

  it('gives Passport a reply to send instead of dropping the message', () => {
    /* This is the fix. Before it, a mismatch was a three-minute spinner and
       the caller could not tell it from Passport being absent. */
    const reply = createPassportProfileErrorResponse(
      { requestId: 'request-1', nonce: 'nonce-1' },
      'version_mismatch',
    );
    expect(reply.approved).toBe(false);
    expect(reply.error).toBe('version_mismatch');
    /* And the reply is itself parseable and bound to the pair, so the caller
       can match it to the exchange it was waiting on. */
    const parsed = parsePassportProfileResponse(reply);
    expect(parsed).not.toBeNull();
    expect(parsed!.requestId).toBe('request-1');
    expect(parsed!.nonce).toBe('nonce-1');
  });
});

describe('the three outcomes are distinguishable — transactions', () => {
  const txRequest = (patch: Record<string, unknown>): unknown => ({
    protocol: PASSPORT_TX_PROTOCOL,
    type: 'passport.tx.request',
    requestId: 'request-1',
    nonce: 'nonce-1',
    intent: {
      kind: 'unshielded-transfer',
      recipientAddress: 'mn_addr_stagenet1qq',
      amount: '100000',
      purpose: 'Cover charge',
    },
    ...patch,
  });

  it('separates not-passport, version-mismatch, and malformed', () => {
    expect(readPassportTxRequest({ protocol: 'org.evil/v1' })).toEqual({ kind: 'not-passport' });
    expect(readPassportTxRequest(txRequest({ version: 7 }))).toEqual({
      kind: 'version-mismatch',
      received: 7,
      supported: PASSPORT_SUPPORTED_VERSIONS,
    });
    const malformed = readPassportTxRequest(txRequest({ requestId: '' }));
    expect(malformed.kind).toBe('malformed');
    expect(malformed.kind === 'malformed' && malformed.reason).toMatch(/requestId/);
  });

  it('reports a bad version field as malformed on this protocol too', () => {
    expect(readPassportTxRequest(txRequest({ version: '1' })).kind).toBe('malformed');
  });
});
