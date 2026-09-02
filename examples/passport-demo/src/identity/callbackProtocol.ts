/* ===========================================================================
 * Midnight Passport — the URL-callback profile contract
 * ===========================================================================
 *
 * WHY THIS EXISTS, and why it is not `profileConsent.tsx`.
 *
 * The popup profile flow (`../profileConsent.tsx`) is a conversation between
 * two live windows. The app keeps a `Window` reference, Passport posts back
 * through it, and the whole exchange is bound to a `requestId`/`nonce` pair
 * that never leaves memory. That is the right design on a desktop, and it is
 * unusable on a phone: the originating tab is suspended or discarded the
 * moment the Passport PWA takes the foreground, and a discarded tab has no
 * window reference to answer through. The exchange has to survive NAVIGATION,
 * not merely survive a message.
 *
 * So this contract is a full-page redirect in both directions. The app sends
 * the user to Passport with a URL; Passport sends the user back to the app
 * with a URL. Nothing is held in memory across the boundary on either side,
 * which is exactly why it works when the phone throws the app's tab away.
 *
 * ---------------------------------------------------------------------------
 * THE LAUNCH (app → Passport)
 * ---------------------------------------------------------------------------
 *
 *   https://midnightpassport.com/?passportCallback=<absolute URL>
 *                                &passportFields=<comma-separated list>
 *                                &passportState=<opaque, ≤256 chars>
 *
 *   passportCallback  REQUIRED. Where the user is sent back to. Absolute, and
 *                     parsed with `new URL` — never string-concatenated, never
 *                     pattern-matched. It must be `https:`, with ONE dev
 *                     exception: `http:` on `localhost`, `127.0.0.1`, or
 *                     `[::1]`, because an example app on a dev server has no
 *                     certificate and refusing it would make the flow
 *                     untestable. It may carry its own query string (preserved
 *                     verbatim) but must NOT carry a fragment: the reply IS
 *                     the fragment, and honouring both would mean silently
 *                     destroying part of the app's own URL.
 *                     Credentials in the URL (`https://user:pw@host/`) are
 *                     refused — a callback is a place, not a login.
 *                     The parsed origin is what the user is shown, and it is
 *                     PINNED at consent time: the redirect target is the
 *                     object that was parsed when the sheet was rendered, so
 *                     what the user approved is where the reply goes.
 *
 *   passportFields    REQUIRED, and a subset of the profile vocabulary shared
 *                     with the popup flow — `displayName`,
 *                     `passportContract` (see
 *                     `@midnight-passport/connect`). Deliberately not
 *                     optional and with no default: a launch that does not say
 *                     what it wants is a bug in the app, and inventing a
 *                     default would silently share more than it asked for. An
 *                     unknown name rejects the WHOLE launch rather than being
 *                     quietly dropped, matching
 *                     `parsePassportProfileRequest`, which refuses a request
 *                     whose field list did not survive filtering intact.
 *
 *   passportState     OPTIONAL, ≤256 characters, the same cap the profile
 *                     protocol puts on every short string. Echoed back
 *                     VERBATIM and never interpreted: it is the app's own
 *                     CSRF/continuation token and Passport has no business
 *                     reading it. It is echoed inside the SIGNED payload on
 *                     success, so it cannot be swapped in flight.
 *
 * A malformed launch never produces a broken screen and never produces a
 * redirect. Passport renders its normal self and shows a dismissible notice;
 * see `../screens/callbackConsent.tsx`. There is deliberately no error
 * redirect for this case: a launch we could not parse is a launch whose
 * callback URL we may not be able to trust.
 *
 * ---------------------------------------------------------------------------
 * THE RETURN (Passport → app)
 * ---------------------------------------------------------------------------
 *
 * Passport navigates to the pinned callback URL with the reply in the URL
 * FRAGMENT, never the query. A fragment is not sent to the receiving server,
 * so the shared profile does not land in the app's access logs, its reverse
 * proxy's logs, or its analytics — it is only ever read by the page's own
 * JavaScript. The query string would put it in all three.
 *
 *   approved  #passportResponse=<base64url of the envelope JSON>
 *   declined  #passportError=denied&passportState=<echo>
 *   no data   #passportError=profile_unavailable&passportState=<echo>
 *
 * The envelope is:
 *
 *   {
 *     protocol:  'org.midnight.passport.callback/v1',
 *     type:      'passport.callback.response',
 *     payload:   '<base64url of the EXACT signed bytes>',
 *     scheme:    'bip340-schnorr-secp256k1-sha256' | 'none',
 *     publicKey: '<64 hex chars>',   // absent when scheme is 'none'
 *     signature: '<128 hex chars>'   // absent when scheme is 'none'
 *   }
 *
 * and the payload those bytes decode to is:
 *
 *   {
 *     protocol: 'org.midnight.passport.callback/v1',
 *     type:     'passport.callback.profile',
 *     audience: 'https://clubcoin.example',  // the callback URL's origin
 *     state:    '<echo>',                    // omitted when none was sent
 *     issuedAt: 1755561234567,               // ms since the epoch
 *     nonce:    '<22 base64url chars>',      // 16 random bytes
 *     fields:   ['displayName', 'passportContract'],
 *     profile:  { ... }                      // the profile vocabulary
 *   }
 *
 * WHY THE PAYLOAD IS DOUBLE-ENCODED. The signature covers bytes, so the
 * receiver must be able to reproduce the signed bytes EXACTLY. Re-serialising
 * a parsed object cannot do that without a canonical JSON form, and canonical
 * JSON is a well-known source of quiet verification failures (key order,
 * number formatting, escaping). Transmitting the payload as its own base64url
 * string inside the envelope removes the problem entirely: the bytes that were
 * signed are the bytes that arrive, and the receiver verifies before it parses
 * anything.
 *
 * ---------------------------------------------------------------------------
 * INTEGRITY
 * ---------------------------------------------------------------------------
 *
 * The fragment crosses an untrusted channel — the user's own address bar —
 * so the reply is signed with the wallet's unshielded key, the key whose
 * PUBLIC half the receiver already has as part of the shared profile.
 *
 * Established against the SDK in this repository (2026/08/19, evidence in the
 * report accompanying this change):
 *
 *   - `unshieldedKeystore.signData(bytes)` is BIP-340 Schnorr over secp256k1
 *     applied to `sha256(bytes)`, returning 64 bytes as 128 hex characters.
 *   - `unshieldedKeystore.getPublicKey()` is the 32-byte x-only BIP-340
 *     verifying key as 64 hex characters.
 *   - The unshielded ADDRESS is `sha256(verifyingKey)`, bech32m-encoded with
 *     the HRP `mn_addr[_<network>]`.
 *
 * All three are verifiable in a plain web page with no Midnight dependency and
 * no WebAssembly: `@noble/curves` BIP-340, `@noble/hashes` sha256, and any
 * bech32m decoder. So the receiver can check BOTH that the payload was signed
 * by a key AND that the key is the one behind the `midnightAddresses.unshielded`
 * value in the payload it just received. The signature is therefore bound to
 * the identity being shared, not merely to some key.
 *
 * This module holds NO crypto itself. Signing arrives as a
 * {@link PassportCallbackSigner} seam, and verification as an injected
 * `verify` function, so the contract can be unit-drilled and copied into a
 * receiver without dragging a curve implementation along.
 *
 * The honest fallback: when no unshielded keystore is available in the tab, or
 * the signer throws, nothing can sign. That case emits `scheme: 'none'` and
 * omits the key and signature. It is NOT dressed up as signed. Integrity then rests on TLS to the callback origin plus the audience
 * and state bindings inside the payload, and the receiver decides whether that
 * is enough — {@link verifyPassportCallbackResponse} refuses an unsigned reply
 * unless the caller passes `requireSignature: false`.
 *
 * WHAT NONE OF THIS PREVENTS, stated plainly so nobody over-reads it: a
 * signature proves the payload was issued by this Passport for that audience
 * at that time. It does not stop the USER from replaying their own valid reply
 * to the same app twice — that is what `nonce` and `issuedAt` are for, and the
 * receiver has to actually check them (see {@link verifyPassportCallbackResponse}).
 * ========================================================================= */

/* Type-only, so this module has no runtime dependency on the backend package
   and can be bundled on its own for a unit drill. The `satisfies` below is
   what makes the borrowed vocabulary a compile-time fact rather than a
   comment: if the profile protocol grows or renames a field, this file stops
   compiling. */
import type { PassportProfileField } from '../backend.js';

export const PASSPORT_CALLBACK_PROTOCOL = 'org.midnight.passport.callback/v1' as const;

/**
 * The signature scheme name that travels on the wire. It names the curve, the
 * signature construction, and the pre-hash, because "signed with the Midnight
 * key" is not something a receiver can implement.
 */
export const PASSPORT_CALLBACK_SIGNATURE_SCHEME = 'bip340-schnorr-secp256k1-sha256' as const;

/** The launch query parameters. */
export const PASSPORT_CALLBACK_PARAM = 'passportCallback' as const;
export const PASSPORT_CALLBACK_FIELDS_PARAM = 'passportFields' as const;
export const PASSPORT_CALLBACK_STATE_PARAM = 'passportState' as const;

/** The return fragment parameters. */
export const PASSPORT_CALLBACK_RESPONSE_PARAM = 'passportResponse' as const;
export const PASSPORT_CALLBACK_ERROR_PARAM = 'passportError' as const;

/**
 * The requestable vocabulary, borrowed wholesale from the popup flow. One
 * vocabulary across both channels: an app must not be able to reach data
 * through a redirect that a popup would not have shared.
 */
export const PASSPORT_CALLBACK_FIELDS = [
  'displayName',
  'passportContract',
] as const satisfies readonly PassportProfileField[];

/* The other direction of the same check. `satisfies` above proves every name
   here is a real profile field; this proves every real profile field is named
   here, so a field added to the profile protocol cannot be silently
   unreachable over the callback channel. */
type CallbackField = (typeof PASSPORT_CALLBACK_FIELDS)[number];
const VOCABULARY_IS_COMPLETE: PassportProfileField extends CallbackField ? true : never = true;
void VOCABULARY_IS_COMPLETE;

/** Same caps as the profile protocol: short strings 256, addresses 512. */
const MAX_STRING_LENGTH = 256;
const MAX_ADDRESS_LENGTH = 512;
/** Browsers stop being reliable well before this; it is a sanity bound. */
const MAX_CALLBACK_URL_LENGTH = 2_048;
/** Default freshness window a receiver applies to `issuedAt`. */
export const PASSPORT_CALLBACK_DEFAULT_MAX_AGE_MS = 5 * 60_000;

export type PassportCallbackProfile = Partial<{
  displayName: string;
  passportContract: { address: string; network: string };
}>;

export interface PassportCallbackLaunch {
  /** The callback URL exactly as parsed — query preserved, no fragment. */
  readonly callbackUrl: string;
  /** Its origin. This is the string the user is shown and the reply is bound to. */
  readonly callbackOrigin: string;
  readonly fields: readonly CallbackField[];
  /** `null` when the app sent none. Never interpreted, only echoed. */
  readonly state: string | null;
}

export type PassportCallbackLaunchProblem =
  | 'callback-unparsable'
  | 'callback-too-long'
  | 'callback-insecure'
  | 'callback-has-fragment'
  | 'callback-has-credentials'
  | 'fields-missing'
  | 'fields-unknown'
  | 'state-too-long';

export type PassportCallbackLaunchParse =
  /** No `passportCallback` at all: an ordinary Passport launch, not our business. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly launch: PassportCallbackLaunch }
  | {
      readonly kind: 'malformed';
      readonly problem: PassportCallbackLaunchProblem;
      /** One sentence, safe to show a user, naming what the app got wrong. */
      readonly message: string;
    };

export interface PassportCallbackPayload {
  readonly protocol: typeof PASSPORT_CALLBACK_PROTOCOL;
  readonly type: 'passport.callback.profile';
  /** The origin this reply was issued FOR. A receiver must check it is itself. */
  readonly audience: string;
  readonly state?: string;
  readonly issuedAt: number;
  readonly nonce: string;
  readonly fields: readonly CallbackField[];
  readonly profile: PassportCallbackProfile;
}

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

/**
 * The signing seam. Deliberately structural rather than typed against
 * `LocalMidnightWallet`: this module must stay portable, and the host is the
 * one that knows where the keystore lives.
 *
 * `publicKey` is the x-only BIP-340 verifying key as hex, and `sign` returns
 * the 64-byte signature as hex. Both come straight off
 * `wallet.keys.unshieldedKeystore` — see `../lib/localWallet.ts`, and
 * `identity/midnames.ts` for the same keystore signing real transactions.
 */
export interface PassportCallbackSigner {
  readonly publicKey: string;
  sign(payload: Uint8Array): string;
}

/* ---------------------------------------------------------------------------
 * base64url
 *
 * Hand-rolled rather than borrowed so the module runs unchanged in a browser,
 * in a receiver's page, and in a bare Node drill. `btoa`/`atob` are the one
 * base64 primitive all three share.
 * ------------------------------------------------------------------------ */

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (text.length === 0 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const standard = text.replace(/-/g, '+').replace(/_/g, '/');
  /* Re-padded explicitly: `atob` is forgiving about padding in the browsers
     that matter, but "the browsers that matter" is not a contract. */
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/* ---------------------------------------------------------------------------
 * The launch
 * ------------------------------------------------------------------------ */

function isLoopbackHost(hostname: string): boolean {
  /* `new URL` keeps IPv6 hosts in brackets, so `[::1]` is the literal form. */
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function isCallbackField(value: string): value is CallbackField {
  return (PASSPORT_CALLBACK_FIELDS as readonly string[]).includes(value);
}

/**
 * Parses a launch query string. Total: every rejection is named, so the notice
 * a user sees can say what the app did wrong instead of "something failed".
 *
 * Never throws, and never returns a half-valid launch — a launch this returns
 * `ok` for is one every downstream step may trust without re-checking.
 */
export function parsePassportCallbackLaunch(search: string): PassportCallbackLaunchParse {
  const parameters = new URLSearchParams(search);
  const rawCallback = parameters.get(PASSPORT_CALLBACK_PARAM);
  if (rawCallback === null || rawCallback.length === 0) return { kind: 'absent' };

  if (rawCallback.length > MAX_CALLBACK_URL_LENGTH) {
    return {
      kind: 'malformed',
      problem: 'callback-too-long',
      message: `The return address is longer than ${MAX_CALLBACK_URL_LENGTH} characters.`,
    };
  }

  let callback: URL;
  try {
    /* No base argument on purpose: a relative callback would resolve against
       Passport's own origin and send the reply to Passport. */
    callback = new URL(rawCallback);
  } catch {
    return {
      kind: 'malformed',
      problem: 'callback-unparsable',
      message: 'The return address is not an absolute URL.',
    };
  }

  const secure =
    callback.protocol === 'https:' ||
    (callback.protocol === 'http:' && isLoopbackHost(callback.hostname));
  if (!secure) {
    return {
      kind: 'malformed',
      problem: 'callback-insecure',
      message: 'The return address must use https (or http on localhost during development).',
    };
  }
  if (callback.username.length > 0 || callback.password.length > 0) {
    return {
      kind: 'malformed',
      problem: 'callback-has-credentials',
      message: 'The return address must not carry credentials.',
    };
  }
  if (callback.hash.length > 0) {
    return {
      kind: 'malformed',
      problem: 'callback-has-fragment',
      message: 'The return address must not already carry a fragment — the reply is the fragment.',
    };
  }

  const rawFields = parameters.get(PASSPORT_CALLBACK_FIELDS_PARAM);
  if (rawFields === null || rawFields.trim().length === 0) {
    return {
      kind: 'malformed',
      problem: 'fields-missing',
      message: 'The request did not say which profile fields it wants.',
    };
  }
  const requested = rawFields
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  /* `,` and ` , ` survive the emptiness check above and then vanish in the
     filter. A launch whose field list is empty AFTER trimming is the same bug
     as a launch that named no fields at all, so it gets the same rejection:
     letting it through produced a consent sheet offering nothing and a SIGNED
     reply with an empty `fields` array, which every receiver refuses
     (`parsePayload` requires a non-empty list). */
  if (requested.length === 0) {
    return {
      kind: 'malformed',
      problem: 'fields-missing',
      message: 'The request did not say which profile fields it wants.',
    };
  }
  const unknown = requested.filter((field) => !isCallbackField(field));
  if (unknown.length > 0) {
    return {
      kind: 'malformed',
      problem: 'fields-unknown',
      /* The names are the app's own input, echoed inside a bounded sentence,
         and rendered as text by React. Naming them is what makes the notice
         useful to the developer who mistyped one. */
      message: `The request asked for profile fields Passport does not share: ${unknown
        .slice(0, PASSPORT_CALLBACK_FIELDS.length + 1)
        .join(', ')
        .slice(0, MAX_STRING_LENGTH)}.`,
    };
  }
  /* Order follows the vocabulary, not the app's list, so the consent sheet
     always reads the same way and duplicates collapse. */
  const fields = PASSPORT_CALLBACK_FIELDS.filter((field) => requested.includes(field));

  const rawState = parameters.get(PASSPORT_CALLBACK_STATE_PARAM);
  if (rawState !== null && rawState.length > MAX_STRING_LENGTH) {
    return {
      kind: 'malformed',
      problem: 'state-too-long',
      message: `The state token is longer than ${MAX_STRING_LENGTH} characters.`,
    };
  }

  return {
    kind: 'ok',
    launch: {
      /* `callback.href` and not `rawCallback`: the reply is built from the URL
         that was actually PARSED and checked, so no unnormalised original can
         sneak past the checks above on its way to `location.assign`. */
      callbackUrl: callback.href,
      callbackOrigin: callback.origin,
      fields,
      state: rawState,
    },
  };
}

/* ---------------------------------------------------------------------------
 * The reply — Passport side
 * ------------------------------------------------------------------------ */

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * Narrows a live profile to exactly the requested fields, dropping anything
 * absent. A field the user approved but Passport does not hold is simply not
 * in the payload — the `fields` list says what was ASKED, the `profile` keys
 * say what was ANSWERED, and the difference is information the receiver is
 * entitled to.
 *
 * Every string is capped here as well as in the profile protocol. This is the
 * last point before bytes are signed, and a signature over an unbounded string
 * is a signature over whatever the address bar will carry.
 */
export function selectPassportCallbackProfile(
  fields: readonly CallbackField[],
  source: {
    displayName: string | null;
    passportContract: { address: string; network: string } | null;
  },
): PassportCallbackProfile {
  const cap = (value: string, max: number) => value.slice(0, max);
  const profile: PassportCallbackProfile = {};
  for (const field of fields) {
    if (field === 'displayName' && source.displayName) {
      profile.displayName = cap(source.displayName, MAX_STRING_LENGTH);
    }
    if (field === 'passportContract' && source.passportContract) {
      profile.passportContract = {
        address: cap(source.passportContract.address, MAX_ADDRESS_LENGTH),
        network: cap(source.passportContract.network, MAX_STRING_LENGTH),
      };
    }
  }
  return profile;
}

/**
 * Builds the payload and the exact bytes to be signed. `bytes` and `encoded`
 * are two views of one thing — sign the former, transmit the latter — and
 * nothing downstream may re-serialise `payload` to get them back.
 *
 * `now` and `nonce` are injectable so a test can pin them. Production callers
 * pass neither.
 */
export function buildPassportCallbackPayload(input: {
  launch: PassportCallbackLaunch;
  profile: PassportCallbackProfile;
  now?: number;
  nonce?: string;
}): { payload: PassportCallbackPayload; bytes: Uint8Array; encoded: string } {
  const payload: PassportCallbackPayload = {
    protocol: PASSPORT_CALLBACK_PROTOCOL,
    type: 'passport.callback.profile',
    audience: input.launch.callbackOrigin,
    ...(input.launch.state === null ? {} : { state: input.launch.state }),
    issuedAt: input.now ?? Date.now(),
    nonce: input.nonce ?? randomNonce(),
    fields: input.launch.fields,
    profile: input.profile,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return { payload, bytes, encoded: toBase64Url(bytes) };
}

/**
 * Wraps signed (or honestly unsigned) payload bytes in the wire envelope.
 *
 * A signer that throws produces an UNSIGNED envelope rather than an aborted
 * flow: the user has already consented, and the truthful outcome is "here is
 * your profile, unsigned" — which a receiver can refuse — not a dead end on a
 * phone the user cannot debug. The throw is logged for whoever is watching.
 */
export function sealPassportCallbackResponse(
  encodedPayload: string,
  bytes: Uint8Array,
  signer: PassportCallbackSigner | null,
): PassportCallbackEnvelope {
  if (!signer) {
    return {
      protocol: PASSPORT_CALLBACK_PROTOCOL,
      type: 'passport.callback.response',
      payload: encodedPayload,
      scheme: 'none',
    };
  }
  let signature: string;
  try {
    signature = signer.sign(bytes);
  } catch (cause) {
    console.warn('[passport-callback] signing failed; returning an unsigned reply', cause);
    return {
      protocol: PASSPORT_CALLBACK_PROTOCOL,
      type: 'passport.callback.response',
      payload: encodedPayload,
      scheme: 'none',
    };
  }
  return {
    protocol: PASSPORT_CALLBACK_PROTOCOL,
    type: 'passport.callback.response',
    payload: encodedPayload,
    scheme: PASSPORT_CALLBACK_SIGNATURE_SCHEME,
    publicKey: signer.publicKey,
    signature,
  };
}

function withFragment(callbackUrl: string, fragment: URLSearchParams): string {
  const target = new URL(callbackUrl);
  /* Assigning `hash` rather than concatenating: the parse step guaranteed
     there was no fragment to begin with, and this keeps the query intact. */
  target.hash = fragment.toString();
  return target.href;
}

/** The approved return URL. Fragment, never query — see the header. */
export function passportCallbackSuccessUrl(
  launch: PassportCallbackLaunch,
  envelope: PassportCallbackEnvelope,
): string {
  const fragment = new URLSearchParams();
  fragment.set(PASSPORT_CALLBACK_RESPONSE_PARAM, toBase64Url(
    new TextEncoder().encode(JSON.stringify(envelope)),
  ));
  return withFragment(launch.callbackUrl, fragment);
}

/**
 * The refusal return URL. The state is echoed in the clear here because there
 * is no signed payload to carry it — nothing was shared, so there is nothing
 * to bind it to. A receiver must therefore treat a `passportError` fragment as
 * unauthenticated: it is a hint to stop waiting, not a fact about the user.
 */
export function passportCallbackErrorUrl(
  launch: PassportCallbackLaunch,
  code: PassportCallbackErrorCode,
): string {
  const fragment = new URLSearchParams();
  fragment.set(PASSPORT_CALLBACK_ERROR_PARAM, code);
  if (launch.state !== null) fragment.set(PASSPORT_CALLBACK_STATE_PARAM, launch.state);
  return withFragment(launch.callbackUrl, fragment);
}

/* ---------------------------------------------------------------------------
 * The reply — receiver side
 *
 * Kept here, alongside the writer, so the two halves cannot drift. A real
 * third-party app copies this section (as `examples/clubcoin-mock` does) the
 * way the app template copies `bridge/profileProtocol.ts`.
 * ------------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHex(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/i.test(value);
}

/** What a receiver finds in its own fragment on return. */
export type PassportCallbackReturn =
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly code: string; readonly state: string | null }
  | { readonly kind: 'response'; readonly envelope: PassportCallbackEnvelope }
  | { readonly kind: 'malformed'; readonly reason: string };

export function parsePassportCallbackReturn(hash: string): PassportCallbackReturn {
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const error = fragment.get(PASSPORT_CALLBACK_ERROR_PARAM);
  if (error !== null) {
    return {
      kind: 'error',
      code: error.slice(0, MAX_STRING_LENGTH),
      state: fragment.get(PASSPORT_CALLBACK_STATE_PARAM),
    };
  }
  const raw = fragment.get(PASSPORT_CALLBACK_RESPONSE_PARAM);
  if (raw === null) return { kind: 'absent' };

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
    return { kind: 'malformed', reason: 'the reply names a signature scheme this app cannot check' };
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

function parseCallbackPayload(value: unknown): PassportCallbackPayload | null {
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
    (field): field is CallbackField => typeof field === 'string' && isCallbackField(field),
  );
  if (fields.length !== value.fields.length || fields.length === 0) return null;

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
    audience: value.audience,
    ...(typeof value.state === 'string' ? { state: value.state } : {}),
    issuedAt: value.issuedAt,
    nonce: value.nonce,
    fields,
    profile,
  };
}

export interface PassportCallbackVerification {
  /** The receiver's OWN origin. A reply issued for anyone else is not its reply. */
  expectedAudience: string;
  /** The state the receiver sent. `null` only if it genuinely sent none. */
  expectedState: string | null;
  /**
   * BIP-340 Schnorr verification over `sha256(payloadBytes)`. Injected so this
   * module carries no curve. Omit it only together with
   * `requireSignature: false`.
   */
  verify?: (publicKey: string, payloadBytes: Uint8Array, signature: string) => boolean;
  /**
   * Defaults to `true`. Setting it false accepts `scheme: 'none'` — a
   * deliberate, documented downgrade to "integrity by TLS, audience, and
   * state echo", not an accident.
   */
  requireSignature?: boolean;
  /** Defaults to {@link PASSPORT_CALLBACK_DEFAULT_MAX_AGE_MS}. */
  maxAgeMs?: number;
  now?: number;
}

export type PassportCallbackVerdict =
  | {
      readonly ok: true;
      readonly payload: PassportCallbackPayload;
      /** False when the reply was accepted unsigned. Surface this to the user. */
      readonly signed: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * The whole receiver-side check, in the order that matters: bytes before
 * meaning, signature before content, then audience, state, and freshness.
 *
 * Verifying BEFORE parsing is the point. A receiver that parses first has
 * already let unauthenticated data into its own data structures, and every
 * later check is then a check on attacker-chosen values.
 *
 * NOT checked here, because this module cannot: that `nonce` has not been seen
 * before (the receiver needs storage for that), and that the verifying key
 * hashes to the `midnightAddresses.unshielded` in the payload (that needs
 * sha256 and a bech32m decoder). Both are done in
 * `examples/clubcoin-mock/src/passportCallback.ts`, and both are REQUIRED of a
 * real receiver — a signature by an unrelated key over a payload naming
 * someone else's address would otherwise pass.
 */
export function verifyPassportCallbackResponse(
  envelope: PassportCallbackEnvelope,
  options: PassportCallbackVerification,
): PassportCallbackVerdict {
  const bytes = fromBase64Url(envelope.payload);
  if (!bytes) return { ok: false, reason: 'the payload is not base64url' };

  const requireSignature = options.requireSignature !== false;
  let signed = false;
  if (envelope.scheme === PASSPORT_CALLBACK_SIGNATURE_SCHEME) {
    if (!envelope.publicKey || !envelope.signature) {
      return { ok: false, reason: 'the reply claims a signature it does not carry' };
    }
    if (!options.verify) {
      return { ok: false, reason: 'no verifier was supplied for a signed reply' };
    }
    let valid: boolean;
    try {
      valid = options.verify(envelope.publicKey, bytes, envelope.signature);
    } catch {
      return { ok: false, reason: 'the signature could not be checked' };
    }
    if (!valid) return { ok: false, reason: 'the signature does not match the payload' };
    signed = true;
  } else if (requireSignature) {
    return { ok: false, reason: 'the reply is unsigned and this app requires a signature' };
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, reason: 'the payload is not JSON' };
  }
  const payload = parseCallbackPayload(value);
  if (!payload) return { ok: false, reason: 'the payload is not a well-formed profile reply' };

  if (payload.audience !== options.expectedAudience) {
    return { ok: false, reason: 'the reply was issued for a different origin' };
  }
  const returnedState = payload.state ?? null;
  if (returnedState !== options.expectedState) {
    return { ok: false, reason: 'the reply does not echo the state that was sent' };
  }
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? PASSPORT_CALLBACK_DEFAULT_MAX_AGE_MS;
  /* Both directions. A future `issuedAt` is as wrong as a stale one, and a
     one-sided check is trivially defeated by a clock claim. One minute of
     forward tolerance absorbs ordinary clock skew between two devices. */
  if (payload.issuedAt > now + 60_000) {
    return { ok: false, reason: 'the reply is dated in the future' };
  }
  if (now - payload.issuedAt > maxAge) {
    return { ok: false, reason: 'the reply is too old' };
  }
  return { ok: true, payload, signed };
}
