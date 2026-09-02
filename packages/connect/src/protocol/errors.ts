/* ===========================================================================
 * The error taxonomy — one vocabulary, one guard, one set of sentences
 * ===========================================================================
 *
 * WHAT WAS WRONG. The two protocols disagreed about what an error code even
 * is. Transaction codes were a proper exported array with a type guard;
 * profile codes were three string literals inline in a union, re-checked by
 * hand at the one place that parsed them. So every integrating app rebuilt the
 * missing half itself — a `Record<string, string>` of plain-English sentences,
 * copied per app, drifting per app, and shown to a user as a bare code
 * wherever somebody forgot an entry.
 *
 * WHAT IS TRUE NOW. Both vocabularies are arrays, both have guards, the union
 * of them is exported as {@link PassportErrorCode}, and every code has exactly
 * one sentence — here, once. An app renders `result.message`; it never sees a
 * code unless it goes looking for one.
 *
 * The two halves keep their own spelling — `profile_unavailable` with an
 * underscore, `insufficient-funds` with a hyphen — because those strings are
 * on the wire and already deployed. Unifying the punctuation would be a
 * cosmetic change that breaks every shipped Passport, which is a bad trade for
 * tidiness. The union is what removes the cost of the inconsistency.
 * ========================================================================= */

export type PassportProfileErrorCode =
  | 'denied'
  | 'profile_unavailable'
  | 'invalid_request'
  /** Added with the version field: this Passport cannot read that revision. */
  | 'version_mismatch';

export const PASSPORT_PROFILE_ERROR_CODES: readonly PassportProfileErrorCode[] = [
  'denied',
  'profile_unavailable',
  'invalid_request',
  'version_mismatch',
];

export type PassportTxErrorCode =
  | 'declined'
  | 'insufficient-funds'
  | 'wallet-unavailable'
  | 'invalid-request'
  | 'network-mismatch'
  | 'submit-failed'
  /** Added with the version field: this Passport cannot read that revision. */
  | 'version-mismatch';

export const PASSPORT_TX_ERROR_CODES: readonly PassportTxErrorCode[] = [
  'declined',
  'insufficient-funds',
  'wallet-unavailable',
  'invalid-request',
  'network-mismatch',
  'submit-failed',
  'version-mismatch',
];

/** Everything Passport itself can put on the wire, on either protocol. */
export type PassportErrorCode = PassportProfileErrorCode | PassportTxErrorCode;

export const PASSPORT_ERROR_CODES: readonly PassportErrorCode[] = [
  ...PASSPORT_PROFILE_ERROR_CODES,
  ...PASSPORT_TX_ERROR_CODES,
];

/**
 * Failures that never travel: this SDK produced them, on this side of the
 * boundary, and no Passport was involved.
 *
 * They are a SEPARATE union on purpose. A refusal carries `source: 'local'`
 * with one of these or `source: 'passport'` with a wire code, so an integrator
 * can always tell "Passport said no" from "we never got as far as asking" —
 * which is the difference between showing the user a decision and showing them
 * a problem with the page.
 */
export type PassportLocalErrorCode =
  /** `window.open` returned null. No window, no approval sheet, no payment. */
  | 'popup-blocked'
  /** The budget elapsed with no reply. Nothing is known about the outcome. */
  | 'timed-out'
  /** The Passport window was closed before it answered. */
  | 'passport-closed'
  /** Framed, and no handshake arrived within the detection window. */
  | 'not-present'
  /** Asked for something this transport cannot carry (an incentive by popup). */
  | 'unsupported-transport'
  /** The request this SDK was asked to send is not a valid one. Never sent. */
  | 'invalid-request';

export const PASSPORT_LOCAL_ERROR_CODES: readonly PassportLocalErrorCode[] = [
  'popup-blocked',
  'timed-out',
  'passport-closed',
  'not-present',
  'unsupported-transport',
  'invalid-request',
];

export function isPassportProfileErrorCode(value: unknown): value is PassportProfileErrorCode {
  return (
    typeof value === 'string' &&
    (PASSPORT_PROFILE_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function isPassportTxErrorCode(value: unknown): value is PassportTxErrorCode {
  return (
    typeof value === 'string' && (PASSPORT_TX_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function isPassportErrorCode(value: unknown): value is PassportErrorCode {
  return isPassportProfileErrorCode(value) || isPassportTxErrorCode(value);
}

export function isPassportLocalErrorCode(value: unknown): value is PassportLocalErrorCode {
  return (
    typeof value === 'string' && (PASSPORT_LOCAL_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * One plain-English sentence per code, for the user rather than the developer.
 *
 * Every sentence states what happened to the user's data or the user's money,
 * because that is the only question they are actually asking. None of them
 * apologises, none of them says "error", and the ones that describe our own
 * bug say so rather than implying the user did something wrong.
 */
const MESSAGES: Record<PassportErrorCode | PassportLocalErrorCode, string> = {
  /* --- profile ---------------------------------------------------------- */
  denied: 'You declined the request in Passport. Nothing was shared with this app.',
  profile_unavailable:
    'Passport has no profile to share yet — it has not finished setting one up.',
  invalid_request:
    'Passport rejected the request as malformed. That is this app’s bug, not yours.',
  version_mismatch:
    'This app and this Passport are speaking different revisions of the profile protocol. Nothing was shared. Updating either one will fix it.',

  /* --- transactions ----------------------------------------------------- */
  declined: 'You declined the payment on Passport’s approval sheet. Nothing was signed.',
  'insufficient-funds':
    'The Passport account cannot cover this payment — it is short of NIGHT, or of the DUST that pays the network fee.',
  'wallet-unavailable': 'No Passport session is open, so nothing could be signed.',
  'invalid-request':
    'Passport refused the request — it was already showing an approval sheet, or the recipient is not a valid unshielded address.',
  'network-mismatch':
    'The recipient address belongs to a different network from the Passport account.',
  'submit-failed': 'It was signed, but the node rejected it or could not be reached.',
  'version-mismatch':
    'This app and this Passport are speaking different revisions of the transaction protocol. Nothing was signed and nothing was paid. Updating either one will fix it.',

  /* --- local ------------------------------------------------------------ */
  'popup-blocked':
    'The browser blocked the Passport window, so nothing could be approved. Allow pop-ups for this site and try again.',
  'timed-out':
    'Passport did not answer in time. Check Passport before retrying, in case it got further than this page knows.',
  'passport-closed':
    'The Passport window was closed before it answered. Nothing was shared and nothing was paid.',
  'not-present':
    'No Passport answered. This page is framed by something that does not speak the Passport protocol.',
  'unsupported-transport':
    'This exchange only exists inside Passport’s own app browser. Nothing was sent.',
};

/** The sentence for a code. Total — an unknown code still gets a sentence. */
export function passportErrorMessage(code: string): string {
  return (
    MESSAGES[code as PassportErrorCode | PassportLocalErrorCode] ??
    'Passport did not complete the request, and did not say why.'
  );
}

/**
 * Thrown by the request factories when an integrator hands them something the
 * protocol cannot carry.
 *
 * Throwing is the point. The old failure mode was that an invalid request went
 * out, Passport's parser dropped it, no reply came back, and the developer
 * watched a spinner for three minutes. A synchronous throw at the call site
 * names the field and the rule in the stack trace of the line that broke it.
 */
export class PassportProtocolError extends Error {
  /** The wire code this would have produced had it been sent and answered. */
  readonly code: 'invalid_request' | 'invalid-request';
  readonly reason: string;

  constructor(code: 'invalid_request' | 'invalid-request', reason: string) {
    super(`Passport ${code === 'invalid_request' ? 'profile' : 'transaction'} request is not valid: ${reason}`);
    this.name = 'PassportProtocolError';
    this.code = code;
    this.reason = reason;
  }
}
