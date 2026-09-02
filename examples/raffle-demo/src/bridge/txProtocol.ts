/* ---------------------------------------------------------------------------
 * VENDORED — do not edit here.
 *
 * Source: midnight-passport-dynamic-signing, packages/connect/src/protocol/tx.ts
 * Vendored: 2026/09/02
 *
 * A copy of the upstream module, trimmed only of prose about its place in the
 * upstream tree. The rules are identical, and the folder builds with no
 * dependencies at all. Fixes and protocol changes land upstream first, then
 * come back here as a fresh copy — never as an edit in place.
 * ------------------------------------------------------------------------ */

/* ===========================================================================
 * `org.midnight.passport.tx/v1` — asking Passport to pay
 * ===========================================================================
 *
 * A framed app cannot reach into Passport's wallet, and Passport will not let
 * it: the only thing an app may do is *ask* for a transaction, in the same
 * shape every time, and wait for Passport to come back with either a real node
 * transaction identifier or a named refusal. That asymmetry is the security
 * model, not an inconvenience.
 *
 * Address *validity* is intentionally not checked here — this entry point
 * carries no Midnight SDK dependency and no WebAssembly. Passport decodes the
 * recipient against its own live wallet network before it will show an
 * approval sheet, which is the only place that check can be made honestly.
 *
 * THE HONESTY INVARIANTS, which are the reason this file is worth reading:
 *
 *   - `submitted` requires a real `txId`. A reply that claims a transaction
 *     without naming one would tell an app something exists when nothing does.
 *   - Anything that is not `submitted` requires a known error code.
 *   - `sponsored: true` is mintable and parseable ONLY on `submitted`. There
 *     is no covered fee on a transaction that was never submitted.
 *   - `sponsored` must be a real boolean. A truthy string like `"false"` must
 *     not be able to buy a "fee covered" badge, so it rejects the whole reply.
 *   - The parsed reply may never say two things at once: `txId` is copied only
 *     onto `submitted` and `error` only onto the rest, so a caller can never
 *     read "declined" and find a transaction id sitting next to it.
 *
 * All five are enforced twice — where a reply is minted, and again on parse —
 * because the two sides of the boundary do not trust each other.
 * ========================================================================= */

import {
  PASSPORT_TX_ERROR_CODES,
  PassportProtocolError,
  isPassportTxErrorCode,
  type PassportTxErrorCode,
} from './errors.js';
import {
  MAX_DETAIL_LENGTH,
  MAX_FEE_NOTE_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_PURPOSE_LENGTH,
  MAX_STRING_LENGTH,
  MAX_TX_RECIPIENT_ADDRESS_LENGTH,
} from './limits.js';
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

export const PASSPORT_TX_PROTOCOL = 'org.midnight.passport.tx/v1' as const;

/** Shared with the profile protocol: ids and nonces are capped at 256 chars. */
const MAX_ID_LENGTH = MAX_STRING_LENGTH;
/**
 * Recipients are unshielded-only here, so this is deliberately TIGHTER than
 * the profile protocol's address cap — both live in `limits.ts`, with why.
 */
const MAX_ADDRESS_LENGTH = MAX_TX_RECIPIENT_ADDRESS_LENGTH;

/** Atomic NIGHT units, base-10, no sign, no exponent, no decimal point. */
const AMOUNT_PATTERN = /^[0-9]{1,20}$/;

/** 1 NIGHT is 1,000,000 atomic units. */
export const NIGHT_DECIMALS = 6;

export type PassportTxIntentKind = 'unshielded-transfer';

export interface PassportTxIntent {
  kind: PassportTxIntentKind;
  recipientAddress: string;
  /** atomic NIGHT units as a base-10 string, > 0 */
  amount: string;
  purpose: string;
}

export interface PassportTxRequest {
  protocol: typeof PASSPORT_TX_PROTOCOL;
  type: 'passport.tx.request';
  version: number;
  requestId: string;
  nonce: string;
  intent: PassportTxIntent;
}

export interface PassportTxResponse {
  protocol: typeof PASSPORT_TX_PROTOCOL;
  type: 'passport.tx.response';
  version: number;
  requestId: string;
  nonce: string;
  status: 'submitted' | 'declined' | 'failed';
  txId?: string;
  error?: PassportTxErrorCode;
  detail?: string;
  /**
   * `true` only when the transaction that was submitted came back from a fee
   * sponsor with its fee input attached, so the user paid no network fee.
   *
   * Optional and additive: absent means "not stated", which an app must read
   * as an ordinary, user-paid transaction. An app may render "network fee
   * covered" for `true` and for nothing else.
   */
  sponsored?: boolean;
  /** Optional human-readable note about the fee, e.g. who covered it. */
  feeNote?: string;
}

export interface PassportIncentiveReport {
  protocol: typeof PASSPORT_TX_PROTOCOL;
  type: 'passport.incentive.report';
  version: number;
  requestId: string;
  nonce: string;
  incentive: {
    id: string;
    label: string;
    txId?: string;
  };
}

export type PassportTxMessage = PassportTxRequest | PassportTxResponse | PassportIncentiveReport;

function preamble(
  value: unknown,
  type: string,
): { readonly kind: 'ok'; readonly record: Record<string, unknown>; readonly version: number } | ReturnType<typeof notPassport> | ReturnType<typeof malformed> {
  if (!isRecord(value)) return notPassport();
  if (value.protocol !== PASSPORT_TX_PROTOCOL) return notPassport();
  if (value.type !== type) return notPassport();
  const version = readProtocolVersion(value);
  if (version.kind !== 'ok') return version;
  return { kind: 'ok', record: value, version: version.version };
}

/* ---------------------------------------------------------------------------
 * Requests
 * ------------------------------------------------------------------------ */

/**
 * Parses an app's transaction request. Never throws, never returns a
 * partially-filled object, and accepts nothing but a positive unshielded NIGHT
 * transfer.
 */
export function readPassportTxRequest(value: unknown): PassportParseResult<PassportTxRequest> {
  const head = preamble(value, 'passport.tx.request');
  if (head.kind !== 'ok') return head;
  const { record, version } = head;

  if (!isBoundedString(record.requestId, MAX_ID_LENGTH)) {
    return malformed('requestId is missing or too long');
  }
  if (!isBoundedString(record.nonce, MAX_ID_LENGTH)) {
    return malformed('nonce is missing or too long');
  }
  if (!isRecord(record.intent)) return malformed('intent is missing');

  const intent = record.intent;
  if (intent.kind !== 'unshielded-transfer') {
    return malformed('the only intent kind this protocol carries is unshielded-transfer');
  }
  if (!isBoundedString(intent.recipientAddress, MAX_ADDRESS_LENGTH)) {
    return malformed(`recipientAddress must be 1 to ${MAX_ADDRESS_LENGTH} characters`);
  }
  /* `amount` is a string on the wire on purpose: a JSON number cannot carry
     atomic units without precision loss, and a bigint does not survive
     structured cloning across every browser we care about. */
  if (typeof intent.amount !== 'string' || !AMOUNT_PATTERN.test(intent.amount)) {
    return malformed('amount must be 1 to 20 base-10 digits of atomic NIGHT');
  }
  /* Reject 0 and every padded form of it — an approval sheet for a zero-value
     transfer would be a lie about what the user is agreeing to. */
  if (/^0+$/.test(intent.amount)) return malformed('amount must be greater than zero');
  if (!isBoundedString(intent.purpose, MAX_PURPOSE_LENGTH)) {
    return malformed(`purpose must be 1 to ${MAX_PURPOSE_LENGTH} characters`);
  }

  return ok({
    protocol: PASSPORT_TX_PROTOCOL,
    type: 'passport.tx.request',
    version,
    requestId: record.requestId,
    nonce: record.nonce,
    intent: {
      kind: 'unshielded-transfer',
      recipientAddress: intent.recipientAddress,
      amount: intent.amount,
      purpose: intent.purpose,
    },
  });
}

export function parsePassportTxRequest(value: unknown): PassportTxRequest | null {
  return orNull(readPassportTxRequest(value));
}

/**
 * Builds an app's outbound payment request, and refuses to build an invalid
 * one. Validated by the parser, so factory and parser cannot disagree.
 */
export function createPassportTxRequest(input: {
  requestId: string;
  nonce: string;
  recipientAddress: string;
  /** Atomic NIGHT units, base-10 string or bigint. Never a float. */
  amount: string | bigint;
  purpose: string;
}): PassportTxRequest {
  const candidate = {
    protocol: PASSPORT_TX_PROTOCOL,
    type: 'passport.tx.request',
    version: PASSPORT_PROTOCOL_VERSION,
    requestId: input.requestId,
    nonce: input.nonce,
    intent: {
      kind: 'unshielded-transfer',
      recipientAddress: input.recipientAddress,
      amount: typeof input.amount === 'bigint' ? input.amount.toString(10) : input.amount,
      purpose: input.purpose,
    },
  };
  const parsed = readPassportTxRequest(candidate);
  if (parsed.kind !== 'ok') {
    throw new PassportProtocolError(
      'invalid-request',
      passportParseFailureReason(parsed),
    );
  }
  return parsed.value;
}

/* ---------------------------------------------------------------------------
 * Responses
 * ------------------------------------------------------------------------ */

/**
 * Builds the reply to `request`, binding it to that request's id and nonce so
 * an app can never mistake one exchange's outcome for another's.
 */
export function createPassportTxResponse(
  request: Pick<PassportTxRequest, 'requestId' | 'nonce'>,
  body: Omit<PassportTxResponse, 'protocol' | 'type' | 'version' | 'requestId' | 'nonce'>,
): PassportTxResponse {
  if (body.status === 'submitted' && !isBoundedString(body.txId, MAX_ID_LENGTH)) {
    /* A hard invariant, not a formality: 'submitted' without a node identifier
       would tell the app a transaction exists when none does. */
    throw new Error('A submitted transaction response requires the node transaction id.');
  }
  if (body.status !== 'submitted' && !isPassportTxErrorCode(body.error)) {
    throw new Error('A non-submitted transaction response requires a known error code.');
  }
  if (body.sponsored === true && body.status !== 'submitted') {
    /* The honesty invariant, enforced where the reply is minted: there is no
       such thing as a covered fee on a transaction that was never submitted. */
    throw new Error('Only a submitted transaction can report a sponsored fee.');
  }
  if (body.feeNote !== undefined && !isBoundedString(body.feeNote, MAX_FEE_NOTE_LENGTH)) {
    throw new Error('A fee note must be a non-empty string of at most 140 characters.');
  }
  return {
    protocol: PASSPORT_TX_PROTOCOL,
    type: 'passport.tx.response',
    version: PASSPORT_PROTOCOL_VERSION,
    requestId: request.requestId,
    nonce: request.nonce,
    ...body,
  };
}

/** Parses Passport's reply. The app should additionally match id and nonce. */
export function readPassportTxResponse(value: unknown): PassportParseResult<PassportTxResponse> {
  const head = preamble(value, 'passport.tx.response');
  if (head.kind !== 'ok') return head;
  const { record, version } = head;

  if (!isBoundedString(record.requestId, MAX_ID_LENGTH)) {
    return malformed('requestId is missing or too long');
  }
  if (!isBoundedString(record.nonce, MAX_ID_LENGTH)) {
    return malformed('nonce is missing or too long');
  }
  if (record.status !== 'submitted' && record.status !== 'declined' && record.status !== 'failed') {
    return malformed('status must be submitted, declined, or failed');
  }
  if (record.status === 'submitted') {
    if (!isBoundedString(record.txId, MAX_ID_LENGTH)) {
      return malformed('a submitted reply must carry the node transaction id');
    }
  } else if (!isPassportTxErrorCode(record.error)) {
    return malformed(`a refusal must name one of ${PASSPORT_TX_ERROR_CODES.join(', ')}`);
  }
  if (record.detail !== undefined && !isBoundedString(record.detail, MAX_DETAIL_LENGTH)) {
    return malformed(`detail must be 1 to ${MAX_DETAIL_LENGTH} characters`);
  }
  /* Additive, and strictly so: absent is fine, present must be a real boolean.
     A truthy string like `"false"` must not be able to buy a "fee covered"
     badge, so anything that is not a boolean rejects the whole reply. */
  if (record.sponsored !== undefined && typeof record.sponsored !== 'boolean') {
    return malformed('sponsored must be a boolean when it is present at all');
  }
  /* And a covered fee is only meaningful on a transaction that exists. */
  if (record.sponsored === true && record.status !== 'submitted') {
    return malformed('only a submitted transaction can report a sponsored fee');
  }
  if (record.feeNote !== undefined && !isBoundedString(record.feeNote, MAX_FEE_NOTE_LENGTH)) {
    return malformed(`feeNote must be 1 to ${MAX_FEE_NOTE_LENGTH} characters`);
  }

  const response: PassportTxResponse = {
    protocol: PASSPORT_TX_PROTOCOL,
    type: 'passport.tx.response',
    version,
    requestId: record.requestId,
    nonce: record.nonce,
    status: record.status,
  };
  /* The parsed reply must never be able to say two things at once. A sender
     that attaches a `txId` to a refusal, or an `error` to a submission, is
     making a claim the status contradicts; carrying either through would let a
     caller read "declined" and still find a transaction id sitting next to it.
     So each field is copied only onto the status that can honestly carry it —
     `txId` on `submitted` (where the validation above already required one),
     `error` on everything else (where it was likewise required). Extraneous
     values are dropped rather than rejected: the reply is still a well-formed
     answer, it just does not get to keep the contradiction. */
  if (record.status === 'submitted') {
    if (typeof record.txId === 'string' && record.txId.length > 0) response.txId = record.txId;
  } else if (isPassportTxErrorCode(record.error)) {
    response.error = record.error;
  }
  if (typeof record.detail === 'string' && record.detail.length > 0) {
    response.detail = record.detail;
  }
  if (typeof record.sponsored === 'boolean') response.sponsored = record.sponsored;
  if (typeof record.feeNote === 'string' && record.feeNote.length > 0) {
    response.feeNote = record.feeNote;
  }
  return ok(response);
}

export function parsePassportTxResponse(value: unknown): PassportTxResponse | null {
  return orNull(readPassportTxResponse(value));
}

/** The reply to a transaction message this build could not read. */
export function createPassportTxErrorResponse(
  pair: { requestId: string; nonce: string },
  error: Extract<PassportTxErrorCode, 'invalid-request' | 'version-mismatch'>,
  detail?: string,
): PassportTxResponse {
  return createPassportTxResponse(pair, {
    status: 'failed',
    error,
    ...(detail === undefined ? {} : { detail: detail.slice(0, MAX_DETAIL_LENGTH) }),
  });
}

/* ---------------------------------------------------------------------------
 * Incentive reports
 * ------------------------------------------------------------------------ */

/**
 * An app's report that it granted the user something.
 *
 * UNAUTHENTICATED BY CONSTRUCTION, and the SDK says so rather than shipping it
 * as a feature: the app asserts it granted something and Passport records the
 * assertion verbatim. There is no proof, and nothing downstream should treat
 * one of these as evidence that anything was granted. It exists so a demo can
 * show the loop; a production incentive belongs on a chain or behind a signed
 * receipt.
 */
export function readPassportIncentiveReport(
  value: unknown,
): PassportParseResult<PassportIncentiveReport> {
  const head = preamble(value, 'passport.incentive.report');
  if (head.kind !== 'ok') return head;
  const { record, version } = head;

  if (!isBoundedString(record.requestId, MAX_ID_LENGTH)) {
    return malformed('requestId is missing or too long');
  }
  if (!isBoundedString(record.nonce, MAX_ID_LENGTH)) {
    return malformed('nonce is missing or too long');
  }
  if (!isRecord(record.incentive)) return malformed('incentive is missing');

  const incentive = record.incentive;
  if (!isBoundedString(incentive.id, MAX_ID_LENGTH)) return malformed('incentive.id is missing');
  if (!isBoundedString(incentive.label, MAX_LABEL_LENGTH)) {
    return malformed(`incentive.label must be 1 to ${MAX_LABEL_LENGTH} characters`);
  }
  if (incentive.txId !== undefined && !isBoundedString(incentive.txId, MAX_ID_LENGTH)) {
    return malformed('incentive.txId is too long');
  }

  const report: PassportIncentiveReport = {
    protocol: PASSPORT_TX_PROTOCOL,
    type: 'passport.incentive.report',
    version,
    requestId: record.requestId,
    nonce: record.nonce,
    incentive: { id: incentive.id, label: incentive.label },
  };
  if (typeof incentive.txId === 'string' && incentive.txId.length > 0) {
    report.incentive.txId = incentive.txId;
  }
  return ok(report);
}

export function parsePassportIncentiveReport(value: unknown): PassportIncentiveReport | null {
  return orNull(readPassportIncentiveReport(value));
}

export function createPassportIncentiveReport(input: {
  requestId: string;
  nonce: string;
  id: string;
  label: string;
  txId?: string;
}): PassportIncentiveReport {
  const candidate = {
    protocol: PASSPORT_TX_PROTOCOL,
    type: 'passport.incentive.report',
    version: PASSPORT_PROTOCOL_VERSION,
    requestId: input.requestId,
    nonce: input.nonce,
    incentive: {
      id: input.id,
      label: input.label,
      ...(input.txId === undefined ? {} : { txId: input.txId }),
    },
  };
  const parsed = readPassportIncentiveReport(candidate);
  if (parsed.kind !== 'ok') {
    throw new PassportProtocolError(
      'invalid-request',
      passportParseFailureReason(parsed),
    );
  }
  return parsed.value;
}

/* ---------------------------------------------------------------------------
 * Formatting
 * ------------------------------------------------------------------------ */

/**
 * Atomic NIGHT to display NIGHT, by string arithmetic. Never a float: an
 * amount that has been through a double is an amount that may be wrong in the
 * last digit, and the last digit of a payment is somebody's money.
 */
export function formatNight(atomic: string): string {
  const digits = atomic.replace(/^0+(?=\d)/, '').padStart(NIGHT_DECIMALS + 1, '0');
  const whole = digits.slice(0, digits.length - NIGHT_DECIMALS);
  const fraction = digits.slice(digits.length - NIGHT_DECIMALS).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
