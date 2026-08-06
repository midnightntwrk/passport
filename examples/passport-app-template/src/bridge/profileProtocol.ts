/* ---------------------------------------------------------------------------
 * VENDORED — do not edit here.
 *
 * Source: midnight-passport-dynamic-signing, demo-backend/src/profileProtocol.ts
 * Vendored: 2026/08/06 (from examples/raffle-demo, same source)
 *
 * The Passport bridge protocols are dependency-free by design, so this
 * template carries its own copy rather than a workspace link. That is what
 * makes the folder buildable after a plain copy out of the repo — which is
 * the point: you get a project that runs, not one that needs a monorepo you
 * do not have.
 *
 * Keep it byte-identical to the source. A protocol that has quietly drifted
 * on one side is worse than no protocol at all.
 * ------------------------------------------------------------------------- */

export const PASSPORT_PROFILE_PROTOCOL = 'org.midnight.passport.profile/v1' as const;

export const PASSPORT_PROFILE_FIELDS = [
  'displayName',
  'passportContract',
  'midnightAddresses',
] as const;

export type PassportProfileField = (typeof PASSPORT_PROFILE_FIELDS)[number];

export interface PassportProfileRequest {
  protocol: typeof PASSPORT_PROFILE_PROTOCOL;
  type: 'passport.profile.request';
  requestId: string;
  nonce: string;
  fields: PassportProfileField[];
}

export interface PassportProfileReady {
  protocol: typeof PASSPORT_PROFILE_PROTOCOL;
  type: 'passport.profile.ready';
  requestId: string;
  nonce: string;
}

export interface PassportProfileResponse {
  protocol: typeof PASSPORT_PROFILE_PROTOCOL;
  type: 'passport.profile.response';
  requestId: string;
  nonce: string;
  approved: boolean;
  profile?: Partial<{
    displayName: string;
    passportContract: {
      address: string;
      network: string;
    };
    midnightAddresses: {
      unshielded: string;
      shielded?: string;
      dust?: string;
    };
  }>;
  error?: 'denied' | 'profile_unavailable' | 'invalid_request';
}

export type PassportProfileMessage =
  | PassportProfileReady
  | PassportProfileRequest
  | PassportProfileResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

export function isPassportProfileField(value: unknown): value is PassportProfileField {
  return (
    typeof value === 'string' &&
    (PASSPORT_PROFILE_FIELDS as readonly string[]).includes(value)
  );
}

export function parsePassportProfileRequest(value: unknown): PassportProfileRequest | null {
  if (!isRecord(value)) return null;
  if (
    value.protocol !== PASSPORT_PROFILE_PROTOCOL ||
    value.type !== 'passport.profile.request' ||
    !isNonEmptyString(value.requestId) ||
    !isNonEmptyString(value.nonce) ||
    !Array.isArray(value.fields)
  ) {
    return null;
  }
  const fields = [...new Set(value.fields.filter(isPassportProfileField))];
  if (fields.length === 0 || fields.length !== value.fields.length) return null;
  return {
    protocol: PASSPORT_PROFILE_PROTOCOL,
    type: 'passport.profile.request',
    requestId: value.requestId,
    nonce: value.nonce,
    fields,
  };
}

export function parsePassportProfileReady(value: unknown): PassportProfileReady | null {
  if (
    !isRecord(value) ||
    value.protocol !== PASSPORT_PROFILE_PROTOCOL ||
    value.type !== 'passport.profile.ready' ||
    !isNonEmptyString(value.requestId) ||
    !isNonEmptyString(value.nonce)
  ) {
    return null;
  }
  return {
    protocol: PASSPORT_PROFILE_PROTOCOL,
    type: 'passport.profile.ready',
    requestId: value.requestId,
    nonce: value.nonce,
  };
}

export function parsePassportProfileResponse(value: unknown): PassportProfileResponse | null {
  if (
    !isRecord(value) ||
    value.protocol !== PASSPORT_PROFILE_PROTOCOL ||
    value.type !== 'passport.profile.response' ||
    !isNonEmptyString(value.requestId) ||
    !isNonEmptyString(value.nonce) ||
    typeof value.approved !== 'boolean'
  ) {
    return null;
  }
  if (value.approved && !isRecord(value.profile)) return null;
  if (
    !value.approved &&
    value.error !== 'denied' &&
    value.error !== 'profile_unavailable' &&
    value.error !== 'invalid_request'
  ) {
    return null;
  }
  return value as unknown as PassportProfileResponse;
}

export function createPassportProfileReady(
  requestId: string,
  nonce: string,
): PassportProfileReady {
  if (!isNonEmptyString(requestId) || !isNonEmptyString(nonce)) {
    throw new Error('Profile exchange requires a non-empty request id and nonce.');
  }
  return {
    protocol: PASSPORT_PROFILE_PROTOCOL,
    type: 'passport.profile.ready',
    requestId,
    nonce,
  };
}

export function createPassportProfileResponse(
  request: PassportProfileRequest,
  response: Omit<PassportProfileResponse, 'protocol' | 'type' | 'requestId' | 'nonce'>,
): PassportProfileResponse {
  return {
    protocol: PASSPORT_PROFILE_PROTOCOL,
    type: 'passport.profile.response',
    requestId: request.requestId,
    nonce: request.nonce,
    ...response,
  };
}
