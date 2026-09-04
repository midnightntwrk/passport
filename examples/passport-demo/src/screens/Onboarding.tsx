import type { ReactNode } from 'react'
import { ArrowRight, Eraser, Fingerprint, Loader2, X } from 'lucide-react'
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
  /**
   * The authenticator's own account of a credential that answered WITHOUT a
   * PRF result, or null when that has not happened. It cannot open a Passport,
   * and Passport will not create over it unasked.
   *
   * This is a state, not a message, because it needs a control of its own —
   * see {@link OnboardingProps.onCreateNewPasskey}. Until 2026/08/26 it was
   * only a message, and the message was WRONG: it told the user to choose "Use
   * a different passkey", which runs a discoverable assertion and can never
   * enrol, so the same PRF-less credential answered the picker again and the
   * user looped with no way out but to dismiss the OS dialog.
   */
  unusableCredential?: string | null
  /**
   * The sign-in produced NO credential at all, or null when that has not
   * happened. Holds the sentence to show.
   *
   * The second state that needs a control rather than a paragraph, and the one
   * the user named on 2026/08/30: "if there is no key, can you not just create
   * it? Why does it always have to load it?" This browser holds Passport
   * records, the platform keystore can no longer produce the passkey they
   * name — deleted, another OS profile, never synced — and the "use a saved
   * passkey" sheet comes back with nothing loadable. Everything on the screen
   * then pointed at loading; nothing pointed at making.
   *
   * Distinct from {@link OnboardingProps.unusableCredential} because the two
   * are different facts and deserve different sentences: there, something
   * answered and cannot open a Passport; here, nothing answered. The way out
   * happens to be the same button.
   */
  keylessPasskey?: string | null
  /**
   * The passkey this device MADE cannot open a Passport, or null when that has
   * not happened. Holds the sentence to show.
   *
   * The third dead end, and the only one whose way out is not a button on this
   * screen. The platform was asked for the extension Passport derives keys
   * from, it made the passkey without it, and it will do the same next time —
   * so there is nothing to press here that would change the answer, and a
   * "Create a new passkey" control would be a loop wearing the clothes of a
   * remedy. What the copy points at instead is a passkey held somewhere else,
   * which "Use a different passkey" below reaches through the platform's own
   * cross-device sheet, and another device.
   *
   * Found on Android by `e2e/android-shapes.spec.ts`, 2026/09/04.
   */
  unusableDevice?: string | null
  /**
   * Enrols a NEW passkey, deliberately. Offered only alongside
   * {@link OnboardingProps.unusableCredential} or
   * {@link OnboardingProps.keylessPasskey}, because those are the states in
   * which creating is both safe and what the user has asked for: no credential
   * that could open a Passport is available either way, and the integrator
   * still passes every credential this browser has a Passport record for as an
   * exclusion, so a real Passport cannot be replaced.
   */
  onCreateNewPasskey?: () => void
  /**
   * FORGETS what this device holds for the passkey it would otherwise sign in
   * to, and then creates a Passport from scratch.
   *
   * The control that did not exist until 2026/09/04, and the one a reviewer on
   * Android needed: "there is no way I can recreate an account or create a new
   * one. I'm stuck with the orphan key that does not contain the contract
   * attached… Even deleting and recreating the passkeys under different accounts
   * doesn't do the job." Every other control on this screen is a way of getting
   * BACK INTO what this browser already holds. When what it holds is wrong, all
   * of them lead back to the same wrong place, and the person is stuck inside an
   * app that keeps confidently restoring a Passport they are trying to abandon.
   *
   * It is a separate prop from {@link OnboardingProps.onCreateNewPasskey}
   * because they are different promises. That one makes a new passkey and
   * leaves everything this browser holds alone — which is right when the
   * records are fine and the passkey is not. This one clears the records. A
   * single button that sometimes did the second thing would be the worse kind
   * of surprise.
   *
   * Offered only where there is something to forget; see the render below.
   */
  onStartFresh?: () => void
  onDismissError?: () => void
}

/**
 * "Set up a new Passport on this device", with the sentence that has to go
 * under it.
 *
 * One component because it is offered from three places on this screen — the
 * welcome stage's secondary path and both way-out panels — and the two fears a
 * person pressing it has must be answered identically in all three. Those fears
 * are the passkey and the money, in that order, and the answer to both is that
 * this reaches neither: no web page can delete a passkey, and the account and
 * the name are on Midnight rather than in this browser.
 */
function StartFresh(props: { onStartFresh: () => void }) {
  return (
    <>
      <button type="button" className="mnob-alt" onClick={props.onStartFresh}>
        <Eraser size={15} strokeWidth={2} aria-hidden="true" />
        Set up a new Passport on this device
      </button>
      <p className="mnob-hint">
        Clears what this device remembers and starts over. Your passkey stays on your device, and
        anything already on Midnight stays there.
      </p>
    </>
  )
}

/**
 * A failure that carries its own way out: the explanation, and beneath it the
 * control that resolves it.
 *
 * One component for both states rather than two nearly-identical blocks, so
 * they cannot drift apart — a way out that looked like an afterthought in one
 * of them and a real offer in the other would teach users to ignore both.
 *
 * The hint says only what the button DOES. The promise that a surviving
 * Passport is safe belongs to the copy above it, and is made there once, in
 * each state's own words: saying it twice on one panel — which is what this
 * looked like when both states first shared the hint — reads as protesting.
 */
function PasskeyWayOut(props: {
  copy: ReactNode
  onCreateNewPasskey?: () => void
  onStartFresh?: () => void
}) {
  return (
    <div className="mnob-unusable" role="alert">
      <p className="mnob-unusable-copy">{props.copy}</p>
      {props.onCreateNewPasskey ? (
        <>
          <button
            type="button"
            className="mnob-unusable-action"
            onClick={props.onCreateNewPasskey}
          >
            <Fingerprint size={16} strokeWidth={2} aria-hidden="true" />
            Create a new passkey
          </button>
          <p className="mnob-hint">
            Makes a new passkey on this device and opens a Passport with it — everything this device
            already holds is left alone.
          </p>
        </>
      ) : null}
      {/* AND THE STRONGER ONE, second because it forgets things and the one
          above does not. A person who has reached this panel twice is exactly
          the person who needs it: the passkey above is made afresh every time
          and still lands on the same wrong Passport, because it was never the
          passkey that was wrong. */}
      {props.onStartFresh ? <StartFresh onStartFresh={props.onStartFresh} /> : null}
    </div>
  )
}

export default function OnboardingScreen(props: OnboardingProps) {
  const {
    stage,
    busyLabel,
    error,
    hasExistingPassport,
    onContinue,
    onUseDifferentPasskey,
    unusableCredential,
    keylessPasskey,
    unusableDevice,
    onCreateNewPasskey,
    onStartFresh,
    onDismissError,
  } = props

  /* Offered only where this browser HOLDS something to forget. On a genuinely
     first visit there is nothing to clear, and a control promising to clear it
     would be describing a state the reader is not in — which is how the "Sign
     in" advice this screen used to give became a sentence about a button that
     was not there. `null` is "still looking", and says nothing either way. */
  const startFresh = hasExistingPassport === true ? onStartFresh : undefined

  /* A way-out panel already carries this control, so the stage below must not
     carry a second copy of it. Two buttons with the same words on one screen
     is not emphasis — it is the reader wondering whether they do the same
     thing, on the screen where they are already stuck. */
  const wayOutShown = Boolean(
    (unusableCredential || keylessPasskey || unusableDevice) && stage === 'welcome',
  )

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

        {/* DEAD END ONE, AND ITS WAY OUT.
            A resident credential answered and returned no PRF output, so it
            cannot open a Passport. The explanation stays — it is the only
            thing that makes the next click comprehensible — but the advice is
            now a BUTTON that does what it says. It used to be a sentence
            pointing at "Use a different passkey", which asserts and never
            enrols, so the same credential answered the picker again and the
            user was stuck (found by adversarial verification, 2026/08/26). */}
        {unusableCredential && stage === 'welcome' ? (
          <PasskeyWayOut
            copy={
              <>
                {unusableCredential} It cannot open a Passport — Passport needs the WebAuthn PRF
                extension to derive your keys. Any passkey this browser already holds a Passport
                for is left untouched.
              </>
            }
            onCreateNewPasskey={onCreateNewPasskey}
            onStartFresh={startFresh}
          />
        ) : null}

        {/* DEAD END TWO, AND THE SAME WAY OUT (2026/08/30).
            Nothing answered at all. This browser holds Passport records, the
            platform will not produce the passkey they name, and the saved-
            passkey sheet had nothing in it to load. Every control on this
            screen used to be a way of LOADING a passkey, which is exactly what
            had just failed, so the state was terminal — the user's own
            question was why it always has to load one. The copy does not claim
            the passkey is gone, because WebAuthn never says so; it says what
            can be seen, and offers the thing that works either way. */}
        {keylessPasskey && stage === 'welcome' ? (
          <PasskeyWayOut
            copy={keylessPasskey}
            onCreateNewPasskey={onCreateNewPasskey}
            onStartFresh={startFresh}
          />
        ) : null}

        {/* DEAD END THREE, AND THE ONE WITH NO BUTTON OF ITS OWN (2026/09/04).
            A passkey was made here and came back unable to derive a key. Every
            control this screen could offer that MAKES something would ask the
            same platform the same question and get the same passkey, so none
            is offered: the sentence names the two things that do lead
            somewhere, and "Use a different passkey" beneath it is the one of
            them this screen can run. `onStartFresh` still appears where this
            browser holds records, because forgetting them is a real thing to
            want here and is never a loop. */}
        {unusableDevice && stage === 'welcome' ? (
          <PasskeyWayOut copy={unusableDevice} onStartFresh={startFresh} />
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
            {/* THE THIRD PATH, and the only one on this screen that goes
                FORWARD rather than back. The two above both reopen what this
                browser already holds; when that is an orphaned Passport —
                a name with no account behind it — neither of them can help,
                and until 2026/09/04 there was nothing here that could. */}
            {startFresh && !wayOutShown ? <StartFresh onStartFresh={startFresh} /> : null}
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
        <span>Test network demo — not production</span>
      </footer>
    </section>
  )
}
