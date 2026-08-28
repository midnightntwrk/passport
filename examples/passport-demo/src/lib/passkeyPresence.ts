/**
 * The WebAuthn approval ceremony for transactions from a passkey session.
 *
 * Once a local wallet session is open its seed lives in memory, so a bare tap
 * could sign and submit. This module puts the platform's own user-verification
 * sheet — Touch ID, fingerprint, device PIN — between the tap and the
 * submission. It is presence and verification ONLY: no PRF evaluation, no seed
 * derivation, and no change to the enrol or sign-in ceremonies in
 * `demo-backend/src/passkey.ts`. The assertion targets the credential enrolled
 * at sign-in — never a discoverable one — and its result is discarded; the
 * only outcome is "the user verified" or a typed refusal.
 */

export type PasskeyPresenceFailureCode = 'approval-cancelled' | 'presence-unavailable';

/**
 * How the ceremony refused. `approval-cancelled` is the user (or the platform
 * on their behalf) declining the verification sheet; `presence-unavailable` is
 * a session whose credential cannot be asserted at all — a missing or
 * undecodable credential id, or an environment with no WebAuthn. Both fail
 * closed: a caller that cannot complete the ceremony must not submit.
 */
export class PasskeyPresenceError extends Error {
  readonly code: PasskeyPresenceFailureCode;

  constructor(code: PasskeyPresenceFailureCode, message: string) {
    super(message);
    this.name = 'PasskeyPresenceError';
    this.code = code;
  }
}

/** The stored reference to the credential the session signed in with. */
export interface PasskeyPresenceReference {
  /** Base64 of the enrolled credential's rawId — the encoding enrolment stores. */
  credentialId: string;
  /** Relying-party id recorded at enrolment; the current hostname otherwise. */
  rpId?: string;
}

const CANCELLED_MESSAGE = 'Approval cancelled — nothing was signed or sent.';
const UNAVAILABLE_MESSAGE =
  'Passport could not use the passkey this session signed in with, so nothing was signed or sent. Sign in again, then retry.';

/**
 * Standard-alphabet base64 → bytes, matching the backend's `toBase64`. A
 * credential id that does not decode cannot be asserted, so the refusal is the
 * fail-closed `presence-unavailable` rather than a decoding exception.
 */
function credentialIdBytes(credentialId: string): ArrayBuffer {
  try {
    const binary = atob(credentialId);
    if (binary.length === 0) throw new Error('empty credential id');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  } catch {
    throw new PasskeyPresenceError('presence-unavailable', UNAVAILABLE_MESSAGE);
  }
}

/**
 * Runs ONE user-verified assertion against the enrolled credential and
 * resolves on success. The challenge is fresh random bytes — the assertion is
 * never sent anywhere, so nothing verifies it server-side; the security
 * property is that the platform will not answer without verifying the user.
 *
 * `reason` documents the transaction being approved at the call site; the
 * platform sheet shows its own fixed copy and cannot display it.
 */
export async function confirmPresence(
  reference: PasskeyPresenceReference,
  reason?: string,
): Promise<void> {
  void reason;
  if (!globalThis.navigator?.credentials) {
    throw new PasskeyPresenceError('presence-unavailable', UNAVAILABLE_MESSAGE);
  }
  const id = credentialIdBytes(reference.credentialId);
  const challenge = new Uint8Array(32);
  globalThis.crypto.getRandomValues(challenge);
  let assertion: Credential | null;
  try {
    assertion = await globalThis.navigator.credentials.get({
      publicKey: {
        challenge: challenge.buffer,
        allowCredentials: [{ type: 'public-key', id }],
        userVerification: 'required',
        ...(reference.rpId ? { rpId: reference.rpId } : {}),
      },
    });
  } catch (cause) {
    // NotAllowedError is every user-side refusal WebAuthn reports — cancel,
    // timeout, or focus loss. Anything else means the ceremony could not run.
    const declined =
      cause instanceof DOMException &&
      (cause.name === 'NotAllowedError' || cause.name === 'AbortError');
    throw declined
      ? new PasskeyPresenceError('approval-cancelled', CANCELLED_MESSAGE)
      : new PasskeyPresenceError('presence-unavailable', UNAVAILABLE_MESSAGE);
  }
  if (!assertion) {
    throw new PasskeyPresenceError('approval-cancelled', CANCELLED_MESSAGE);
  }
}
