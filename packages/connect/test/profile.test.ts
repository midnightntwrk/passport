/**
 * Moved here with the code, from `demo-backend/test/profile.test.ts`. The
 * cases that were about `midnightAddresses` are gone with the field; the ones
 * about caps, partial profiles, and pair binding are unchanged, because none
 * of those rules changed.
 */

import { describe, expect, it } from 'vitest';

import {
  PASSPORT_PROFILE_FIELDS,
  PASSPORT_PROFILE_PROTOCOL,
  createPassportProfileHello,
  createPassportProfileReady,
  createPassportProfileRequest,
  createPassportProfileResponse,
  isPassportProfileField,
  pairOfUnreadableMessage,
  parsePassportProfileHello,
  parsePassportProfileReady,
  parsePassportProfileRequest,
  parsePassportProfileResponse,
  readPassportProfileRequest,
} from '../src/protocol/profile.js';
import { PassportProtocolError } from '../src/protocol/errors.js';
import { PASSPORT_PROTOCOL_VERSION } from '../src/protocol/version.js';

describe('Passport profile exchange', () => {
  it('accepts a nonce-bound allowlisted request', () => {
    const request = parsePassportProfileRequest({
      protocol: PASSPORT_PROFILE_PROTOCOL,
      type: 'passport.profile.request',
      version: 1,
      requestId: 'request-1',
      nonce: 'nonce-1',
      fields: ['displayName', 'passportContract'],
    });

    expect(request).toEqual({
      protocol: PASSPORT_PROFILE_PROTOCOL,
      type: 'passport.profile.request',
      version: 1,
      requestId: 'request-1',
      nonce: 'nonce-1',
      fields: ['displayName', 'passportContract'],
    });
  });

  it('rejects unknown, duplicated, or empty fields', () => {
    for (const fields of [['privateState'], [], ['displayName', 'displayName'], 'displayName']) {
      expect(
        parsePassportProfileRequest({
          protocol: PASSPORT_PROFILE_PROTOCOL,
          type: 'passport.profile.request',
          requestId: 'request-1',
          nonce: 'nonce-1',
          fields,
        }),
      ).toBeNull();
    }
  });

  it('no longer carries midnightAddresses in either direction', () => {
    /* The field was ruled a signing detail no dApp has a legitimate use for.
       An app that still asks for it is refused — and, since the refusal is now
       reported rather than dropped, refused audibly. */
    expect(PASSPORT_PROFILE_FIELDS).toEqual(['displayName', 'passportContract']);
    expect(isPassportProfileField('midnightAddresses')).toBe(false);

    const asked = readPassportProfileRequest({
      protocol: PASSPORT_PROFILE_PROTOCOL,
      type: 'passport.profile.request',
      requestId: 'request-1',
      nonce: 'nonce-1',
      fields: ['displayName', 'midnightAddresses'],
    });
    expect(asked.kind).toBe('malformed');

    /* And a reply that tries to smuggle it back parses without it, rather than
       handing an app a shape this protocol does not describe. */
    const answered = parsePassportProfileResponse({
      protocol: PASSPORT_PROFILE_PROTOCOL,
      type: 'passport.profile.response',
      requestId: 'request-1',
      nonce: 'nonce-1',
      approved: true,
      profile: {
        displayName: 'Bubbles',
        midnightAddresses: { unshielded: 'mn_addr_1' },
      },
    });
    expect(answered).not.toBeNull();
    expect(Object.keys(answered!.profile!)).toEqual(['displayName']);
  });

  it('binds ready, hello, and response messages to the request', () => {
    const request = parsePassportProfileRequest({
      protocol: PASSPORT_PROFILE_PROTOCOL,
      type: 'passport.profile.request',
      requestId: 'request-1',
      nonce: 'nonce-1',
      fields: ['displayName'],
    })!;

    expect(createPassportProfileReady(request.requestId, request.nonce)).toMatchObject({
      requestId: 'request-1',
      nonce: 'nonce-1',
    });
    expect(
      createPassportProfileResponse(request, {
        approved: true,
        profile: { displayName: 'Bubbles' },
      }),
    ).toMatchObject({
      requestId: 'request-1',
      nonce: 'nonce-1',
      approved: true,
    });
    expect(
      parsePassportProfileReady(createPassportProfileReady(request.requestId, request.nonce)),
    ).not.toBeNull();
    expect(
      parsePassportProfileResponse(
        createPassportProfileResponse(request, { approved: false, error: 'denied' }),
      ),
    ).not.toBeNull();
  });

  const approvedResponse = (profile: unknown): unknown => ({
    protocol: PASSPORT_PROFILE_PROTOCOL,
    type: 'passport.profile.response',
    requestId: 'request-1',
    nonce: 'nonce-1',
    approved: true,
    profile,
  });

  it('holds the string caps: 256 for names, 512 for addresses', () => {
    /* The caps are the only thing standing between a hostile app and megabytes
       of text in Passport's UI, so both boundaries are pinned: the last
       accepted length and the first refused one. */
    expect(
      parsePassportProfileResponse(approvedResponse({ displayName: 'n'.repeat(256) })),
    ).not.toBeNull();
    expect(
      parsePassportProfileResponse(approvedResponse({ displayName: 'n'.repeat(257) })),
    ).toBeNull();

    expect(
      parsePassportProfileResponse(
        approvedResponse({ passportContract: { address: 'c'.repeat(512), network: 'stagenet' } }),
      ),
    ).not.toBeNull();
    expect(
      parsePassportProfileResponse(
        approvedResponse({ passportContract: { address: 'c'.repeat(513), network: 'stagenet' } }),
      ),
    ).toBeNull();
    /* A contract network is a short name, so it takes the 256 cap, not 512. */
    expect(
      parsePassportProfileResponse(
        approvedResponse({ passportContract: { address: 'mn_shield_1', network: 'n'.repeat(257) } }),
      ),
    ).toBeNull();
  });

  it('rejects a malformed profile rather than handing back a partial one', () => {
    /* A declared field that is present but the wrong shape is not something to
       silently drop: the app would be told the field was withheld when in fact
       it was mangled. Every case below must produce null, not a profile with
       the bad member missing. */
    for (const profile of [
      undefined,
      null,
      'displayName=Bubbles',
      [],
      { displayName: '' },
      { displayName: 42 },
      { passportContract: { address: 'mn_shield_1' } },
      { passportContract: { address: 'mn_shield_1', network: '' } },
      { passportContract: 'mn_shield_1' },
    ]) {
      expect(parsePassportProfileResponse(approvedResponse(profile))).toBeNull();
    }
  });

  it('keeps only declared profile fields on an approved reply', () => {
    const parsed = parsePassportProfileResponse(
      approvedResponse({
        displayName: 'Bubbles',
        passportContract: { address: 'mn_shield_1', network: 'stagenet', secret: 'nope' },
        privateState: 'nope',
      }),
    );
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!.profile!)).toEqual(['displayName', 'passportContract']);
    expect(Object.keys(parsed!.profile!.passportContract!)).toEqual(['address', 'network']);
    expect(parsed).not.toHaveProperty('error');
  });

  it('rejects a refusal that names no known code, and accepts the four that exist', () => {
    for (const error of ['denied', 'profile_unavailable', 'invalid_request', 'version_mismatch']) {
      expect(
        parsePassportProfileResponse({
          protocol: PASSPORT_PROFILE_PROTOCOL,
          type: 'passport.profile.response',
          requestId: 'request-1',
          nonce: 'nonce-1',
          approved: false,
          error,
        }),
      ).not.toBeNull();
    }
    for (const error of [undefined, 'nope', 42, 'declined']) {
      expect(
        parsePassportProfileResponse({
          protocol: PASSPORT_PROFILE_PROTOCOL,
          type: 'passport.profile.response',
          requestId: 'request-1',
          nonce: 'nonce-1',
          approved: false,
          error,
        }),
      ).toBeNull();
    }
  });

  it('rejects the wrong protocol, the wrong type, non-records, and bad pairs', () => {
    const base = {
      protocol: PASSPORT_PROFILE_PROTOCOL,
      type: 'passport.profile.response',
      requestId: 'request-1',
      nonce: 'nonce-1',
      approved: false,
      error: 'denied',
    };
    expect(parsePassportProfileResponse({ ...base, protocol: 'org.evil/v1' })).toBeNull();
    expect(parsePassportProfileResponse({ ...base, type: 'passport.profile.request' })).toBeNull();
    expect(parsePassportProfileResponse({ ...base, approved: 'false' })).toBeNull();
    expect(parsePassportProfileResponse({ ...base, requestId: '' })).toBeNull();
    expect(parsePassportProfileResponse({ ...base, nonce: 'n'.repeat(257) })).toBeNull();
    expect(parsePassportProfileResponse(null)).toBeNull();
    expect(parsePassportProfileResponse([base])).toBeNull();
    expect(parsePassportProfileResponse('passport.profile.response')).toBeNull();

    expect(parsePassportProfileRequest({ ...base, type: 'passport.profile.request' })).toBeNull();
    expect(
      parsePassportProfileReady({
        protocol: PASSPORT_PROFILE_PROTOCOL,
        type: 'passport.profile.ready',
        requestId: 'r',
      }),
    ).toBeNull();
    expect(
      parsePassportProfileReady({
        protocol: PASSPORT_PROFILE_PROTOCOL,
        type: 'passport.profile.ready',
        requestId: '',
        nonce: 'n',
      }),
    ).toBeNull();
    expect(parsePassportProfileReady({ protocol: 'org.evil/v1' })).toBeNull();
  });
});

describe('the request factory that did not exist', () => {
  it('builds a valid request and stamps the version', () => {
    const request = createPassportProfileRequest({
      requestId: 'request-1',
      nonce: 'nonce-1',
      fields: ['displayName'],
    });
    expect(request).toEqual({
      protocol: PASSPORT_PROFILE_PROTOCOL,
      type: 'passport.profile.request',
      version: PASSPORT_PROTOCOL_VERSION,
      requestId: 'request-1',
      nonce: 'nonce-1',
      fields: ['displayName'],
    });
    expect(parsePassportProfileRequest(request)).toEqual(request);
  });

  it('refuses to build an invalid one, at the call site, naming the rule', () => {
    /* The old failure mode: the literal went out, Passport's parser dropped
       it, no reply came back, and the developer watched a spinner for three
       minutes. A throw here is the entire fix. */
    expect(() =>
      createPassportProfileRequest({ requestId: '', nonce: 'n', fields: ['displayName'] }),
    ).toThrow(PassportProtocolError);
    expect(() =>
      createPassportProfileRequest({ requestId: 'r', nonce: 'n', fields: [] }),
    ).toThrow(/fields is empty/);
    expect(() =>
      createPassportProfileRequest({
        requestId: 'r',
        nonce: 'n',
        // @ts-expect-error — a field this protocol does not carry is the case.
        fields: ['midnightAddresses'],
      }),
    ).toThrow(/duplicate-free subset/);
    expect(() =>
      createPassportProfileRequest({ requestId: 'r', nonce: 'n'.repeat(257), fields: ['displayName'] }),
    ).toThrow(/nonce/);
  });

  it('carries the wire code the refusal would have had', () => {
    try {
      createPassportProfileRequest({ requestId: 'r', nonce: 'n', fields: [] });
      expect.unreachable('the factory must refuse an empty field list');
    } catch (cause) {
      expect(cause).toBeInstanceOf(PassportProtocolError);
      expect((cause as PassportProtocolError).code).toBe('invalid_request');
    }
  });
});

describe('createPassportProfileReady', () => {
  it('refuses to mint a handshake with half a pair', () => {
    expect(() => createPassportProfileReady('', 'n')).toThrow(PassportProtocolError);
    expect(() => createPassportProfileReady('r', '')).toThrow(/non-empty request id and nonce/);
  });
});

describe('passport.profile.hello — a real message now, not a magic string', () => {
  it('round-trips a cold hello and a pair-echoing one', () => {
    const cold = createPassportProfileHello();
    expect(cold).toEqual({
      protocol: PASSPORT_PROFILE_PROTOCOL,
      type: 'passport.profile.hello',
      version: PASSPORT_PROTOCOL_VERSION,
    });
    expect(parsePassportProfileHello(cold)).toEqual(cold);

    const echo = createPassportProfileHello({ requestId: 'r', nonce: 'n' });
    expect(echo.requestId).toBe('r');
    expect(parsePassportProfileHello(echo)).toEqual(echo);
  });

  it('refuses half a pair, in both directions', () => {
    expect(() =>
      // @ts-expect-error — half a pair is exactly what must be refused.
      createPassportProfileHello({ requestId: 'r' }),
    ).toThrow(/both halves/);
    expect(
      parsePassportProfileHello({
        protocol: PASSPORT_PROFILE_PROTOCOL,
        type: 'passport.profile.hello',
        requestId: 'r',
      }),
    ).toBeNull();
    expect(parsePassportProfileHello({ protocol: 'org.evil/v1' })).toBeNull();
  });
});

describe('addressing a refusal back at an unreadable message', () => {
  it('lifts a usable pair off one, and refuses to invent one', () => {
    expect(pairOfUnreadableMessage({ requestId: 'r', nonce: 'n', junk: 1 })).toEqual({
      requestId: 'r',
      nonce: 'n',
    });
    expect(pairOfUnreadableMessage({ requestId: 'r' })).toBeNull();
    expect(pairOfUnreadableMessage({ requestId: '', nonce: 'n' })).toBeNull();
    expect(pairOfUnreadableMessage(null)).toBeNull();
    expect(pairOfUnreadableMessage('nope')).toBeNull();
  });
});
