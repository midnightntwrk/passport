import { describe, expect, it } from 'vitest';

import {
  PASSPORT_PROFILE_PROTOCOL,
  createPassportProfileReady,
  createPassportProfileResponse,
  parsePassportProfileReady,
  parsePassportProfileRequest,
  parsePassportProfileResponse,
} from '../src/profile.js';

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
});
