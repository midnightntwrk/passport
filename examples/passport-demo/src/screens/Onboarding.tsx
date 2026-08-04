import { ArrowRight, Fingerprint, KeyRound, Loader2, X } from 'lucide-react'
import './onboarding.css'

export interface OnboardingProps {
  stage: 'welcome' | 'choose' | 'working'
  busyLabel?: string | null
  error?: string | null
  hasExistingPassport: boolean
  onGetStarted: () => void
  onCreatePasskey: () => void
  onSignInPasskey: () => void
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
}

export default function OnboardingScreen(props: OnboardingProps) {
  const {
    stage,
    busyLabel,
    error,
    hasExistingPassport,
    onGetStarted,
    onCreatePasskey,
    onSignInPasskey,
    onDismissError,
    onOpenClassic,
  } = props

  const createChoice: PasskeyChoice = {
    key: 'create',
    label: 'Create new Passkey',
    explainer: 'Set up this device with a new Passport passkey',
    icon: KeyRound,
    onSelect: onCreatePasskey,
  }
  const signInChoice: PasskeyChoice = {
    key: 'signin',
    label: 'Sign in with Passkey',
    explainer: 'Unlock your existing Passport on this device',
    icon: Fingerprint,
    onSelect: onSignInPasskey,
  }
  const choices: PasskeyChoice[] = hasExistingPassport
    ? [signInChoice, createChoice]
    : [createChoice, signInChoice]

  return (
    <section className="mnob-screen" aria-busy={stage === 'working'}>
      <div className="mnob-art" aria-hidden="true" />

      <header className="mnob-bar">
        <img
          className="mnob-wordmark"
          src="/midnight-wordmark.svg"
          alt="Midnight"
        />
        <span className="mnob-bar-label">Passport</span>
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
                return (
                  <button
                    key={choice.key}
                    type="button"
                    className={
                      index === 0
                        ? 'mnob-choice mnob-choice-lead'
                        : 'mnob-choice'
                    }
                    onClick={choice.onSelect}
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
                )
              })}
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
