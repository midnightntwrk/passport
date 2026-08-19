import { ArrowRight, Fingerprint, Loader2, X } from 'lucide-react'
import ThemeToggle from './ThemeToggle'
import './onboarding.css'

/**
 * Onboarding — one primary action (2026/08/05 decision).
 *
 * "Sign in" and "Create passkey" are consolidated into a single button whose
 * behaviour the integrator resolves: if a local Passport profile exists in
 * this browser the existing sign-in/unlock flow runs, otherwise the existing
 * create/enrol flow runs. WebAuthn discoverable credentials mean the
 * assertion path also covers a passkey synced from another device.
 *
 * The mobile onboarding offers no route to Dynamic at all. The "Full dashboard"
 * footer link was cut on 2026/08/19: the demo runs "only with the local,
 * without Dynamics", so the Dynamic-hosted classic view must have no
 * user-visible entry point from this screen. The classic experience itself
 * stays in the tree and stays reachable through its internal routes; only the
 * door from onboarding is closed.
 */
export interface OnboardingProps {
  stage: 'welcome' | 'working'
  busyLabel?: string | null
  error?: string | null
  /**
   * Whether a Passport passkey is already enrolled in this browser. `null`
   * while the lookup is still running; the button works in every case — this
   * only tunes the sentence beneath it.
   */
  hasExistingPassport: boolean | null
  /**
   * The one action. Signs in when a local Passport exists here, enrols a new
   * passkey otherwise. No Dynamic involvement on this route.
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
  /**
   * @deprecated Ignored since 2026/08/19.
   *
   * This drove the footer's "Full dashboard" escape hatch into the classic
   * Dynamic-hosted view. The demo flow must not offer it, so nothing renders
   * it. The prop stays on the interface so the integrator needs no change.
   */
  onOpenClassic?: () => void
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
        ? 'Creates a passkey on this device the first time, then signs you straight in.'
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

      {/* No "Full dashboard" link: the classic view is Dynamic-hosted, and the
          demo runs local-only. The footer carries the honesty note alone. */}
      <footer className="mnob-foot">
        <span>Preview network demo — not production</span>
      </footer>
    </section>
  )
}
