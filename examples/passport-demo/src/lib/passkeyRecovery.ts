/**
 * What a failed passkey sign-in must OFFER, rather than merely explain.
 *
 * THE DEAD END THIS EXISTS TO CLOSE. A browser that still holds Passport
 * records whose credential the platform keystore can no longer produce — the
 * passkey deleted, a different OS profile, a keychain that never synced — took
 * the one-button route into sign-in, raised the platform's "use a saved
 * passkey" sheet with nothing in it, and came back with `NotAllowedError`. The
 * screen then said what had gone wrong and stopped. There was no control on it
 * that could get that user a working Passport, and the question they asked was
 * the obvious one: if there is no key, why can it only ever LOAD one?
 *
 * So the rule below decides, from the failure alone, which way out the screen
 * must put in front of them. It is a rule and not a message because the same
 * three states are reached from two different journeys — the targeted unlock
 * behind "Continue with Passport", and the discoverable assertion behind "Use
 * a different passkey" — and both must land on the same offer for the same
 * reason. Written as a function of the failure so it can be drilled directly,
 * rather than as four scattered `if`s inside two `catch` blocks.
 *
 * WHAT IT DELIBERATELY DOES NOT DECIDE: whether creating is SAFE. That is
 * settled elsewhere and does not depend on this — every enrolment Passport
 * makes carries `excludeCredentials` built from the profiles this browser
 * holds, so the authenticator itself refuses to replace a credential a real
 * Passport depends on, and that refusal arrives as
 * `PassportEnrolmentConflictError` and routes back into sign-in. This module
 * only decides what the user is TOLD they may do.
 */

/**
 * Why a ceremony produced no usable credential, in the authenticator's own
 * terms. Mirrors the backend's `PassportPasskeyDiscoveryFailure`, restated
 * here so this module imports nothing: pulling the backend seam in would drag
 * the private-state store and the ledger behind it into a decision that is
 * four comparisons.
 */
export type PasskeyCeremonyReason = 'cancelled' | 'prf-missing' | 'failed';

/** Which half of a sign-in failed. */
export type PasskeySignInStage =
  /** The WebAuthn ceremony that was supposed to hand back a credential. */
  | 'credential'
  /** Anything after it: decrypting the record, deriving the seed, opening the wallet. */
  | 'open';

/** The way out the onboarding screen must offer after a failed sign-in. */
export type PasskeySignInRecovery =
  /** No credential could be produced at all. Offer to enrol a new one. */
  | 'keyless'
  /** A credential answered and cannot open a Passport. Offer to enrol a new one. */
  | 'unusable-credential'
  /** Nothing a new passkey would fix. The retry already on the screen is the offer. */
  | 'none';

export interface PasskeySignInFailure {
  stage: PasskeySignInStage;
  /** The authenticator's own reason, where the ceremony reported one. */
  reason?: PasskeyCeremonyReason | null;
  /**
   * True when Passport's own watchdog gave up rather than the platform
   * answering — a wallet extension holding the passkey dialog, typically.
   */
  timedOut?: boolean;
}

/**
 * The rule, and the reason behind each of its four answers.
 *
 * `open` → `none`. A credential was produced and it worked; what failed after
 * it was a decryption, a derivation, or a chain read. Enrolling a second
 * passkey there would leave the first one's Passport exactly as unreadable as
 * it already was, and cost the user a credential they did not need.
 *
 * `timedOut` → `none`. Passport stopped waiting; the platform never answered.
 * Nothing has been learnt about whether a credential exists, so "it may be
 * gone — create a new one" would be a guess. The timeout carries its own
 * advice (disable the extension, or use a private window) and the retry is
 * already on the screen.
 *
 * `prf-missing` → `unusable-credential`. A credential ANSWERED and returned no
 * PRF output, so it can open no Passport. That state already has its own panel
 * and its own explanation; this only routes to it, so the discoverable journey
 * and the create journey reach the same place from the same fact.
 *
 * Anything else at the `credential` stage → `keyless`. A dismissed sheet, an
 * empty picker, and a targeted assertion for a credential the keystore no
 * longer holds are all reported by WebAuthn as one indistinguishable
 * `NotAllowedError`, and the platform will not say which. Passport therefore
 * does not claim to know either: it says the passkey could not be loaded, and
 * offers to make one — which is the honest response to all three.
 */
export function passkeySignInRecovery(failure: PasskeySignInFailure): PasskeySignInRecovery {
  if (failure.stage !== 'credential') return 'none';
  if (failure.timedOut === true) return 'none';
  if (failure.reason === 'prf-missing') return 'unusable-credential';
  return 'keyless';
}

/**
 * What the keyless panel says, in one place because two callers must agree on
 * it: the screen that renders it, and the error the sign-in throws so the
 * activity trail records the same account of events the user read.
 *
 * It promises exactly what the code does and no more. It does not assert the
 * passkey is gone — WebAuthn never says so — it says it could not be loaded,
 * and makes the consequence of creating explicit, because a user who reads
 * "create a new passkey" while holding a working Passport in the same browser
 * has every right to fear they are about to lose it. They are not: the
 * enrolment excludes every credential this browser has a Passport record for.
 */
export const KEYLESS_PASSKEY_MESSAGE =
  'Could not load your passkey. If it is gone from this device, create a new one — any Passport a passkey here still holds stays untouched.';
