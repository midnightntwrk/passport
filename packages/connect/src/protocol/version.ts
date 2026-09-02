/* ===========================================================================
 * Versioning, and the parse result that makes it usable
 * ===========================================================================
 *
 * WHAT WAS WRONG. The version used to be fused into the protocol string
 * literal — `org.midnight.passport.profile/v1` — and compared with `!==`. On a
 * mismatch the parser returned `null`, the message was dropped, and NO REPLY
 * WAS SENT. The consequence for an integrator is not a security property, it
 * is a three-minute hang: there was no way to tell "Passport is older than my
 * SDK" from "Passport is not there at all" from "the message I sent was
 * malformed". All three looked identical, and all three looked like nothing.
 *
 * WHAT IS TRUE NOW. Every message carries an explicit numeric `version`, and
 * every parser returns a RESULT rather than `T | null`:
 *
 *   not-passport      Not this protocol at all. The only case where silence is
 *                     right — a page receives messages from analytics scripts,
 *                     extensions, and its own framework, and answering them
 *                     would be noise at best and an oracle at worst.
 *   version-mismatch  This IS a Passport message, and its version is one this
 *                     build does not implement. Passport replies with
 *                     `version_mismatch` / `version-mismatch` rather than
 *                     dropping it, so the far side learns what happened.
 *   malformed         This protocol, this version, wrong shape. Also answered,
 *                     with the existing `invalid_request` / `invalid-request`.
 *
 * WHY THE PROTOCOL STRING STILL SAYS `/v1`. The identifier names the CHANNEL
 * and its message vocabulary; the number names the wire revision within it.
 * Bumping the identifier is a hard break that every deployed app fails on
 * simultaneously and silently, which is exactly the failure mode this module
 * exists to end. The numeric field is the negotiable thing from here on: a
 * future revision raises the number, both sides can say what they support, and
 * a mismatch produces a sentence instead of a hang.
 *
 * ABSENCE MEANS 1. Every message minted before this field existed is a version
 * 1 message, so a message with no `version` is read as version 1 rather than
 * rejected. That is what lets an SDK-based app and a not-yet-updated Passport
 * (or the reverse) keep working through the change that introduced the field.
 * ========================================================================= */

/** The wire revision this build mints. */
export const PASSPORT_PROTOCOL_VERSION = 1;

/** Every wire revision this build can read. Ordered oldest to newest. */
export const PASSPORT_SUPPORTED_VERSIONS: readonly number[] = [PASSPORT_PROTOCOL_VERSION];

/** Why a well-formed-looking message was not accepted. */
export type PassportParseFailure =
  /** Not a Passport message. Do not reply — it was never addressed to you. */
  | { readonly kind: 'not-passport' }
  /** A Passport message this build cannot read. Reply, naming the mismatch. */
  | {
      readonly kind: 'version-mismatch';
      readonly received: number;
      readonly supported: readonly number[];
    }
  /** This protocol, a version we speak, and a shape we do not. Reply. */
  | { readonly kind: 'malformed'; readonly reason: string };

export type PassportParseResult<T> = { readonly kind: 'ok'; readonly value: T } | PassportParseFailure;

export function ok<T>(value: T): PassportParseResult<T> {
  return { kind: 'ok', value };
}

export function notPassport(): PassportParseFailure {
  return { kind: 'not-passport' };
}

export function malformed(reason: string): PassportParseFailure {
  return { kind: 'malformed', reason };
}

export function versionMismatch(received: number): PassportParseFailure {
  return { kind: 'version-mismatch', received, supported: PASSPORT_SUPPORTED_VERSIONS };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * Reads the `version` field of a message that has already been confirmed to
 * carry the right `protocol` string.
 *
 * Absent is 1 (see the header). Present must be a positive, safe integer —
 * `"1"`, `1.5`, `NaN`, and `-1` are all a malformed message rather than a
 * mismatch, because none of them names a revision anybody could support.
 */
export function readProtocolVersion(
  value: Record<string, unknown>,
): { readonly kind: 'ok'; readonly version: number } | PassportParseFailure {
  const raw = value.version;
  if (raw === undefined) return { kind: 'ok', version: PASSPORT_PROTOCOL_VERSION };
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) {
    return malformed('the version field is not a positive integer');
  }
  if (!PASSPORT_SUPPORTED_VERSIONS.includes(raw)) return versionMismatch(raw);
  return { kind: 'ok', version: raw };
}

/**
 * One sentence naming why a message was not accepted, for a caller that has
 * to put the reason somewhere a person or a log will read it.
 */
export function passportParseFailureReason(failure: PassportParseFailure): string {
  if (failure.kind === 'malformed') return failure.reason;
  if (failure.kind === 'version-mismatch') {
    return `the message is revision ${failure.received}; this build speaks ${failure.supported.join(', ')}`;
  }
  return 'the message is not this protocol';
}

/**
 * The `T | null` form every parser also offers, so a caller that genuinely
 * only wants "is this the message I am waiting for?" does not have to widen
 * itself to a result type. It throws information away on purpose; the result
 * form is the one to reach for when a reply is owed.
 */
export function orNull<T>(result: PassportParseResult<T>): T | null {
  return result.kind === 'ok' ? result.value : null;
}
