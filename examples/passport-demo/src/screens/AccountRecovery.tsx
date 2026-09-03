import { Fingerprint, RotateCcw, SearchX } from 'lucide-react'

import ThemeToggle from './ThemeToggle'
import './onboarding.css'

/**
 * THE WAY OUT of an account that cannot be found (2026/09/03).
 *
 * A passkey coming back to a browser that holds nothing carries the account it
 * was set up for. Usually the chain answers for it and the person lands on
 * their own Passport. Sometimes it does not: a node a few blocks behind, an
 * account set up on another network, or — the case that has to be admitted —
 * an account that is genuinely not there.
 *
 * What used to happen then was nothing at all. One read, no answer, nothing
 * kept, and the person was put on "Choose your .night name" over a Passport
 * they had already named — where claiming again would have set up a SECOND
 * account and paid for a second name, and where the account they actually had
 * would never be looked for again. The only record of any of it was a line in
 * the activity trail behind a screen they could not reach.
 *
 * So the search now has an end, and the end is a screen with two controls,
 * because there are exactly two honest things to do about it:
 *
 *   - LOOK AGAIN. Free, and the right answer for every transient cause — which
 *     is most of them. It is first for that reason.
 *   - START AGAIN. Sets nothing up on its own: it clears what was read off the
 *     passkey and hands the person back to the name step, where setting up an
 *     account is something they choose and watch. Nothing is deployed behind
 *     their back, and the sentence under the button says what happens to the
 *     account the passkey names, which is: nothing. It stays where it is, and
 *     signing in again on a device that can see it will find it.
 *
 * There is deliberately no third control and no "contact support". Every other
 * route out of this state — a backup file, a different passkey — is reachable
 * from the screens these two lead to.
 */
export interface AccountRecoveryProps {
  /** The name read off the passkey, when it carried one. */
  name?: string | null
  /** Looks for the account again, from the first attempt. */
  onTryAgain: () => void
  /**
   * Clears what the passkey said and goes to the name step. Sets nothing up:
   * the person chooses their name there, exactly as a new Passport does.
   */
  onStartOver: () => void
  /** True while a look is already running, so neither control fires twice. */
  busy?: boolean
}

export default function AccountRecoveryScreen(props: AccountRecoveryProps) {
  const { name, onTryAgain, onStartOver, busy } = props

  return (
    <section className="mnob-screen" aria-busy={busy === true}>
      <header className="mnob-bar">
        <img className="mnob-wordmark" src="/midnight-wordmark.svg" alt="Midnight" />
        <span className="mnob-bar-label">Passport</span>
        <ThemeToggle size="sm" className="mnob-theme" />
      </header>

      <div className="mnob-body">
        <p className="mnob-kicker">Your passkey is fine</p>
        <h1 className="mnob-title">
          <span>We could not</span>
          <span>find your account</span>
        </h1>
        <p className="mnob-lede">
          {name
            ? `Your passkey remembers ${name}, but Midnight has not answered for that account yet. This usually means the network is still catching up.`
            : 'Your passkey remembers an account, but Midnight has not answered for it yet. This usually means the network is still catching up.'}
        </p>

        <div className="mnob-unusable" role="alert">
          <p className="mnob-unusable-copy">
            <SearchX size={16} strokeWidth={2} aria-hidden="true" /> Nothing has been lost. Your
            account is not on this device to begin with — it is on Midnight, and looking again
            costs nothing.
          </p>
        </div>

        <div className="mnob-stage">
          <button type="button" className="mnob-primary" onClick={onTryAgain} disabled={busy === true}>
            <span className="mnob-primary-copy">
              <RotateCcw size={17} strokeWidth={2} aria-hidden="true" />
              Try again
            </span>
          </button>
          <p className="mnob-hint">Looks for your account once more.</p>
          <button type="button" className="mnob-alt" onClick={onStartOver} disabled={busy === true}>
            <Fingerprint size={15} strokeWidth={2} aria-hidden="true" />
            Set up a new account
          </button>
          <p className="mnob-hint">
            Starts again on this device with a new name. The account your passkey remembers is left
            exactly where it is.
          </p>
        </div>
      </div>

      <footer className="mnob-foot">
        <span>Test network demo — not production</span>
      </footer>
    </section>
  )
}
