/**
 * A REAL reply, captured off the address bar of a real browser returning from
 * production Passport on 2026/09/08.
 *
 * It is here rather than reconstructed because a reconstruction is a statement
 * about what we believe Passport sends, and what cost a day was that our belief
 * and the wire disagreed: this package required bare hex, Passport emits
 * `schnorr:<hex>`, and every reply came back "malformed" before a single
 * cryptographic step ran. A fixture built by this package's own `seal()` helper
 * could never have caught that, because it would have been built to the same
 * belief.
 *
 * Nothing in it is edited. The signature is a real BIP-340 signature over the
 * payload beneath it, so a test that verifies this envelope is verifying
 * production's own key against production's own bytes — and would fail the
 * moment the wire changed again.
 *
 * The Passport that signed it had a passkey and no `.night` name, which is why
 * `profile.displayName` reads `Midnight Passport` and `passportContract` is
 * absent. That is a defect on the sending side, fixed in the app in the same
 * change; it is preserved verbatim here because a fixture that was tidied up is
 * no longer a capture.
 */

/** The envelope, exactly as it arrived, tag included. */
export const PRODUCTION_TAGGED_ENVELOPE = {
  protocol: 'org.midnight.passport.callback/v1',
  type: 'passport.callback.response',
  payload:
    'eyJwcm90b2NvbCI6Im9yZy5taWRuaWdodC5wYXNzcG9ydC5jYWxsYmFjay92MSIsInR5cGUiOiJwYXNzcG9ydC5jYWxsYmFjay5wcm9maWxlIiwiYXVkaWVuY2UiOiJodHRwOi8vMTI3LjAuMC4xOjg3ODgiLCJzdGF0ZSI6IlZmWVZqTldacFVTaWhyaTJWbGswcVEiLCJpc3N1ZWRBdCI6MTc4ODg4NzIwODc4NCwibm9uY2UiOiJZVXFHZFM3MVNkTFpmdXUzMHdiWTVRIiwiZmllbGRzIjpbImRpc3BsYXlOYW1lIiwicGFzc3BvcnRDb250cmFjdCJdLCJwcm9maWxlIjp7ImRpc3BsYXlOYW1lIjoiTWlkbmlnaHQgUGFzc3BvcnQifX0',
  scheme: 'bip340-schnorr-secp256k1-sha256',
  publicKey: 'schnorr:24addff94dbebb51924eb90ada1155fe359cbb7b0a725fc1b3e95c4f7f75e62f',
  signature:
    'schnorr:5c4a887a00f76a8c9bd1a9ee47ebb2f6a4031f6ec46f3aca8c821e2d693ec7ecbc7c514daaaa68dd7c37f70af1f2623662fb392858d64cd34077612b9af93440',
} as const;

/** The bare hex behind each tag — what a receiver must end up holding. */
export const PRODUCTION_PUBLIC_KEY =
  '24addff94dbebb51924eb90ada1155fe359cbb7b0a725fc1b3e95c4f7f75e62f';
export const PRODUCTION_SIGNATURE =
  '5c4a887a00f76a8c9bd1a9ee47ebb2f6a4031f6ec46f3aca8c821e2d693ec7ecbc7c514daaaa68dd7c37f70af1f2623662fb392858d64cd34077612b9af93440';

/** What the app that launched it sent, and what the reply must echo. */
export const PRODUCTION_AUDIENCE = 'http://127.0.0.1:8788';
export const PRODUCTION_STATE = 'VfYVjNWZpUSihri2Vlk0qQ';
/** The moment it was signed. Tests read the clock from here, not from now. */
export const PRODUCTION_ISSUED_AT = 1_788_887_208_784;
