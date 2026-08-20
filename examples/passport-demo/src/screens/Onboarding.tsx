import { ArrowRight, Fingerprint, Loader2, X } from 'lucide-react'
import ThemeToggle from './ThemeToggle'
import './onboarding.css'

/**
 * Onboarding — one primary action (2026/08/05 decision).
 *
 * "Sign in" and "Create passkey" are consolidated into a single button whose
 * behaviour the integrator resolves: if a local Passport profile exists in
 * this browser the existing sign-in/unlock flow runs, otherwise the
 * create flow runs — and that flow ASKS THE AUTHENTICATOR before it enrols
 * anything. "No local profile" is not "no passkey": site data cleared with the
 * passkey still in the keychain looks exactly like a first visit, and creating
 * there would replace the surviving credential and make its wallet seed
 * underivable. So a resident credential that answers is signed in to instead.
 * WebAuthn discoverable credentials mean the assertion path also covers a
 * passkey synced from another device.
 *
 * This is the only way in. There is no second, hosted route to offer, and no
 * vendor sign-in to wait on.
 */
export interface OnboardingProps {
  stage: 'welcome' | 'working'
  busyLabel?: string | null
  error?: string | null
  /**
   * Whether a Passport passkey is already enrolled in this browser. `null`
   * while the lookup is still running; the button works in every case — this
   * only tunes the sentence beneath it.
   *
   * `false` means only that this BROWSER holds no record. The device may still
   * hold the passkey, which is why the copy below promises a sign-in rather
   * than a creation, and why the flow behind the button discovers first.
   */
  hasExistingPassport: boolean | null
  /**
   * The one action. Signs in when a local Passport exists here; otherwise
   * discovers first and enrols only when no passkey answers. A refused
   * enrolment (the authenticator already holds the credential) must route
   * into sign-in, never into an error.
   */
  onContinue: () => void
  /**
   * Quiet secondary path: a DISCOVERABLE WebAuthn assertion with no
   * allow-list, so the platform shows its own picker of resident passkeys.
   * Whichever credential the user picks signs in to its own profile, or has
   * one created and bound to it if none exists here yet.
   */
  onUseDifferentPasskey?: () => void
  onDismissError?: () => void
}

export default function OnboardingScreen(props: OnboardingProps) {
  const {
    stage,
    busyLabel,
    error,
    hasExistingPassport,
    onContinue,
    onUseDifferentPasskey,
    onDismissError,
  } = props

  const continueHint =
    hasExistingPassport === true
      ? 'Unlocks the Passport on this device with its passkey.'
      : hasExistingPassport === false
        ? 'Signs you in if this device already has a Passport, and creates one if it does not.'
        : 'Uses a passkey on this device — sign in, or create your Passport the first time.'

  return (
    <section className="mnob-screen" aria-busy={stage === 'working'}>
      <header className="mnob-bar">
        <img
          className="mnob-wordmark"
          src="/midnight-wordmark.svg"
          alt="Midnight"
        />
        <span className="mnob-bar-label">Passport</span>
        <ThemeToggle size="sm" className="mnob-theme" />
      </header>

      <div className="mnob-body">
        <p className="mnob-kicker">Identity for the Midnight network</p>
        <h1 className="mnob-title">
          <span>Midnight</span>
          <span>Passport</span>
        </h1>
        <p className="mnob-lede">
          One passkey. Your names, addresses, and credentials — held on this
          device, proven in private.
        </p>

        {error ? (
          <div className="mnob-error" role="alert">
            <span className="mnob-error-copy">{error}</span>
            {onDismissError ? (
              <button
                type="button"
                className="mnob-error-dismiss"
                onClick={onDismissError}
                aria-label="Dismiss error"
              >
                <X size={14} strokeWidth={2.4} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}

        {stage === 'welcome' ? (
          <div className="mnob-stage" key="welcome">
            <button
              type="button"
              className="mnob-primary"
              onClick={onContinue}
            >
              <span className="mnob-primary-copy">
                <Fingerprint size={18} strokeWidth={2} aria-hidden="true" />
                Continue with Passport
              </span>
              <ArrowRight size={17} strokeWidth={2.2} aria-hidden="true" />
            </button>
            <p className="mnob-hint">{continueHint}</p>
            {onUseDifferentPasskey ? (
              <button
                type="button"
                className="mnob-alt"
                onClick={onUseDifferentPasskey}
              >
                Use a different passkey
              </button>
            ) : null}
          </div>
        ) : null}

        {stage === 'working' ? (
          <div className="mnob-stage" key="working">
            <div className="mnob-working" role="status">
              <Loader2
                className="mnob-working-spinner"
                size={19}
                strokeWidth={2}
                aria-hidden="true"
              />
              <span className="mnob-working-copy">
                {busyLabel ?? 'Working…'}
              </span>
            </div>
            <p className="mnob-working-hint">
              Follow the prompt from your device to continue.
            </p>
          </div>
        ) : null}
      </div>

      {/* The footer carries the honesty note alone — there is no second route
          to link to. */}
      <footer className="mnob-foot">
        <span>Preview network demo — not production</span>
      </footer>
    </section>
  )
}
