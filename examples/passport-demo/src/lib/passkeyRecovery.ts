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

/**
 * WHERE the ceremony was raised, because the same failure has two different
 * honest answers.
 *
 * `sign-in` is the landing screen: nobody is signed in, so "make a new passkey"
 * costs the user nothing they were holding — a Passport this browser has
 * records for is protected by `excludeCredentials` and stays where it is.
 *
 * `mid-session` is every ceremony raised AFTER a Passport is open — the claim's
 * one assertion, the device secret behind a send or a deposit, the ownership
 * proof behind a restore. Enrolling there would not recover this Passport: a
 * new passkey derives a new seed, so it is a NEW Passport, and the name and
 * account the user is looking at belong to the old one. So the offer is
 * different — try the same action again, or sign out and decide on the landing
 * screen, where the keyless path already leads somewhere.
 */
export type PasskeyCeremonyContext = 'sign-in' | 'mid-session';

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
  /**
   * A ceremony inside an open session could not be completed. Offer the same
   * action again, and a way out of the session — never an enrolment, which
   * would start a different Passport rather than recover this one.
   */
  | 'retry-or-sign-out'
  /** Nothing a new passkey would fix. The retry already on the screen is the offer. */
  | 'none';

export interface PasskeySignInFailure {
  stage: PasskeySignInStage;
  /** The authenticator's own reason, where the ceremony reported one. */
  reason?: PasskeyCeremonyReason | null;
  /**
   * True when Passport's own watchdog gave up rather than the platform
   * answering — a wallet extension holding the passkey dialog, or a
   * cross-device sign-in the user is still walking through, typically.
   */
  timedOut?: boolean;
  /** Defaults to `sign-in`. See {@link PasskeyCeremonyContext}. */
  context?: PasskeyCeremonyContext;
}

/**
 * The rule, and the reason behind each of its five answers.
 *
 * `mid-session` at the `credential` stage → `retry-or-sign-out`, whatever the
 * platform said and whether or not the watchdog fired. This is the one branch
 * that does not read `reason` or `timedOut`, and deliberately: the two things
 * on offer are safe under every reading of the failure. Trying again is
 * exactly right when the passkey is on a phone the user is still fetching —
 * the platform's own cross-device sheet is the correct UI for that and must
 * not be discouraged — and signing out costs nothing at all, because the name
 * and the account are on chain and the records here are not deleted by it.
 * Neither answer claims to know whether the passkey still exists, which is the
 * question WebAuthn refuses to answer. What is NOT offered here is an
 * enrolment: mid-session, a new passkey is a new seed and therefore a new
 * Passport, so it would abandon the one on screen rather than recover it.
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
  if (failure.context === 'mid-session') return 'retry-or-sign-out';
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

/**
 * What a MID-SESSION ceremony says when it could not be completed, and why it
 * is a different sentence from the keyless one above.
 *
 * Reported 2026/08/31, on the live name step: a restored session, a stored
 * profile whose credential is not in this browser's keychain, and Claim
 * pressed. macOS raised its cross-device sheet — "Sign In: Scan QR Code / Use
 * Security key" — because the passkey is on another device. Two things can be
 * true behind that sheet and the platform will not say which: the passkey is
 * on the user's phone and the QR path genuinely works, or it is gone. So the
 * sentence covers both and pushes at neither: it names the QR path first,
 * because that is the case in which the OS sheet was RIGHT and the worst thing
 * this copy could do is talk somebody out of it.
 *
 * It offers signing out rather than creating, because creating here would be a
 * new seed and therefore a new Passport — and it says what survives that, in
 * the order somebody frightened of losing their money needs to read it: the
 * name and the account are on chain, and the records this browser holds come
 * back from a backup file.
 */
export const MID_SESSION_PASSKEY_MESSAGE =
  'Your passkey could not be used on this device. If it is on your phone, try again and follow the QR option. If it is gone, sign out and create a new passkey — this Passport’s name and account stay on chain, and a backup file can restore its records.';

/**
 * What Passport says when its OWN watchdog gave up, and the certainty this
 * copy had to lose.
 *
 * It used to open "Your device never showed the passkey prompt." On 2026/08/31
 * that sentence was photographed on the live name step underneath a macOS
 * cross-device sheet that had very much been shown — the user was mid-way
 * through a QR sign-in when the watchdog fired beneath it. The watchdog cannot
 * see the platform's sheet, so it cannot know whether one appeared, and a
 * screen that asserts otherwise is telling a person their own eyes are wrong.
 *
 * What it can honestly say is that the prompt did not FINISH. The extension
 * hint survives, because a wallet extension holding the dialog is a real and
 * observed cause (Lace, 2026/08/06) — it is just no longer the only story
 * offered.
 */
export const PASSKEY_CEREMONY_TIMEOUT_MESSAGE =
  'The passkey prompt did not finish. If your device showed a QR code, signing with your phone can take a minute — try again and leave the prompt open. A browser extension can also block the prompt; a private window rules that out.';

/**
 * The sentence a mid-session way-out panel puts above its two controls.
 *
 * A watchdog timeout keeps its own words — it is a different fact from a
 * platform refusal, and the advice that goes with it ("leave the prompt open")
 * is advice the other sentence cannot give. Both end at the same two controls,
 * which is what {@link passkeySignInRecovery} decides.
 */
export function midSessionPasskeyMessage(failure: Pick<PasskeySignInFailure, 'timedOut'>): string {
  return failure.timedOut === true ? PASSKEY_CEREMONY_TIMEOUT_MESSAGE : MID_SESSION_PASSKEY_MESSAGE;
}

/**
 * The mark a mid-session failure carries across a seam, and why it is a
 * property rather than a class.
 *
 * The error a refused ceremony throws has to keep travelling as whatever it
 * already was — a `PasskeyPresenceError` whose `code` the app-facing transfer
 * protocol maps, or a claim's own refusal — because a surface downstream reads
 * that shape and a new class would break it. What the surfaces additionally
 * need to know is one bit: does this failure carry a way out, or is it an
 * ordinary refusal with an ordinary sentence? So the bit is attached to the
 * error that already exists, and read back through a guard rather than by
 * matching on copy, which would break the first time the copy was edited.
 */
const MID_SESSION_WAY_OUT = '__passportPasskeyWayOut';

/** Marks `error` as a failure whose surface must offer a way out. Returns it. */
export function markMidSessionWayOut<E extends object>(error: E): E {
  Object.defineProperty(error, MID_SESSION_WAY_OUT, { value: true, enumerable: false });
  return error;
}

/** Whether `cause` was marked by {@link markMidSessionWayOut}. */
export function isMidSessionWayOut(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as Record<string, unknown>)[MID_SESSION_WAY_OUT] === true
  );
}
