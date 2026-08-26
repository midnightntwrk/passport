/* ===========================================================================
 * ClubCoin — the receiving half of Passport's URL-callback contract
 * ===========================================================================
 *
 * Provenance: this is the receiver half of
 * `examples/passport-demo/src/identity/callbackProtocol.ts`, copied the way
 * `examples/passport-app-template/src/bridge/` copies Passport's postMessage
 * protocols. Passport's file is the specification — read its header for the
 * launch and return contract, the reasoning behind the fragment, and the
 * signature scheme. This file is what a third-party app actually ships, and it
 * is the reason the contract is written down as bytes rather than as objects:
 * two independent implementations have to agree, and they only can if the
 * signed thing is transmitted exactly.
 *
 * What is deliberately DIFFERENT here from Passport's copy:
 *
 *   - It carries real crypto. Passport's module takes verification as an
 *     injected function so it can stay portable; an app has to actually do it,
 *     with `@noble/curves` (BIP-340), `@noble/hashes` (sha256), and
 *     `@scure/base` (bech32m). No Midnight dependency and no WebAssembly are
 *     involved — three small pure-JS libraries is the whole cost of verifying
 *     a Midnight identity in a web page.
 *
 *   - It performs the two checks Passport's module documents but cannot do:
 *
 *       KEY BINDING   The unshielded address is `sha256(verifyingKey)` in
 *                     bech32m. So the key that signed the reply is checked
 *                     against the `midnightAddresses.unshielded` value INSIDE
 *                     that same reply. Without this a signature proves only
 *                     that somebody signed something — an attacker could sign
 *                     a payload naming a stranger's address with their own
 *                     key, and every other check would pass.
 *
 *       REPLAY        `nonce` is recorded and refused on second sight, and
 *                     `issuedAt` must be fresh. A signed reply stays valid
 *                     forever otherwise, and it is sitting in the user's own
 *                     browser history where anyone with the device can find
 *                     it.
 *
 *   - Every check reports itself (see {@link PassportCallbackCheck}) so the
 *     page can render the audit trail rather than a green tick. That is
 *     demonstration scaffolding; a production app would keep the checks and
 *     drop the reporting.
 *
 * What this file does NOT do, and no receiver should: trust anything before
 * the signature has been verified. The order below is bytes, signature, then
 * meaning.
 * ========================================================================= */

import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32m } from '@scure/base';

export const PASSPORT_CALLBACK_PROTOCOL = 'org.midnight.passport.callback/v1' as const;
export const PASSPORT_CALLBACK_SIGNATURE_SCHEME = 'bip340-schnorr-secp256k1-sha256' as const;

export const PASSPORT_CALLBACK_FIELDS = [
  'displayName',
  'passportContract',
  'midnightAddresses',
] as const;

export type PassportCallbackField = (typeof PASSPORT_CALLBACK_FIELDS)[number];

export type PassportCallbackProfile = Partial<{
  displayName: string;
  passportContract: { address: string; network: string };
  midnightAddresses: { unshielded: string; shielded?: string; dust?: string };
}>;

export interface PassportCallbackPayload {
  protocol: typeof PASSPORT_CALLBACK_PROTOCOL;
  type: 'passport.callback.profile';
  audience: string;
  state?: string;
  issuedAt: number;
  nonce: string;
  fields: PassportCallbackField[];
  profile: PassportCallbackProfile;
}

export interface PassportCallbackEnvelope {
  protocol: typeof PASSPORT_CALLBACK_PROTOCOL;
  type: 'passport.callback.response';
  payload: string;
  scheme: typeof PASSPORT_CALLBACK_SIGNATURE_SCHEME | 'none';
  publicKey?: string;
  signature?: string;
}

/** Same caps as the protocol. A receiver enforces them too, or it has none. */
const MAX_STRING_LENGTH = 256;
const MAX_ADDRESS_LENGTH = 512;
/** Bech32m's default 90-character limit is well below a Midnight address. */
const BECH32M_LIMIT = 512;

/* ---------------------------------------------------------------------------
 * base64url — same implementation as Passport's, for the same reason: it must
 * behave identically in a browser and in a bare Node drill.
 * ------------------------------------------------------------------------ */

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (text.length === 0 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const standard = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/* ---------------------------------------------------------------------------
 * The launch
 * ------------------------------------------------------------------------ */

/**
 * Builds the URL that sends the user to Passport.
 *
 * `state` is this app's own token. It must be unguessable and it must be
 * remembered somewhere that survives the round trip — the tab that navigates
 * away may be discarded by the phone before it comes back, so `sessionStorage`
 * (which survives tab restore) and not a variable.
 */
export function buildPassportLaunchUrl(input: {
  passportOrigin: string;
  callbackUrl: string;
  fields: readonly PassportCallbackField[];
  state: string;
}): string {
  const target = new URL(input.passportOrigin);
  target.pathname = '/';
  target.searchParams.set('passportCallback', input.callbackUrl);
  target.searchParams.set('passportFields', input.fields.join(','));
  target.searchParams.set('passportState', input.state);
  return target.href;
}

/** 16 random bytes, base64url. Unguessable, and short enough for a URL. */
export function newPassportState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/* ---------------------------------------------------------------------------
 * The return
 * ------------------------------------------------------------------------ */

export type PassportCallbackReturn =
  | { kind: 'absent' }
  /**
   * A refusal. UNAUTHENTICATED by construction — there is no payload to sign,
   * because nothing was shared. Treat it as "stop waiting", never as a fact.
   */
  | { kind: 'error'; code: string; state: string | null }
  | { kind: 'response'; envelope: PassportCallbackEnvelope }
  | { kind: 'malformed'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHex(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/i.test(value);
}

export function parsePassportCallbackReturn(hash: string): PassportCallbackReturn {
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const error = fragment.get('passportError');
  if (error !== null) {
    return {
      kind: 'error',
      code: error.slice(0, MAX_STRING_LENGTH),
      state: fragment.get('passportState'),
    };
  }
  const raw = fragment.get('passportResponse');
  if (raw === null) return { kind: 'absent' };

  const bytes = fromBase64Url(raw);
  if (!bytes) return { kind: 'malformed', reason: 'the reply is not base64url' };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { kind: 'malformed', reason: 'the reply is not JSON' };
  }
  if (!isRecord(value) || value.protocol !== PASSPORT_CALLBACK_PROTOCOL) {
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
    return { kind: 'malformed', reason: 'the reply names a signature scheme this app cannot check' };
  }
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

function parsePayload(value: unknown): PassportCallbackPayload | null {
  if (!isRecord(value)) return null;
  if (
    value.protocol !== PASSPORT_CALLBACK_PROTOCOL ||
    value.type !== 'passport.callback.profile' ||
    typeof value.audience !== 'string' ||
    typeof value.issuedAt !== 'number' ||
    !Number.isFinite(value.issuedAt) ||
    typeof value.nonce !== 'string' ||
    value.nonce.length === 0 ||
    !Array.isArray(value.fields) ||
    !isRecord(value.profile)
  ) {
    return null;
  }
  if (value.state !== undefined && typeof value.state !== 'string') return null;
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
  if (source.midnightAddresses !== undefined) {
    const addresses = source.midnightAddresses;
    if (
      !isRecord(addresses) ||
      typeof addresses.unshielded !== 'string' ||
      addresses.unshielded.length > MAX_ADDRESS_LENGTH
    ) {
      return null;
    }
    const parsed: NonNullable<PassportCallbackProfile['midnightAddresses']> = {
      unshielded: addresses.unshielded,
    };
    for (const key of ['shielded', 'dust'] as const) {
      const candidate = addresses[key];
      if (candidate === undefined) continue;
      if (typeof candidate !== 'string' || candidate.length > MAX_ADDRESS_LENGTH) return null;
      parsed[key] = candidate;
    }
    profile.midnightAddresses = parsed;
  }
  return {
    protocol: PASSPORT_CALLBACK_PROTOCOL,
    type: 'passport.callback.profile',
    audience: value.audience,
    ...(typeof value.state === 'string' ? { state: value.state } : {}),
    issuedAt: value.issuedAt,
    nonce: value.nonce,
    fields,
    profile,
  };
}

/* ---------------------------------------------------------------------------
 * Crypto
 * ------------------------------------------------------------------------ */

/**
 * BIP-340 Schnorr over secp256k1, applied to `sha256(payload)`.
 *
 * The pre-hash is not decoration. Midnight's `unshieldedKeystore.signData`
 * hashes its input with sha256 before signing, so a verifier that hands the
 * raw payload to BIP-340 fails on every valid signature. Established against
 * `@midnight-ntwrk/ledger-v8` 8.0.3 (2026/08/19): `signData(sk, m)` and
 * `schnorr.verify(sig, sha256(m), xOnlyPublicKey)` agree, and `signData` is
 * rejected by `schnorr.verify(sig, m, …)`.
 */
export function verifyPassportSignature(
  publicKeyHex: string,
  payload: Uint8Array,
  signatureHex: string,
): boolean {
  return schnorr.verify(hexToBytes(signatureHex), sha256(payload), hexToBytes(publicKeyHex));
}

/**
 * Whether `address` is the Midnight unshielded address of `publicKeyHex`.
 *
 * The derivation, established against `@midnight-ntwrk/wallet-sdk-unshielded-wallet`
 * 3.0.0 and `@midnight-ntwrk/ledger-v8` 8.0.3 (2026/08/19), is:
 *
 *     address = bech32m(hrp = 'mn_addr' | 'mn_addr_<network>',
 *                       data = sha256(xOnlyVerifyingKey))
 *
 * The network lives in the human-readable part, so it is checked as a prefix
 * rather than parsed: a receiver that cares which network it is talking to
 * should read the prefix, and one that does not should still not accept an
 * address whose type is not `addr`.
 */
export function verifyPassportKeyBinding(publicKeyHex: string, address: string): boolean {
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32m.decode(address as `${string}1${string}`, BECH32M_LIMIT);
  } catch {
    return false;
  }
  if (decoded.prefix !== 'mn_addr' && !decoded.prefix.startsWith('mn_addr_')) return false;
  let payload: Uint8Array;
  try {
    payload = bech32m.fromWords(decoded.words);
  } catch {
    return false;
  }
  const expected = sha256(hexToBytes(publicKeyHex));
  if (payload.length !== expected.length) return false;
  /* Length-independent comparison is pointless here — both sides are public —
     but a loop is still needed because `Uint8Array` has no equality. */
  let equal = true;
  for (let index = 0; index < expected.length; index += 1) {
    if (payload[index] !== expected[index]) equal = false;
  }
  return equal;
}

/* ---------------------------------------------------------------------------
 * The full check
 * ------------------------------------------------------------------------ */

export interface PassportCallbackCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface PassportCallbackVerifyOptions {
  /** This app's OWN origin. Anything else means the reply is not for it. */
  expectedAudience: string;
  /** The state this app sent. `null` only if it genuinely sent none. */
  expectedState: string | null;
  /** Returns true if this nonce has been accepted before. */
  seenNonce?: (nonce: string) => boolean;
  /** Defaults to true. False accepts `scheme: 'none'` as a stated downgrade. */
  requireSignature?: boolean;
  maxAgeMs?: number;
  now?: number;
}

export type PassportCallbackVerdict =
  | { ok: true; payload: PassportCallbackPayload; signed: boolean; checks: PassportCallbackCheck[] }
  | { ok: false; reason: string; checks: PassportCallbackCheck[] };

const DEFAULT_MAX_AGE_MS = 5 * 60_000;

/**
 * Verifies a reply, in the only order that is safe: bytes, then signature,
 * then meaning. Every step is appended to `checks` whether it passes or fails,
 * so the caller can show its work; the first failure still stops the walk.
 */
export function verifyPassportCallbackReply(
  envelope: PassportCallbackEnvelope,
  options: PassportCallbackVerifyOptions,
): PassportCallbackVerdict {
  const checks: PassportCallbackCheck[] = [];
  const fail = (reason: string): PassportCallbackVerdict => ({ ok: false, reason, checks });
  const record = (label: string, ok: boolean, detail?: string) => {
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
    if (!record('BIP-340 signature over sha256(payload)', valid, PASSPORT_CALLBACK_SIGNATURE_SCHEME)) {
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
  if (!record('Payload is a well-formed profile reply', Boolean(payload))) {
    return fail('the payload is not a well-formed profile reply');
  }

  if (
    !record(
      'Audience is this app',
      payload!.audience === options.expectedAudience,
      payload!.audience,
    )
  ) {
    return fail('the reply was issued for a different origin');
  }

  const returnedState = payload!.state ?? null;
  if (!record('State echoes what was sent', returnedState === options.expectedState)) {
    return fail('the reply does not echo the state that was sent');
  }

  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const ageMs = now - payload!.issuedAt;
  /* Both directions: a reply dated in the future is as wrong as a stale one,
     and one minute of forward tolerance absorbs ordinary clock skew between
     two devices. */
  if (
    !record(
      'Issued recently',
      ageMs <= maxAge && payload!.issuedAt <= now + 60_000,
      `${Math.round(ageMs / 1000)}s old`,
    )
  ) {
    return fail(ageMs > maxAge ? 'the reply is too old' : 'the reply is dated in the future');
  }

  const replayed = options.seenNonce?.(payload!.nonce) ?? false;
  if (!record('Nonce not seen before', !replayed, payload!.nonce)) {
    return fail('this reply has already been used');
  }

  /* LAST, and only now that the payload is trusted: the signing key must be
     the key behind the address the payload claims. Skipped when the reply was
     unsigned (there is no key) or when no unshielded address was shared (there
     is nothing to bind to) — and the page must say so rather than implying a
     check happened. */
  if (signed && payload!.profile.midnightAddresses) {
    const address = payload!.profile.midnightAddresses.unshielded;
    if (
      !record(
        'Signing key matches the shared unshielded address',
        verifyPassportKeyBinding(envelope.publicKey!, address),
        'sha256(verifying key) = bech32m payload',
      )
    ) {
      return fail('the reply was signed by a key that does not own the shared address');
    }
  } else {
    record(
      'Signing key matches the shared unshielded address',
      true,
      signed ? 'no unshielded address was shared, so there is nothing to bind' : 'reply is unsigned',
    );
  }

  return { ok: true, payload: payload!, signed, checks };
}
