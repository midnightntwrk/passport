/* ===========================================================================
 * Verifying a reply, in the only order that is safe
 * ===========================================================================
 *
 * Bytes, then signature, then meaning. Nothing in the payload is read as a
 * fact before the signature over it has been checked, because a payload that
 * has not been verified is a string an attacker wrote.
 *
 * Every step is APPENDED to `checks` whether it passes or fails, so a page can
 * show its work rather than a green tick. The first failure still stops the
 * walk — the trail says what was checked and where it stopped, and it never
 * claims to have checked something it skipped. That reporting is demonstration
 * scaffolding; a production app keeps the checks and drops the trail.
 * ========================================================================= */

import { passportErrorMessage } from '../protocol/errors.js';
import { fromBase64Url } from './encoding.js';
import { verifyPassportKeyBinding, verifyPassportSignature } from './crypto.js';
import {
  PASSPORT_CALLBACK_CLOCK_SKEW_MS,
  PASSPORT_CALLBACK_DEFAULT_MAX_AGE_MS,
  PASSPORT_CALLBACK_SIGNATURE_SCHEME,
  parsePassportCallbackProfilePayload,
  parsePassportCallbackTxPayload,
  type PassportCallbackEnvelope,
  type PassportCallbackProfilePayload,
  type PassportCallbackTxIntent,
  type PassportCallbackTxPayload,
} from './protocol.js';

export interface PassportCallbackCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface PassportCallbackVerifyOptions {
  /** This app's OWN origin. Anything else means the reply is not for it. */
  readonly expectedAudience: string;
  /** The state this app sent. `null` only if it genuinely sent none. */
  readonly expectedState: string | null;
  /** Returns true if this nonce has been accepted before. */
  readonly seenNonce?: (nonce: string) => boolean;
  /** Defaults to true. False accepts `scheme: 'none'` as a stated downgrade. */
  readonly requireSignature?: boolean;
  readonly maxAgeMs?: number;
  readonly now?: number;
  /**
   * The address this receiver already believes belongs to the signing
   * Passport, from an earlier visit. When given, the reply's key is checked
   * against it — which is what turns "somebody signed this" into "the same
   * Passport as last time signed this".
   */
  readonly expectedSignerAddress?: string;
}

export interface PassportTxCallbackVerifyOptions extends PassportCallbackVerifyOptions {
  /** What this app asked to be paid. The reply must echo it exactly. */
  readonly expectedIntent: PassportCallbackTxIntent;
}

export type PassportCallbackVerdict<T> =
  | { readonly ok: true; readonly payload: T; readonly signed: boolean; readonly checks: PassportCallbackCheck[] }
  | { readonly ok: false; readonly reason: string; readonly checks: PassportCallbackCheck[] };

/**
 * The shared walk: decode, verify, parse, audience, state, freshness, replay.
 * Both exchanges on this channel are checked by exactly these rules, so a
 * payment reply is no easier to forge than a profile reply.
 */
function walk<T extends PassportCallbackProfilePayload | PassportCallbackTxPayload>(
  envelope: PassportCallbackEnvelope,
  options: PassportCallbackVerifyOptions,
  parsePayload: (value: unknown) => T | null,
): PassportCallbackVerdict<T> & { readonly signerKey?: string } {
  const checks: PassportCallbackCheck[] = [];
  const fail = (reason: string): PassportCallbackVerdict<T> => ({ ok: false, reason, checks });
  const record = (label: string, ok: boolean, detail?: string): boolean => {
    checks.push({ label, ok, ...(detail === undefined ? {} : { detail }) });
    return ok;
  };

  const bytes = fromBase64Url(envelope.payload);
  if (!record('Payload decodes as base64url', Boolean(bytes), `${envelope.payload.length} chars`)) {
    return fail('the payload is not base64url');
  }

  const requireSignature = options.requireSignature !== false;
  let signed = false;
  if (envelope.scheme === PASSPORT_CALLBACK_SIGNATURE_SCHEME) {
    if (!envelope.publicKey || !envelope.signature) {
      record('Signature present', false);
      return fail('the reply claims a signature it does not carry');
    }
    let valid = false;
    try {
      valid = verifyPassportSignature(envelope.publicKey, bytes!, envelope.signature);
    } catch (cause) {
      record('BIP-340 signature over sha256(payload)', false, String(cause));
      return fail('the signature could not be checked');
    }
    if (
      !record(
        'BIP-340 signature over sha256(payload)',
        valid,
        PASSPORT_CALLBACK_SIGNATURE_SCHEME,
      )
    ) {
      return fail('the signature does not match the payload');
    }
    signed = true;
  } else if (
    !record(
      'Reply is signed',
      !requireSignature,
      'unsigned (scheme "none") — accepted only because this app was configured to allow it',
    )
  ) {
    return fail('the reply is unsigned and this app requires a signature');
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes!));
  } catch {
    record('Payload parses as JSON', false);
    return fail('the payload is not JSON');
  }
  const payload = parsePayload(value);
  if (!record('Payload is a well-formed reply', Boolean(payload))) {
    return fail('the payload is not a well-formed reply');
  }

  if (
    !record('Audience is this app', payload!.audience === options.expectedAudience, payload!.audience)
  ) {
    return fail('the reply was issued for a different origin');
  }

  const returnedState = payload!.state ?? null;
  if (!record('State echoes what was sent', returnedState === options.expectedState)) {
    return fail('the reply does not echo the state that was sent');
  }

  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? PASSPORT_CALLBACK_DEFAULT_MAX_AGE_MS;
  const ageMs = now - payload!.issuedAt;
  /* Both directions: a reply dated in the future is as wrong as a stale one,
     and one minute of forward tolerance absorbs ordinary clock skew between
     two devices. */
  if (
    !record(
      'Issued recently',
      ageMs <= maxAge && payload!.issuedAt <= now + PASSPORT_CALLBACK_CLOCK_SKEW_MS,
      `${Math.round(ageMs / 1000)}s old`,
    )
  ) {
    return fail(ageMs > maxAge ? 'the reply is too old' : 'the reply is dated in the future');
  }

  const replayed = options.seenNonce?.(payload!.nonce) ?? false;
  if (!record('Nonce not seen before', !replayed, payload!.nonce)) {
    return fail('this reply has already been used');
  }

  /* LAST, and only now that the payload is trusted. There is no address in the
     payload to bind to any more — the engine addresses left the vocabulary —
     so the binding is between the signing key and the address this receiver
     already associated with this Passport, when it has one. That is the check
     that says "the same Passport as last time", and when there is no earlier
     visit the trail says so rather than implying a check happened. */
  if (signed && options.expectedSignerAddress) {
    if (
      !record(
        'Signing key is the Passport this app already knows',
        verifyPassportKeyBinding(envelope.publicKey!, options.expectedSignerAddress),
        'sha256(verifying key) = bech32m payload',
      )
    ) {
      return fail('the reply was signed by a different Passport');
    }
  } else {
    record(
      'Signing key is the Passport this app already knows',
      true,
      signed
        ? 'first visit — the key is recorded now and checked on the next one'
        : 'reply is unsigned',
    );
  }

  return {
    ok: true,
    payload: payload!,
    signed,
    checks,
    ...(envelope.publicKey === undefined ? {} : { signerKey: envelope.publicKey }),
  };
}

/** Verifies a PROFILE reply. */
export function verifyPassportCallbackReply(
  envelope: PassportCallbackEnvelope,
  options: PassportCallbackVerifyOptions,
): PassportCallbackVerdict<PassportCallbackProfilePayload> & { readonly signerKey?: string } {
  return walk(envelope, options, parsePassportCallbackProfilePayload);
}

/**
 * Verifies a PAYMENT reply, with one check the profile flow does not need: the
 * echoed intent.
 *
 * A signed `submitted` with no subject would prove that a Passport said
 * something, not that it paid what this app asked it to pay. The intent
 * travels inside the signed bytes and is compared field by field with what
 * this app sent, so a reply cannot be lifted from one payment onto another.
 */
export function verifyPassportTxCallbackReply(
  envelope: PassportCallbackEnvelope,
  options: PassportTxCallbackVerifyOptions,
): PassportCallbackVerdict<PassportCallbackTxPayload> & { readonly signerKey?: string } {
  const verdict = walk(envelope, options, parsePassportCallbackTxPayload);
  if (!verdict.ok) return verdict;

  const wanted = options.expectedIntent;
  const got = verdict.payload.intent;
  const matches =
    got.kind === wanted.kind &&
    got.recipientAddress === wanted.recipientAddress &&
    got.amount === wanted.amount &&
    got.purpose === wanted.purpose;
  verdict.checks.push({
    label: 'Reply echoes the payment this app asked for',
    ok: matches,
    detail: `${got.amount} atomic NIGHT to ${got.recipientAddress}`,
  });
  if (!matches) {
    return {
      ok: false,
      reason: 'the reply answers a different payment from the one this app asked for',
      checks: verdict.checks,
    };
  }
  return verdict;
}

/** The sentence for the code on an unauthenticated `#passportError` return. */
export function passportCallbackErrorMessage(code: string): string {
  return passportErrorMessage(code);
}
