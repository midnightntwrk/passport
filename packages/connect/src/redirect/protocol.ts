/* ===========================================================================
 * `org.midnight.passport.callback/v1` — the signed redirect channel
 * ===========================================================================
 *
 * The third protocol, and the one nobody had been calling a protocol. It
 * exists because a phone discards the tab that navigated away: the pop-up flow
 * is a conversation between two live windows, and a discarded tab has no
 * window reference to answer through. This exchange has to survive
 * NAVIGATION, not merely survive a message, so it is a full-page redirect in
 * both directions with the reply carried in the URL fragment.
 *
 * A fragment is not sent to the receiving server, so the reply does not land
 * in the app's access logs, its reverse proxy's logs, or its analytics. The
 * query string would put it in all three.
 *
 * The fragment crosses an untrusted channel — the user's own address bar — so
 * the reply is SIGNED with the Passport wallet's unshielded key. Established
 * against the SDK in this repository (2026/08/19):
 *
 *   - `unshieldedKeystore.signData(bytes)` is BIP-340 Schnorr over secp256k1
 *     applied to `sha256(bytes)`, returning 64 bytes as 128 hex characters.
 *   - `unshieldedKeystore.getPublicKey()` is the 32-byte x-only BIP-340
 *     verifying key as 64 hex characters.
 *   - The unshielded ADDRESS is `sha256(verifyingKey)`, bech32m-encoded with
 *     the HRP `mn_addr[_<network>]`.
 *
 * All three are checkable in a plain web page with three small pure-JavaScript
 * libraries and no WebAssembly, which is the entire reason this channel is
 * interesting: a Midnight identity verifies inside an ordinary web page.
 *
 * ---------------------------------------------------------------------------
 * TWO EXCHANGES NOW, NOT ONE
 * ---------------------------------------------------------------------------
 *
 * The channel used to be profile-only, which left the phone path — the one a
 * QR code lands on — as exactly the path that could not complete a payment
 * without falling back to a pop-up the phone may discard. So there is a second
 * exchange on the same channel, with the same integrity rules:
 *
 *   profile  ?passportCallback=&passportFields=&passportState=
 *            → #passportResponse= | #passportError=
 *   payment  ?passportTxCallback=&passportTxRecipient=&passportTxAmount=
 *            &passportTxPurpose=&passportTxState=
 *            → #passportTxResponse= | #passportTxError=
 *
 * Distinct parameter names, deliberately, for the same reason the pop-up
 * launch contracts have distinct names: one navigation serves one exchange,
 * and a payment launch must not be able to arm the profile consent surface.
 *
 * The payment reply ECHOES THE INTENT it is answering, inside the signed
 * bytes. Without that echo a signed "submitted" is a signature over a claim
 * with no subject — it would prove a Passport said something, not that it paid
 * what this app asked it to pay. The receiver checks the echo against what it
 * sent, and the same honesty invariants the postMessage protocol enforces
 * apply here too: `submitted` requires a `txId`, `sponsored: true` is only
 * possible on `submitted`.
 * ========================================================================= */

import {
  MAX_DETAIL_LENGTH,
  MAX_FEE_NOTE_LENGTH,
  MAX_PROFILE_ADDRESS_LENGTH,
  MAX_PURPOSE_LENGTH,
  MAX_STRING_LENGTH,
  MAX_TX_RECIPIENT_ADDRESS_LENGTH,
} from '../protocol/limits.js';
import { PASSPORT_PROFILE_FIELDS, type PassportProfileField } from '../protocol/profile.js';
import { isPassportTxErrorCode, type PassportTxErrorCode } from '../protocol/errors.js';
import { PASSPORT_PROTOCOL_VERSION, isRecord } from '../protocol/version.js';
import { fromBase64Url } from './encoding.js';

export const PASSPORT_CALLBACK_PROTOCOL = 'org.midnight.passport.callback/v1' as const;

/**
 * The signature scheme name that travels on the wire. It names the curve, the
 * signature construction, and the pre-hash, because "signed with the Midnight
 * key" is not something a receiver can implement.
 */
export const PASSPORT_CALLBACK_SIGNATURE_SCHEME = 'bip340-schnorr-secp256k1-sha256' as const;

/** The profile launch and return parameters. */
export const PASSPORT_CALLBACK_PARAM = 'passportCallback' as const;
export const PASSPORT_CALLBACK_FIELDS_PARAM = 'passportFields' as const;
export const PASSPORT_CALLBACK_STATE_PARAM = 'passportState' as const;
export const PASSPORT_CALLBACK_RESPONSE_PARAM = 'passportResponse' as const;
export const PASSPORT_CALLBACK_ERROR_PARAM = 'passportError' as const;

/** The payment launch and return parameters. Deliberately different names. */
export const PASSPORT_TX_CALLBACK_PARAM = 'passportTxCallback' as const;
export const PASSPORT_TX_CALLBACK_RECIPIENT_PARAM = 'passportTxRecipient' as const;
export const PASSPORT_TX_CALLBACK_AMOUNT_PARAM = 'passportTxAmount' as const;
export const PASSPORT_TX_CALLBACK_PURPOSE_PARAM = 'passportTxPurpose' as const;
export const PASSPORT_TX_CALLBACK_STATE_PARAM = 'passportTxState' as const;
export const PASSPORT_TX_CALLBACK_RESPONSE_PARAM = 'passportTxResponse' as const;
export const PASSPORT_TX_CALLBACK_ERROR_PARAM = 'passportTxError' as const;

/**
 * The requestable vocabulary, borrowed wholesale from the pop-up flow. One
 * vocabulary across both channels: an app must not be able to reach data
 * through a redirect that a pop-up would not have shared. The `satisfies`
 * makes that a compile-time fact rather than a comment.
 */
export const PASSPORT_CALLBACK_FIELDS = [
  'displayName',
  'passportContract',
] as const satisfies readonly PassportProfileField[];

export type PassportCallbackField = (typeof PASSPORT_CALLBACK_FIELDS)[number];

/* The other direction of the same check: every real profile field is named
   here, so a field added to the profile protocol cannot be silently
   unreachable over the redirect channel. */
type VocabularyIsComplete = PassportProfileField extends PassportCallbackField ? true : never;
const VOCABULARY_IS_COMPLETE: VocabularyIsComplete = true;
void VOCABULARY_IS_COMPLETE;
void PASSPORT_PROFILE_FIELDS;

/** Default freshness window a receiver applies to `issuedAt`. */
export const PASSPORT_CALLBACK_DEFAULT_MAX_AGE_MS = 5 * 60_000;

/** One minute of forward tolerance absorbs ordinary clock skew. */
export const PASSPORT_CALLBACK_CLOCK_SKEW_MS = 60_000;

export type PassportCallbackProfile = Partial<{
  displayName: string;
  passportContract: { address: string; network: string };
}>;

export interface PassportCallbackProfilePayload {
  readonly protocol: typeof PASSPORT_CALLBACK_PROTOCOL;
  readonly type: 'passport.callback.profile';
  readonly version: number;
  /** The origin this reply was issued FOR. A receiver must check it is itself. */
  readonly audience: string;
  readonly state?: string;
  readonly issuedAt: number;
  readonly nonce: string;
  readonly fields: readonly PassportCallbackField[];
  readonly profile: PassportCallbackProfile;
}

export interface PassportCallbackTxIntent {
  readonly kind: 'unshielded-transfer';
  readonly recipientAddress: string;
  readonly amount: string;
  readonly purpose: string;
}

export interface PassportCallbackTxPayload {
  readonly protocol: typeof PASSPORT_CALLBACK_PROTOCOL;
  readonly type: 'passport.callback.tx';
  readonly version: number;
  readonly audience: string;
  readonly state?: string;
  readonly issuedAt: number;
  readonly nonce: string;
  /** Echoed from the launch, inside the signed bytes. See the header. */
  readonly intent: PassportCallbackTxIntent;
  readonly status: 'submitted' | 'declined' | 'failed';
  readonly txId?: string;
  readonly error?: PassportTxErrorCode;
  readonly detail?: string;
  readonly sponsored?: boolean;
  readonly feeNote?: string;
}

export type PassportCallbackPayload = PassportCallbackProfilePayload | PassportCallbackTxPayload;

export interface PassportCallbackEnvelope {
  readonly protocol: typeof PASSPORT_CALLBACK_PROTOCOL;
  readonly type: 'passport.callback.response';
  /** base64url of the exact bytes that were signed. */
  readonly payload: string;
  readonly scheme: typeof PASSPORT_CALLBACK_SIGNATURE_SCHEME | 'none';
  readonly publicKey?: string;
  readonly signature?: string;
}

export type PassportCallbackErrorCode = 'denied' | 'profile_unavailable';

/** What a receiver finds in its own fragment on return. */
export type PassportCallbackReturn =
  | { readonly kind: 'absent' }
  /**
   * A refusal. UNAUTHENTICATED by construction — there is no payload to sign,
   * because nothing was shared. Treat it as "stop waiting", never as a fact.
   */
  | { readonly kind: 'error'; readonly code: string; readonly state: string | null }
  | { readonly kind: 'response'; readonly envelope: PassportCallbackEnvelope }
  | { readonly kind: 'malformed'; readonly reason: string };

const MAX_ADDRESS_LENGTH = MAX_PROFILE_ADDRESS_LENGTH;
const AMOUNT_PATTERN = /^[0-9]{1,20}$/;

function isHex(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/i.test(value);
}

function readVersion(value: Record<string, unknown>): number | null {
  if (value.version === undefined) return PASSPORT_PROTOCOL_VERSION;
  if (typeof value.version !== 'number' || !Number.isSafeInteger(value.version)) return null;
  return value.version === PASSPORT_PROTOCOL_VERSION ? value.version : null;
}

/* ---------------------------------------------------------------------------
 * The envelope, off the fragment
 * ------------------------------------------------------------------------ */

function parseEnvelope(raw: string): PassportCallbackReturn {
  const bytes = fromBase64Url(raw);
  if (!bytes) return { kind: 'malformed', reason: 'the reply is not base64url' };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { kind: 'malformed', reason: 'the reply is not JSON' };
  }
  if (!isRecord(value)) return { kind: 'malformed', reason: 'the reply is not an object' };
  if (value.protocol !== PASSPORT_CALLBACK_PROTOCOL) {
    return { kind: 'malformed', reason: 'the reply is not this protocol' };
  }
  if (value.type !== 'passport.callback.response') {
    return { kind: 'malformed', reason: 'the reply is not a response' };
  }
  if (typeof value.payload !== 'string' || value.payload.length === 0) {
    return { kind: 'malformed', reason: 'the reply carries no payload' };
  }
  if (value.scheme === 'none') {
    return {
      kind: 'response',
      envelope: {
        protocol: PASSPORT_CALLBACK_PROTOCOL,
        type: 'passport.callback.response',
        payload: value.payload,
        scheme: 'none',
      },
    };
  }
  if (value.scheme !== PASSPORT_CALLBACK_SIGNATURE_SCHEME) {
    return {
      kind: 'malformed',
      reason: 'the reply names a signature scheme this app cannot check',
    };
  }
  /* 32-byte x-only verifying key, 64-byte signature. Lengths are checked here
     so a curve implementation is never handed something shapeless. */
  if (!isHex(value.publicKey, 64) || !isHex(value.signature, 128)) {
    return { kind: 'malformed', reason: 'the signature or key is malformed' };
  }
  return {
    kind: 'response',
    envelope: {
      protocol: PASSPORT_CALLBACK_PROTOCOL,
      type: 'passport.callback.response',
      payload: value.payload,
      scheme: PASSPORT_CALLBACK_SIGNATURE_SCHEME,
      publicKey: value.publicKey,
      signature: value.signature,
    },
  };
}

function parseReturn(
  hash: string,
  errorParam: string,
  stateParam: string,
  responseParam: string,
): PassportCallbackReturn {
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const error = fragment.get(errorParam);
  if (error !== null) {
    return {
      kind: 'error',
      code: error.slice(0, MAX_STRING_LENGTH),
      state: fragment.get(stateParam),
    };
  }
  const raw = fragment.get(responseParam);
  if (raw === null) return { kind: 'absent' };
  return parseEnvelope(raw);
}

/** Reads a PROFILE reply out of a fragment. Total; never throws. */
export function parsePassportCallbackReturn(hash: string): PassportCallbackReturn {
  return parseReturn(
    hash,
    PASSPORT_CALLBACK_ERROR_PARAM,
    PASSPORT_CALLBACK_STATE_PARAM,
    PASSPORT_CALLBACK_RESPONSE_PARAM,
  );
}

/** Reads a PAYMENT reply out of a fragment. Total; never throws. */
export function parsePassportTxCallbackReturn(hash: string): PassportCallbackReturn {
  return parseReturn(
    hash,
    PASSPORT_TX_CALLBACK_ERROR_PARAM,
    PASSPORT_TX_CALLBACK_STATE_PARAM,
    PASSPORT_TX_CALLBACK_RESPONSE_PARAM,
  );
}

/* ---------------------------------------------------------------------------
 * The payloads, once the signature has been checked
 * ------------------------------------------------------------------------ */

function commonPayloadFields(
  value: Record<string, unknown>,
): { audience: string; state?: string; issuedAt: number; nonce: string; version: number } | null {
  const version = readVersion(value);
  if (version === null) return null;
  if (typeof value.audience !== 'string' || value.audience.length === 0) return null;
  if (typeof value.issuedAt !== 'number' || !Number.isFinite(value.issuedAt)) return null;
  if (typeof value.nonce !== 'string' || value.nonce.length === 0) return null;
  if (value.state !== undefined && typeof value.state !== 'string') return null;
  return {
    audience: value.audience,
    ...(typeof value.state === 'string' ? { state: value.state } : {}),
    issuedAt: value.issuedAt,
    nonce: value.nonce,
    version,
  };
}

export function parsePassportCallbackProfilePayload(
  value: unknown,
): PassportCallbackProfilePayload | null {
  if (!isRecord(value)) return null;
  if (value.protocol !== PASSPORT_CALLBACK_PROTOCOL) return null;
  if (value.type !== 'passport.callback.profile') return null;
  const common = commonPayloadFields(value);
  if (!common) return null;
  if (!Array.isArray(value.fields) || !isRecord(value.profile)) return null;

  const fields = value.fields.filter(
    (field): field is PassportCallbackField =>
      typeof field === 'string' && (PASSPORT_CALLBACK_FIELDS as readonly string[]).includes(field),
  );
  if (fields.length === 0 || fields.length !== value.fields.length) return null;

  const source = value.profile;
  const profile: PassportCallbackProfile = {};
  if (source.displayName !== undefined) {
    if (typeof source.displayName !== 'string' || source.displayName.length > MAX_STRING_LENGTH) {
      return null;
    }
    profile.displayName = source.displayName;
  }
  if (source.passportContract !== undefined) {
    const contract = source.passportContract;
    if (
      !isRecord(contract) ||
      typeof contract.address !== 'string' ||
      contract.address.length > MAX_ADDRESS_LENGTH ||
      typeof contract.network !== 'string' ||
      contract.network.length > MAX_STRING_LENGTH
    ) {
      return null;
    }
    profile.passportContract = { address: contract.address, network: contract.network };
  }
  return {
    protocol: PASSPORT_CALLBACK_PROTOCOL,
    type: 'passport.callback.profile',
    ...common,
    fields,
    profile,
  };
}

export function parsePassportCallbackTxPayload(value: unknown): PassportCallbackTxPayload | null {
  if (!isRecord(value)) return null;
  if (value.protocol !== PASSPORT_CALLBACK_PROTOCOL) return null;
  if (value.type !== 'passport.callback.tx') return null;
  const common = commonPayloadFields(value);
  if (!common) return null;
  if (!isRecord(value.intent)) return null;

  const intent = value.intent;
  if (intent.kind !== 'unshielded-transfer') return null;
  if (
    typeof intent.recipientAddress !== 'string' ||
    intent.recipientAddress.length === 0 ||
    intent.recipientAddress.length > MAX_TX_RECIPIENT_ADDRESS_LENGTH
  ) {
    return null;
  }
  if (typeof intent.amount !== 'string' || !AMOUNT_PATTERN.test(intent.amount)) return null;
  if (/^0+$/.test(intent.amount)) return null;
  if (
    typeof intent.purpose !== 'string' ||
    intent.purpose.length === 0 ||
    intent.purpose.length > MAX_PURPOSE_LENGTH
  ) {
    return null;
  }
  if (value.status !== 'submitted' && value.status !== 'declined' && value.status !== 'failed') {
    return null;
  }
  /* The same honesty invariants the postMessage protocol enforces. A signature
     over a dishonest claim is a signed lie, so they are checked here too. */
  if (value.status === 'submitted') {
    if (typeof value.txId !== 'string' || value.txId.length === 0) return null;
    if (value.txId.length > MAX_STRING_LENGTH) return null;
  } else if (!isPassportTxErrorCode(value.error)) {
    return null;
  }
  if (
    value.detail !== undefined &&
    (typeof value.detail !== 'string' || value.detail.length > MAX_DETAIL_LENGTH)
  ) {
    return null;
  }
  if (value.sponsored !== undefined && typeof value.sponsored !== 'boolean') return null;
  if (value.sponsored === true && value.status !== 'submitted') return null;
  if (
    value.feeNote !== undefined &&
    (typeof value.feeNote !== 'string' || value.feeNote.length > MAX_FEE_NOTE_LENGTH)
  ) {
    return null;
  }

  return {
    protocol: PASSPORT_CALLBACK_PROTOCOL,
    type: 'passport.callback.tx',
    ...common,
    intent: {
      kind: 'unshielded-transfer',
      recipientAddress: intent.recipientAddress,
      amount: intent.amount,
      purpose: intent.purpose,
    },
    status: value.status,
    /* Copied only onto the status that can honestly carry it, exactly as the
       postMessage parser does. */
    ...(value.status === 'submitted'
      ? { txId: value.txId as string }
      : { error: value.error as PassportTxErrorCode }),
    ...(typeof value.detail === 'string' && value.detail.length > 0
      ? { detail: value.detail }
      : {}),
    ...(typeof value.sponsored === 'boolean' ? { sponsored: value.sponsored } : {}),
    ...(typeof value.feeNote === 'string' && value.feeNote.length > 0
      ? { feeNote: value.feeNote }
      : {}),
  };
}
