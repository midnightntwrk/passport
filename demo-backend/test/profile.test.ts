import { describe, expect, it } from 'vitest';

import {
  PASSPORT_PROFILE_PROTOCOL,
  createPassportProfileReady,
  createPassportProfileResponse,
  parsePassportProfileReady,
  parsePassportProfileRequest,
  parsePassportProfileResponse,
} from '../src/profileProtocol.js';

describe('Passport profile exchange', () => {
  it('accepts a nonce-bound allowlisted request', () => {
    const request = parsePassportProfileRequest({
      protocol: PASSPORT_PROFILE_PROTOCOL,
      type: 'passport.profile.request',
      requestId: 'request-1',
      nonce: 'nonce-1',
      fields: ['displayName', 'midnightAddresses'],
    });

    expect(request).toEqual({
      protocol: PASSPORT_PROFILE_PROTOCOL,
      type: 'passport.profile.request',
      requestId: 'request-1',
      nonce: 'nonce-1',
      fields: ['displayName', 'midnightAddresses'],
    });
  });

  it('rejects unknown or empty fields', () => {
    expect(
      parsePassportProfileRequest({
        protocol: PASSPORT_PROFILE_PROTOCOL,
        type: 'passport.profile.request',
        requestId: 'request-1',
        nonce: 'nonce-1',
        fields: ['privateState'],
      }),
    ).toBeNull();
    expect(
      parsePassportProfileRequest({
        protocol: PASSPORT_PROFILE_PROTOCOL,
        type: 'passport.profile.request',
        requestId: 'request-1',
        nonce: 'nonce-1',
        fields: [],
      }),
    ).toBeNull();
  });

  it('binds ready and response messages to the request', () => {
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
        createPassportProfileResponse(request, {
          approved: false,
          error: 'denied',
        }),
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
        approvedResponse({ midnightAddresses: { unshielded: 'a'.repeat(512) } }),
      ),
    ).not.toBeNull();
    expect(
      parsePassportProfileResponse(
        approvedResponse({ midnightAddresses: { unshielded: 'a'.repeat(513) } }),
      ),
    ).toBeNull();

    /* The address cap is per string, not per object: an oversize optional
       member rejects the whole profile just as the required one does. */
    expect(
      parsePassportProfileResponse(
        approvedResponse({
          midnightAddresses: { unshielded: 'mn_addr_1', shielded: 's'.repeat(513) },
        }),
      ),
    ).toBeNull();
    expect(
      parsePassportProfileResponse(
        approvedResponse({
          passportContract: { address: 'c'.repeat(513), network: 'testnet' },
        }),
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
      { midnightAddresses: 'mn_addr_1' },
      { midnightAddresses: {} },
      { midnightAddresses: { unshielded: '' } },
      { midnightAddresses: { unshielded: 'mn_addr_1', dust: 7 } },
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
        midnightAddresses: { unshielded: 'mn_addr_1', privateKey: 'nope' },
        privateState: 'nope',
      }),
    );
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!.profile!)).toEqual(['displayName', 'midnightAddresses']);
    expect(Object.keys(parsed!.profile!.midnightAddresses!)).toEqual(['unshielded']);
    expect(parsed).not.toHaveProperty('error');
  });
});
