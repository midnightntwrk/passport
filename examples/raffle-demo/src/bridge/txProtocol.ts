/* ---------------------------------------------------------------------------
 * VENDORED — do not edit here.
 *
 * Source: midnight-passport-dynamic-signing, demo-backend/src/txProtocol.ts
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

/**
 * Passport transaction request bridge.
 *
 * A framed app cannot reach into Passport's wallet, and Passport will not let
 * it: the only thing an app may do is *ask* for a transaction, in the same
 * shape every time, and wait for Passport to come back with either a real node
 * transaction identifier or a named refusal.
 *
 * Sibling of `profileProtocol.ts`, and deliberately the same defensive style:
 * strict parsers over untrusted `postMessage` data, every reply bound to the
 * `requestId`/`nonce` pair the app minted, and every string length-capped so a
 * hostile app cannot push megabytes of text into Passport's UI.
 *
 * Address *validity* is intentionally not checked here — this package carries
 * no Midnight SDK dependency. Passport decodes the recipient against its own
 * live wallet network before it will show an approval sheet, which is the only
 * place that check can be made honestly.
 *
 * The reply may additionally state that the network fee was covered by a
 * sponsor (`sponsored`, `feeNote`). Both are optional and both are additive:
 * a reply that omits them is exactly the reply this protocol carried before
 * sponsorship existed. `sponsored: true` is only mintable and only parseable on
 * a `submitted` reply, for the same reason `submitted` requires a real `txId` —
 * there is no covered fee on a transaction that does not exist.
 */

export const PASSPORT_TX_PROTOCOL = 'org.midnight.passport.tx/v1' as const;

/** Shared with the profile protocol: ids and nonces are capped at 256 chars. */
const MAX_ID_LENGTH = 256;
const MAX_PURPOSE_LENGTH = 140;
const MAX_ADDRESS_LENGTH = 200;
const MAX_DETAIL_LENGTH = 400;
const MAX_LABEL_LENGTH = 80;
const MAX_FEE_NOTE_LENGTH = 140;

/** Atomic NIGHT units, base-10, no sign, no exponent, no decimal point. */
const AMOUNT_PATTERN = /^[0-9]{1,20}$/;

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
  requestId: string;
  nonce: string;
  intent: PassportTxIntent;
}

export type PassportTxErrorCode =
  | 'declined'
  | 'insufficient-funds'
  | 'wallet-unavailable'
  | 'invalid-request'
  | 'network-mismatch'
  | 'submit-failed';

export const PASSPORT_TX_ERROR_CODES: readonly PassportTxErrorCode[] = [
  'declined',
  'insufficient-funds',
  'wallet-unavailable',
  'invalid-request',
  'network-mismatch',
  'submit-failed',
];

export interface PassportTxResponse {
  protocol: typeof PASSPORT_TX_PROTOCOL;
  type: 'passport.tx.response';
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
   * Optional and additive: absent means "not stated", which an app must read as
   * an ordinary, user-paid transaction. An app may render "network fee covered"
   * for `true` and for nothing else — and Passport may only set `true` when the
   * submitted transaction really came back from the sponsor. Anything looser
   * would let the demo claim a free transaction it did not get.
   */
  sponsored?: boolean;
  /** Optional human-readable note about the fee, e.g. who covered it. */
  feeNote?: string;
}

export interface PassportIncentiveReport {
  protocol: typeof PASSPORT_TX_PROTOCOL;
  type: 'passport.incentive.report';
  requestId: string;
  nonce: string;
  incentive: {
    id: string;
    label: string;
    txId?: string;
  };
}

export type PassportTxMessage =
  | PassportTxRequest
  | PassportTxResponse
  | PassportIncentiveReport;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function isPassportTxErrorCode(value: unknown): value is PassportTxErrorCode {
  return (
    typeof value === 'string' && (PASSPORT_TX_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Parses an app's transaction request. Returns `null` — never throws, never a
 * partially-filled object — for anything that is not exactly a well-formed
 * request for a positive unshielded NIGHT transfer.
 */
export function parsePassportTxRequest(value: unknown): PassportTxRequest | null {
  if (!isRecord(value)) return null;
  if (
    value.protocol !== PASSPORT_TX_PROTOCOL ||
    value.type !== 'passport.tx.request' ||
    !isBoundedString(value.requestId, MAX_ID_LENGTH) ||
    !isBoundedString(value.nonce, MAX_ID_LENGTH) ||
    !isRecord(value.intent)
  ) {
    return null;
  }

  const intent = value.intent;
  if (intent.kind !== 'unshielded-transfer') return null;
  if (!isBoundedString(intent.recipientAddress, MAX_ADDRESS_LENGTH)) return null;
  /* `amount` is a string on the wire on purpose: a JSON number cannot carry
     atomic units without precision loss, and a bigint does not survive
     structured cloning across every browser we care about. */
  if (typeof intent.amount !== 'string' || !AMOUNT_PATTERN.test(intent.amount)) return null;
  /* Reject 0 and every padded form of it — an approval sheet for a zero-value
     transfer would be a lie about what the user is agreeing to. */
  if (/^0+$/.test(intent.amount)) return null;
  if (!isBoundedString(intent.purpose, MAX_PURPOSE_LENGTH)) return null;

  return {
    protocol: PASSPORT_TX_PROTOCOL,
    type: 'passport.tx.request',
    requestId: value.requestId,
    nonce: value.nonce,
    intent: {
      kind: 'unshielded-transfer',
      recipientAddress: intent.recipientAddress,
      amount: intent.amount,
      purpose: intent.purpose,
    },
  };
}

/**
 * Builds the reply to `request`, binding it to that request's id and nonce so
 * an app can never mistake one exchange's outcome for another's.
 */
export function createPassportTxResponse(
  request: PassportTxRequest,
  body: Omit<PassportTxResponse, 'protocol' | 'type' | 'requestId' | 'nonce'>,
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
    requestId: request.requestId,
    nonce: request.nonce,
    ...body,
  };
}

/** Parses Passport's reply. The app should additionally match id and nonce. */
export function parsePassportTxResponse(value: unknown): PassportTxResponse | null {
  if (!isRecord(value)) return null;
  if (
    value.protocol !== PASSPORT_TX_PROTOCOL ||
    value.type !== 'passport.tx.response' ||
    !isBoundedString(value.requestId, MAX_ID_LENGTH) ||
    !isBoundedString(value.nonce, MAX_ID_LENGTH)
  ) {
    return null;
  }
  if (value.status !== 'submitted' && value.status !== 'declined' && value.status !== 'failed') {
    return null;
  }
  if (value.status === 'submitted') {
    if (!isBoundedString(value.txId, MAX_ID_LENGTH)) return null;
  } else if (!isPassportTxErrorCode(value.error)) {
    return null;
  }
  if (value.detail !== undefined && !isBoundedString(value.detail, MAX_DETAIL_LENGTH)) {
    return null;
  }
  /* Additive, and strictly so: absent is fine, present must be a real boolean.
     A truthy string like `"false"` must not be able to buy a "fee covered"
     badge, so anything that is not a boolean rejects the whole reply. */
  if (value.sponsored !== undefined && typeof value.sponsored !== 'boolean') return null;
  /* And a covered fee is only meaningful on a transaction that exists. */
  if (value.sponsored === true && value.status !== 'submitted') return null;
  if (value.feeNote !== undefined && !isBoundedString(value.feeNote, MAX_FEE_NOTE_LENGTH)) {
    return null;
  }

  const response: PassportTxResponse = {
    protocol: PASSPORT_TX_PROTOCOL,
    type: 'passport.tx.response',
    requestId: value.requestId,
    nonce: value.nonce,
    status: value.status,
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
  if (value.status === 'submitted') {
    if (typeof value.txId === 'string' && value.txId.length > 0) response.txId = value.txId;
  } else if (isPassportTxErrorCode(value.error)) {
    response.error = value.error;
  }
  if (typeof value.detail === 'string' && value.detail.length > 0) response.detail = value.detail;
  if (typeof value.sponsored === 'boolean') response.sponsored = value.sponsored;
  if (typeof value.feeNote === 'string' && value.feeNote.length > 0) {
    response.feeNote = value.feeNote;
  }
  return response;
}

/**
 * Parses an app's report that it granted the user something. Passport records
 * these; it never invents them on an app's behalf.
 */
export function parsePassportIncentiveReport(value: unknown): PassportIncentiveReport | null {
  if (!isRecord(value)) return null;
  if (
    value.protocol !== PASSPORT_TX_PROTOCOL ||
    value.type !== 'passport.incentive.report' ||
    !isBoundedString(value.requestId, MAX_ID_LENGTH) ||
    !isBoundedString(value.nonce, MAX_ID_LENGTH) ||
    !isRecord(value.incentive)
  ) {
    return null;
  }
  const incentive = value.incentive;
  if (!isBoundedString(incentive.id, MAX_ID_LENGTH)) return null;
  if (!isBoundedString(incentive.label, MAX_LABEL_LENGTH)) return null;
  if (
    incentive.txId !== undefined &&
    !isBoundedString(incentive.txId, MAX_ID_LENGTH)
  ) {
    return null;
  }

  const report: PassportIncentiveReport = {
    protocol: PASSPORT_TX_PROTOCOL,
    type: 'passport.incentive.report',
    requestId: value.requestId,
    nonce: value.nonce,
    incentive: { id: incentive.id, label: incentive.label },
  };
  if (typeof incentive.txId === 'string' && incentive.txId.length > 0) {
    report.incentive.txId = incentive.txId;
  }
  return report;
}
