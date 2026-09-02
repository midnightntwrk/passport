/* ===========================================================================
 * `org.midnight.passport.profile/v1` — the profile consent exchange
 * ===========================================================================
 *
 * Moved here from `demo-backend/src/profileProtocol.ts`, which is now a
 * re-export of this module. There is one copy of this protocol in the tree and
 * the module graph is what enforces it.
 *
 * The defensive style is unchanged and deliberate: strict parsers over
 * untrusted `postMessage` data, every reply bound to the `requestId`/`nonce`
 * pair the caller minted, every string length-capped so a hostile app cannot
 * push megabytes of text into Passport's consent sheet, and a freshly
 * constructed object on the way out so nothing an app did not ask for can ride
 * along on a reply.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY — `midnightAddresses` is gone
 * ---------------------------------------------------------------------------
 *
 * The field vocabulary used to be `displayName`, `passportContract`, and
 * `midnightAddresses` — the last carrying the transaction engine's unshielded,
 * shielded, and dust addresses. It is removed, and the reason was written down
 * inside Passport itself long before this package existed
 * (`examples/passport-demo/src/profileConsent.tsx`, 2026/08/25):
 *
 *     The three engine addresses are a signing detail no dApp has a legitimate
 *     use for, and offering them here invites an app to pay an address the
 *     account cannot see.
 *
 * A Passport user's identity is their account-custody contract, and that is
 * what `passportContract.address` carries. Money belongs at the ACCOUNT; the
 * engine addresses are where the wallet happens to sign from, and an app that
 * pays one of them has paid somewhere the account cannot spend from. Shipping
 * a public SDK whose starter template asks for engine addresses would teach
 * exactly the wrong thing, so the field does not exist to be asked for.
 *
 * A request naming it is now a request whose field list did not survive
 * filtering, which was already a rejection — and is now a rejection that gets
 * ANSWERED (`invalid_request`) rather than dropped in silence.
 *
 * ---------------------------------------------------------------------------
 * `passport.profile.hello` is a real message now
 * ---------------------------------------------------------------------------
 *
 * It was a magic string, required in practice by three apps and defined in no
 * protocol module. Passport re-broadcasts `ready` every 800 ms until the frame
 * says ANYTHING, so an app that never speaks is an app Passport reports as not
 * responding. `hello` is that ack, and it is now typed, parseable, and part of
 * the presence handshake: a cold `hello` — one carrying no pair — is a frame
 * asking "are you there?", and Passport answers it with a `ready`.
 * ========================================================================= */

import {
  PASSPORT_PROFILE_ERROR_CODES,
  PassportProtocolError,
  isPassportProfileErrorCode,
  type PassportProfileErrorCode,
} from './errors.js';
import { MAX_PROFILE_ADDRESS_LENGTH, MAX_STRING_LENGTH } from './limits.js';
import {
  PASSPORT_PROTOCOL_VERSION,
  isBoundedString,
  isRecord,
  malformed,
  notPassport,
  ok,
  orNull,
  passportParseFailureReason,
  readProtocolVersion,
  type PassportParseResult,
} from './version.js';

export const PASSPORT_PROFILE_PROTOCOL = 'org.midnight.passport.profile/v1' as const;

/**
 * Everything an app may ask for. Two fields, and both of them are things a
 * person would recognise as their own: the name they chose, and the account
 * that name belongs to. See the header for what used to be here.
 */
export const PASSPORT_PROFILE_FIELDS = ['displayName', 'passportContract'] as const;

export type PassportProfileField = (typeof PASSPORT_PROFILE_FIELDS)[number];

export interface PassportProfileRequest {
  protocol: typeof PASSPORT_PROFILE_PROTOCOL;
  type: 'passport.profile.request';
  version: number;
  requestId: string;
  nonce: string;
  fields: PassportProfileField[];
}

export interface PassportProfileReady {
  protocol: typeof PASSPORT_PROFILE_PROTOCOL;
  type: 'passport.profile.ready';
  version: number;
  requestId: string;
  nonce: string;
}

/**
 * The frame's acknowledgement. Both halves are optional: an app that has
 * already received `ready` echoes the pair back, and an app that has not yet
 * heard anything sends a bare `hello` to ask whether Passport is there.
 */
export interface PassportProfileHello {
  protocol: typeof PASSPORT_PROFILE_PROTOCOL;
  type: 'passport.profile.hello';
  version: number;
  requestId?: string;
  nonce?: string;
}

export type PassportProfile = Partial<{
  displayName: string;
  passportContract: {
    address: string;
    network: string;
  };
}>;

export interface PassportProfileResponse {
  protocol: typeof PASSPORT_PROFILE_PROTOCOL;
  type: 'passport.profile.response';
  version: number;
  requestId: string;
  nonce: string;
  approved: boolean;
  profile?: PassportProfile;
  error?: PassportProfileErrorCode;
}

export type PassportProfileMessage =
  | PassportProfileReady
  | PassportProfileHello
  | PassportProfileRequest
  | PassportProfileResponse;

/**
 * The account-custody contract address is bech32m and runs long, so addresses
 * get their own cap. It is deliberately LOOSER than the tx protocol's
 * recipient cap — both live in `limits.ts`, which explains why.
 */
const MAX_ADDRESS_LENGTH = MAX_PROFILE_ADDRESS_LENGTH;

function isNonEmptyString(value: unknown): value is string {
  return isBoundedString(value, MAX_STRING_LENGTH);
}

export function isPassportProfileField(value: unknown): value is PassportProfileField {
  return (
    typeof value === 'string' && (PASSPORT_PROFILE_FIELDS as readonly string[]).includes(value)
  );
}

/**
 * The shared preamble: is this our protocol at all, and can we read it?
 *
 * Every parser starts here, so "not addressed to us" and "addressed to us in a
 * revision we do not speak" are decided in one place and answered the same way
 * on both channels.
 */
function preamble(
  value: unknown,
  type: string,
): { readonly kind: 'ok'; readonly record: Record<string, unknown>; readonly version: number } | ReturnType<typeof notPassport> | ReturnType<typeof malformed> {
  if (!isRecord(value)) return notPassport();
  if (value.protocol !== PASSPORT_PROFILE_PROTOCOL) return notPassport();
  if (value.type !== type) return notPassport();
  const version = readProtocolVersion(value);
  if (version.kind !== 'ok') return version;
  return { kind: 'ok', record: value, version: version.version };
}

/* ---------------------------------------------------------------------------
 * Requests
 * ------------------------------------------------------------------------ */

export function readPassportProfileRequest(
  value: unknown,
): PassportParseResult<PassportProfileRequest> {
  const head = preamble(value, 'passport.profile.request');
  if (head.kind !== 'ok') return head;
  const { record, version } = head;

  if (!isNonEmptyString(record.requestId)) return malformed('requestId is missing or too long');
  if (!isNonEmptyString(record.nonce)) return malformed('nonce is missing or too long');
  if (!Array.isArray(record.fields)) return malformed('fields is not an array');

  /* The list must survive dedupe and filtering INTACT. A duplicate or an
     unknown name rejects the whole request rather than being quietly dropped:
     an app that asks for something this protocol does not carry has a bug, and
     silently narrowing its request would hide the bug behind a consent sheet
     that offers less than the developer believes they asked for. */
  if (record.fields.length === 0) return malformed('fields is empty');
  const fields = [...new Set(record.fields.filter(isPassportProfileField))];
  if (fields.length !== record.fields.length) {
    return malformed(
      `fields must be a duplicate-free subset of ${PASSPORT_PROFILE_FIELDS.join(', ')}`,
    );
  }

  return ok({
    protocol: PASSPORT_PROFILE_PROTOCOL,
    type: 'passport.profile.request',
    version,
    requestId: record.requestId,
    nonce: record.nonce,
    fields,
  });
}

export function parsePassportProfileRequest(value: unknown): PassportProfileRequest | null {
  return orNull(readPassportProfileRequest(value));
}

/**
 * Builds an app's outbound request, and refuses to build an invalid one.
 *
 * There was no factory before this: every integrator hand-wrote the object
 * literal, and a literal with a typo produced silence rather than a complaint.
 * The construction is validated by the PARSER, not by a second copy of the
 * rules, so the two can never disagree about what a valid request is.
 */
export function createPassportProfileRequest(input: {
  requestId: string;
  nonce: string;
  fields: readonly PassportProfileField[];
}): PassportProfileRequest {
  const candidate = {
    protocol: PASSPORT_PROFILE_PROTOCOL,
    type: 'passport.profile.request',
    version: PASSPORT_PROTOCOL_VERSION,
    requestId: input.requestId,
    nonce: input.nonce,
    fields: [...input.fields],
  };
  const parsed = readPassportProfileRequest(candidate);
  if (parsed.kind !== 'ok') {
    throw new PassportProtocolError(
      'invalid_request',
      passportParseFailureReason(parsed),
    );
  }
  return parsed.value;
}

/* ---------------------------------------------------------------------------
 * Ready and hello
 * ------------------------------------------------------------------------ */

export function readPassportProfileReady(
  value: unknown,
): PassportParseResult<PassportProfileReady> {
  const head = preamble(value, 'passport.profile.ready');
  if (head.kind !== 'ok') return head;
  const { record, version } = head;
  if (!isNonEmptyString(record.requestId)) return malformed('requestId is missing or too long');
  if (!isNonEmptyString(record.nonce)) return malformed('nonce is missing or too long');
  return ok({
    protocol: PASSPORT_PROFILE_PROTOCOL,
    type: 'passport.profile.ready',
    version,
    requestId: record.requestId,
    nonce: record.nonce,
  });
}

export function parsePassportProfileReady(value: unknown): PassportProfileReady | null {
  return orNull(readPassportProfileReady(value));
}

export function createPassportProfileReady(
  requestId: string,
  nonce: string,
): PassportProfileReady {
  if (!isNonEmptyString(requestId) || !isNonEmptyString(nonce)) {
    throw new PassportProtocolError(
      'invalid_request',
      'a profile exchange requires a non-empty request id and nonce',
    );
  }
  return {
    protocol: PASSPORT_PROFILE_PROTOCOL,
    type: 'passport.profile.ready',
    version: PASSPORT_PROTOCOL_VERSION,
    requestId,
    nonce,
  };
}

export function readPassportProfileHello(
  value: unknown,
): PassportParseResult<PassportProfileHello> {
  const head = preamble(value, 'passport.profile.hello');
  if (head.kind !== 'ok') return head;
  const { record, version } = head;
  const hello: PassportProfileHello = {
    protocol: PASSPORT_PROFILE_PROTOCOL,
    type: 'passport.profile.hello',
    version,
  };
  /* Both or neither. A hello carrying half a pair is not an echo of anything,
     and treating it as one would let a frame claim a handshake it never had. */
  if (record.requestId !== undefined || record.nonce !== undefined) {
    if (!isNonEmptyString(record.requestId) || !isNonEmptyString(record.nonce)) {
      return malformed('a hello that echoes a pair must carry both halves of it');
    }
    hello.requestId = record.requestId;
    hello.nonce = record.nonce;
  }
  return ok(hello);
}

export function parsePassportProfileHello(value: unknown): PassportProfileHello | null {
  return orNull(readPassportProfileHello(value));
}

/**
 * The frame's ack, and the app half of presence detection.
 *
 * With a pair it says "I heard you, stop re-broadcasting". Without one it says
 * "is anybody there?", which is the only question a framed app can ask before
 * a handshake exists — there is no injected provider to look for.
 */
export function createPassportProfileHello(pair?: {
  requestId: string;
  nonce: string;
}): PassportProfileHello {
  const hello: PassportProfileHello = {
    protocol: PASSPORT_PROFILE_PROTOCOL,
    type: 'passport.profile.hello',
    version: PASSPORT_PROTOCOL_VERSION,
  };
  if (pair) {
    if (!isNonEmptyString(pair.requestId) || !isNonEmptyString(pair.nonce)) {
      throw new PassportProtocolError(
        'invalid_request',
        'a hello that echoes a pair must carry both halves of it',
      );
    }
    hello.requestId = pair.requestId;
    hello.nonce = pair.nonce;
  }
  return hello;
}

/* ---------------------------------------------------------------------------
 * Responses
 * ------------------------------------------------------------------------ */

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
  return profile;
}

/**
 * Parses Passport's reply. The app should additionally match id and nonce.
 * Returns a failure — never a partially-filled object — for anything that is
 * not exactly a well-formed response, and always a freshly constructed object
 * carrying only declared fields.
 */
export function readPassportProfileResponse(
  value: unknown,
): PassportParseResult<PassportProfileResponse> {
  const head = preamble(value, 'passport.profile.response');
  if (head.kind !== 'ok') return head;
  const { record, version } = head;

  if (!isNonEmptyString(record.requestId)) return malformed('requestId is missing or too long');
  if (!isNonEmptyString(record.nonce)) return malformed('nonce is missing or too long');
  if (typeof record.approved !== 'boolean') return malformed('approved is not a boolean');

  if (record.approved) {
    const profile = parsePassportProfile(record.profile);
    if (!profile) return malformed('the approved profile is not a shape this protocol describes');
    return ok({
      protocol: PASSPORT_PROFILE_PROTOCOL,
      type: 'passport.profile.response',
      version,
      requestId: record.requestId,
      nonce: record.nonce,
      approved: true,
      profile,
    });
  }

  if (!isPassportProfileErrorCode(record.error)) {
    return malformed(`a refusal must name one of ${PASSPORT_PROFILE_ERROR_CODES.join(', ')}`);
  }
  return ok({
    protocol: PASSPORT_PROFILE_PROTOCOL,
    type: 'passport.profile.response',
    version,
    requestId: record.requestId,
    nonce: record.nonce,
    approved: false,
    error: record.error,
  });
}

export function parsePassportProfileResponse(value: unknown): PassportProfileResponse | null {
  return orNull(readPassportProfileResponse(value));
}

export function createPassportProfileResponse(
  request: Pick<PassportProfileRequest, 'requestId' | 'nonce'>,
  response: Omit<PassportProfileResponse, 'protocol' | 'type' | 'version' | 'requestId' | 'nonce'>,
): PassportProfileResponse {
  return {
    protocol: PASSPORT_PROFILE_PROTOCOL,
    type: 'passport.profile.response',
    version: PASSPORT_PROTOCOL_VERSION,
    requestId: request.requestId,
    nonce: request.nonce,
    ...response,
  };
}

/**
 * The reply to a message this build could not read.
 *
 * It exists so a mismatch is a SENTENCE rather than a silence. The pair is
 * echoed when the unreadable message carried a usable-looking one, because a
 * caller matches on the pair and a reply it cannot match is a reply it will
 * ignore — which would put us straight back where we started.
 */
export function createPassportProfileErrorResponse(
  pair: { requestId: string; nonce: string },
  error: Extract<PassportProfileErrorCode, 'invalid_request' | 'version_mismatch'>,
): PassportProfileResponse {
  return createPassportProfileResponse(pair, { approved: false, error });
}

/**
 * The pair of a message that failed to parse, when it has one worth echoing.
 *
 * Deliberately lenient — it reads two strings off an object that has already
 * been rejected — because its only job is to address a refusal back at whoever
 * sent the thing. Nothing downstream trusts these values for anything else.
 */
export function pairOfUnreadableMessage(
  value: unknown,
): { requestId: string; nonce: string } | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.requestId) || !isNonEmptyString(value.nonce)) return null;
  return { requestId: value.requestId, nonce: value.nonce };
}
