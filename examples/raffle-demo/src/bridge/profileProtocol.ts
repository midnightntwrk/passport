/* ---------------------------------------------------------------------------
 * VENDORED — do not edit here.
 *
 * Source: midnight-passport-dynamic-signing, demo-backend/src/profileProtocol.ts
 * Vendored: 2026/08/06
 *
 * The Passport bridge protocols are dependency-free by design, so this demo
 * carries its own copy rather than a workspace link. That is what makes the
 * folder buildable after a plain copy out of the repo — which is the point:
 * hackathon participants get a project that runs, not one that needs a
 * monorepo they do not have.
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

/** Shared with the tx protocol: ids, names, and other short strings. */
const MAX_STRING_LENGTH = 256;
/** Bech32m shielded addresses run long, so addresses get their own cap. */
const MAX_ADDRESS_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isNonEmptyString(value: unknown): value is string {
  return isBoundedString(value, MAX_STRING_LENGTH);
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

type PassportProfile = NonNullable<PassportProfileResponse['profile']>;

/**
 * Validates the `profile` payload of an approved response. Only declared
 * fields survive, every string is length-capped, and a declared field that is
 * present but malformed rejects the whole profile — an app must never be
 * handed a shape this module does not describe.
 */
function parsePassportProfile(value: unknown): PassportProfile | null {
  if (!isRecord(value)) return null;
  const profile: PassportProfile = {};
  if (value.displayName !== undefined) {
    if (!isNonEmptyString(value.displayName)) return null;
    profile.displayName = value.displayName;
  }
  if (value.passportContract !== undefined) {
    const contract = value.passportContract;
    if (
      !isRecord(contract) ||
      !isBoundedString(contract.address, MAX_ADDRESS_LENGTH) ||
      !isNonEmptyString(contract.network)
    ) {
      return null;
    }
    profile.passportContract = { address: contract.address, network: contract.network };
  }
  if (value.midnightAddresses !== undefined) {
    const addresses = value.midnightAddresses;
    if (!isRecord(addresses) || !isBoundedString(addresses.unshielded, MAX_ADDRESS_LENGTH)) {
      return null;
    }
    const parsed: NonNullable<PassportProfile['midnightAddresses']> = {
      unshielded: addresses.unshielded,
    };
    if (addresses.shielded !== undefined) {
      if (!isBoundedString(addresses.shielded, MAX_ADDRESS_LENGTH)) return null;
      parsed.shielded = addresses.shielded;
    }
    if (addresses.dust !== undefined) {
      if (!isBoundedString(addresses.dust, MAX_ADDRESS_LENGTH)) return null;
      parsed.dust = addresses.dust;
    }
    profile.midnightAddresses = parsed;
  }
  return profile;
}

/**
 * Parses Passport's reply. The app should additionally match id and nonce.
 * Returns `null` — never a partially-filled object — for anything that is not
 * exactly a well-formed response, and always a freshly constructed object
 * carrying only declared fields, so nothing an app did not ask this protocol
 * for can ride along on the reply.
 */
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
  if (value.approved) {
    const profile = parsePassportProfile(value.profile);
    if (!profile) return null;
    return {
      protocol: PASSPORT_PROFILE_PROTOCOL,
      type: 'passport.profile.response',
      requestId: value.requestId,
      nonce: value.nonce,
      approved: true,
      profile,
    };
  }
  if (
    value.error !== 'denied' &&
    value.error !== 'profile_unavailable' &&
    value.error !== 'invalid_request'
  ) {
    return null;
  }
  return {
    protocol: PASSPORT_PROFILE_PROTOCOL,
    type: 'passport.profile.response',
    requestId: value.requestId,
    nonce: value.nonce,
    approved: false,
    error: value.error,
  };
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
