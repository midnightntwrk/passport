import { useState, type FormEvent } from 'react'
import { ArrowRight, Loader2, Search, ShieldCheck } from 'lucide-react'

import { normaliseNameForRecovery, type NameRecoveryOutcome } from '../lib/nameRecovery.js'
import ThemeToggle from './ThemeToggle'
import './onboarding.css'

/**
 * FINDING A PASSPORT BY ITS NAME — the recovery that does not need the passkey
 * to be carrying anything (2026/09/04).
 *
 * WHY IT HAD TO EXIST. Every recovery Passport had until now went through the
 * WebAuthn largeBlob extension: a claim writes the account's address onto the
 * credential, and a device that has never seen this Passport reads it back. On
 * Android that mechanism does not exist. Google Password Manager's passkeys
 * implement PRF, which is what the wallet seed comes from, and do not implement
 * largeBlob at all — so on the platform most reviewers were holding, there was
 * no blob to write, nothing to read back, and therefore no way whatsoever to
 * come back to an existing Passport on a browser that had forgotten it. What
 * such a person met instead was "Choose your .night name", over a Passport that
 * already had one, where claiming again would set up a second account.
 *
 * WHAT IT ASKS FOR, and why a name is enough to ASK with and not enough to
 * restore on. A `.night` name is public: it is in the registry, anybody can
 * resolve it, and knowing one proves nothing. So the name is only ever the
 * QUESTION — it says which account to go and look at. The answer comes from the
 * account itself: the host derives this passkey's device secret from its PRF
 * output and asks the contract, on chain, whether that device is one of its
 * active devices. Only a passkey that was actually enrolled into that account
 * can pass, and no amount of knowing somebody's name will do it.
 *
 * That check is `accountHoldsDevice` in `../identity/accountCustody.ts`, which
 * is the same proof a restored backup file has to pass, for the same reason: a
 * name, an address, and a transaction id are all things an attacker can know,
 * and the device set inside the contract is the only thing that answers "can
 * this Passport spend from it".
 *
 * ONE CEREMONY. Deriving the device secret is one assertion, and it is raised
 * only after the person has typed a name and pressed a button — nothing here
 * prompts anybody who asked for nothing.
 */

export interface RecoverByNameProps {
  /**
   * Resolves the name, proves ownership, and — on `found` — has ALREADY
   * restored the Passport and moved the session on, so this screen is gone by
   * the time it settles. Every other answer stays here with its sentence.
   */
  onFind: (name: string) => Promise<NameRecoveryOutcome>
  /** Goes back to choosing a new name. Always available: this is an offer. */
  onBack: () => void
}

/**
 * The sentence each answer gets, and the distinction the copy has to keep.
 *
 * `not-yours` and `unreachable` are the pair that must never be muddled. The
 * first tells somebody this is not their Passport, which is a serious thing to
 * say; the second says the question could not be put, which is a bad minute on
 * a train. A single "could not find it" for both would tell a person on a poor
 * connection that they have lost their identity.
 */
function outcomeMessage(outcome: NameRecoveryOutcome): string | null {
  if (outcome.kind === 'found') return null
  if (outcome.kind === 'unknown') {
    return 'No Passport is registered under that name. Check the spelling, or go back and choose a name for a new one.'
  }
  if (outcome.kind === 'not-yours') {
    return 'That name belongs to a Passport this passkey is not part of. If you have more than one passkey, go back and sign in with the other one.'
  }
  return `Midnight could not be reached to check that name. ${outcome.detail}`
}

export default function RecoverByNameScreen(props: RecoverByNameProps) {
  const { onFind, onBack } = props
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const trimmed = normaliseNameForRecovery(name)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || !trimmed) return
    setBusy(true)
    setMessage(null)
    void onFind(trimmed)
      .then((outcome) => setMessage(outcomeMessage(outcome)))
      .catch((cause: unknown) => {
        setMessage(
          cause instanceof Error
            ? cause.message
            : 'That name could not be checked just now. Try again in a moment.',
        )
      })
      .finally(() => setBusy(false))
  }

  return (
    <section className="mnob-screen" aria-busy={busy}>
      <header className="mnob-bar">
        <img className="mnob-wordmark" src="/midnight-wordmark.svg" alt="Midnight" />
        <span className="mnob-bar-label">Passport</span>
        <ThemeToggle size="sm" className="mnob-theme" />
      </header>

      <div className="mnob-body">
        <p className="mnob-kicker">Already have a Passport</p>
        <h1 className="mnob-title">
          <span>Find it</span>
          <span>by its name</span>
        </h1>
        <p className="mnob-lede">
          Type the <code>.night</code> name you already hold. Passport will check with Midnight that
          this passkey is part of that account before bringing anything back.
        </p>

        <form className="mnob-stage" onSubmit={submit}>
          <label className="mnob-hint" htmlFor="recover-name">
            Your name
          </label>
          <input
            id="recover-name"
            className="mnob-input"
            type="text"
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="alice"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
          {message ? (
            <div className="mnob-unusable" role="alert">
              <p className="mnob-unusable-copy">{message}</p>
            </div>
          ) : null}
          <button type="submit" className="mnob-primary" disabled={busy || !trimmed}>
            <span className="mnob-primary-copy">
              {busy ? (
                <Loader2 className="mnob-working-spinner" size={17} strokeWidth={2} aria-hidden="true" />
              ) : (
                <Search size={17} strokeWidth={2} aria-hidden="true" />
              )}
              {busy ? 'Checking with Midnight' : 'Find my Passport'}
            </span>
            <ArrowRight size={17} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <p className="mnob-hint">
            <ShieldCheck size={14} strokeWidth={2} aria-hidden="true" /> Your device confirms this is
            yours. Knowing the name is not enough on its own.
          </p>
          <button type="button" className="mnob-alt" onClick={onBack} disabled={busy}>
            Choose a new name instead
          </button>
        </form>
      </div>

      <footer className="mnob-foot">
        <span>Test network demo — not production</span>
      </footer>
    </section>
  )
}
