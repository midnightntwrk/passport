import { ArrowRight, Fingerprint, KeyRound, Loader2, Wallet, X } from 'lucide-react'
import ThemeToggle from './ThemeToggle'
import './onboarding.css'

export interface OnboardingProps {
  stage: 'welcome' | 'choose' | 'working'
  busyLabel?: string | null
  error?: string | null
  hasExistingPassport: boolean
  /**
   * Set when "Sign in" genuinely cannot run — there is no passkey record on
   * this device to assert against. The option is disabled and this is shown
   * beneath it rather than the button failing after a prompt.
   */
  signInUnavailableReason?: string | null
  /** Set while the Dynamic SDK cannot start a sign-in. Same contract as above. */
  dynamicUnavailableReason?: string | null
  onGetStarted: () => void
  /** Enrols a WebAuthn PRF passkey and builds the on-device wallet. No Dynamic. */
  onCreatePasskey: () => void
  /** Asserts the existing passkey and rebuilds the on-device wallet. No Dynamic. */
  onSignInPasskey: () => void
  /** The Dynamic-hosted account and embedded Midnight wallet. */
  onContinueWithDynamic: () => void
  onDismissError?: () => void
  /** Escape hatch to the classic dashboard, kept reachable before sign-in. */
  onOpenClassic?: () => void
}

interface PasskeyChoice {
  key: 'create' | 'signin'
  label: string
  explainer: string
  icon: typeof KeyRound
  onSelect: () => void
  disabledReason?: string | null
}

export default function OnboardingScreen(props: OnboardingProps) {
  const {
    stage,
    busyLabel,
    error,
    hasExistingPassport,
    signInUnavailableReason,
    dynamicUnavailableReason,
    onGetStarted,
    onCreatePasskey,
    onSignInPasskey,
    onContinueWithDynamic,
    onDismissError,
    onOpenClassic,
  } = props

  const createChoice: PasskeyChoice = {
    key: 'create',
    label: 'Create passkey',
    explainer: 'A new Passport passkey on this device, with its own Midnight wallet',
    icon: KeyRound,
    onSelect: onCreatePasskey,
  }
  const signInChoice: PasskeyChoice = {
    key: 'signin',
    label: 'Sign in',
    explainer: 'Unlock this device’s Passport passkey and reopen its wallet',
    icon: Fingerprint,
    onSelect: onSignInPasskey,
    disabledReason: signInUnavailableReason ?? null,
  }
  const choices: PasskeyChoice[] = hasExistingPassport
    ? [signInChoice, createChoice]
    : [createChoice, signInChoice]

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
              onClick={onGetStarted}
            >
              Get started
              <ArrowRight size={17} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {stage === 'choose' ? (
          <div className="mnob-stage" key="choose">
            <p className="mnob-choose-label" id="mnob-choose-label">
              Continue with a passkey
            </p>
            <div
              className="mnob-choices"
              role="group"
              aria-labelledby="mnob-choose-label"
            >
              {choices.map((choice, index) => {
                const Icon = choice.icon
                const disabled = Boolean(choice.disabledReason)
                const classes = ['mnob-choice']
                if (index === 0 && !disabled) classes.push('mnob-choice-lead')
                return (
                  <div className="mnob-choice-slot" key={choice.key}>
                    <button
                      type="button"
                      className={classes.join(' ')}
                      onClick={choice.onSelect}
                      disabled={disabled}
                    >
                      <span className="mnob-choice-icon" aria-hidden="true">
                        <Icon size={19} strokeWidth={1.8} />
                      </span>
                      <span className="mnob-choice-copy">
                        <strong>{choice.label}</strong>
                        <small>{choice.explainer}</small>
                      </span>
                      <ArrowRight
                        className="mnob-choice-arrow"
                        size={16}
                        strokeWidth={2.2}
                        aria-hidden="true"
                      />
                    </button>
                    {choice.disabledReason ? (
                      <p className="mnob-choice-note">{choice.disabledReason}</p>
                    ) : null}
                  </div>
                )
              })}
            </div>

            {/* Deliberately quieter than the two passkey routes: Dynamic is an
                alternative, not the way in. Nothing above this line contacts
                it. */}
            <div className="mnob-alt">
              <p className="mnob-alt-label" id="mnob-alt-label">
                Or use a hosted account
              </p>
              <div className="mnob-choice-slot">
                <button
                  type="button"
                  className="mnob-choice mnob-choice-quiet"
                  onClick={onContinueWithDynamic}
                  disabled={Boolean(dynamicUnavailableReason)}
                  aria-describedby="mnob-alt-label"
                >
                  <span className="mnob-choice-icon" aria-hidden="true">
                    <Wallet size={19} strokeWidth={1.8} />
                  </span>
                  <span className="mnob-choice-copy">
                    <strong>Continue with Dynamic</strong>
                    <small>
                      Social sign-in and a Dynamic embedded Midnight wallet
                    </small>
                  </span>
                  <ArrowRight
                    className="mnob-choice-arrow"
                    size={16}
                    strokeWidth={2.2}
                    aria-hidden="true"
                  />
                </button>
                {dynamicUnavailableReason ? (
                  <p className="mnob-choice-note">{dynamicUnavailableReason}</p>
                ) : null}
              </div>
            </div>
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

      <footer className="mnob-foot">
        <span>Preview network demo — not production</span>
        {onOpenClassic ? (
          <button type="button" className="mnob-foot-link" onClick={onOpenClassic}>
            Full dashboard
          </button>
        ) : null}
      </footer>
    </section>
  )
}
