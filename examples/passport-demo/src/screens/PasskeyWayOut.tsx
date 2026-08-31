import { LogOut, RotateCcw } from 'lucide-react'
import './passkeyWayOut.css'

/**
 * The two controls a MID-SESSION passkey failure must carry, wherever it
 * happens.
 *
 * THE DEAD END. Reported with a screenshot on 2026/08/31, on the live name
 * step: a session restored from a stored profile whose credential is not in
 * this browser's keychain, Claim pressed, and macOS raising its cross-device
 * sheet — "Sign In: Scan QR Code / Use Security key" — because the passkey is
 * on another device. Two things can be behind that sheet and WebAuthn will not
 * say which. If the passkey is on the user's phone the QR path genuinely
 * works, and nothing here may discourage it. If it is gone, the screen the
 * user came back to carried one line of error text and no control at all — and
 * the name step has no sign-out in its header, so that card was the whole of
 * what they had.
 *
 * WHY THE OFFER IS NOT THE ONBOARDING ONE. The landing screen answers the same
 * ceremony failure with "Create a new passkey" (see `PasskeyWayOut` in
 * `Onboarding.tsx`), and that is right THERE: nobody is signed in, so a new
 * credential costs nothing that was being held. Mid-session it would cost
 * everything — a new passkey derives a new seed, so it opens a NEW Passport,
 * not the one whose name is on the screen. So this offers the two things that
 * are safe under both readings: run the same action again, and leave the
 * session. Creating is still reachable, one step further on, from the landing
 * screen the sign-out lands on — which is where it is safe and where it is
 * already explained.
 *
 * It is a component rather than two buttons copied into two screens because
 * the claim and the send sheet must not drift into offering different ways out
 * of the same failure — the same reason `PasskeyWayOut` is one component for
 * onboarding's two states. Each surface renders it inside its OWN failure
 * area, in that surface's idiom, so it reads as part of the screen it
 * interrupted rather than as a notification floating over it.
 */
export interface PasskeyWayOutActionsProps {
  /**
   * Runs the SAME action again — the claim that was pressed, the send that was
   * confirmed. It is first because it is the answer in the case where the
   * platform was right: the passkey is on a phone, and the second attempt is
   * the one the user completes.
   */
  onRetry: () => void
  /**
   * Leaves the session for the landing screen. Never enrols anything itself:
   * the landing screen's own keyless panel makes that offer, with the sentence
   * that explains what a new passkey does and does not carry over.
   */
  onSignOut: () => void
  /** True while the surface is busy, so neither control fires twice. */
  busy?: boolean
}

export function PasskeyWayOutActions(props: PasskeyWayOutActionsProps) {
  return (
    <div className="mnwo-actions">
      <button
        type="button"
        className="mnwo-action mnwo-action-primary"
        onClick={props.onRetry}
        disabled={props.busy === true}
      >
        <RotateCcw size={15} strokeWidth={2} aria-hidden="true" />
        Try again
      </button>
      <button
        type="button"
        className="mnwo-action"
        onClick={props.onSignOut}
        disabled={props.busy === true}
      >
        <LogOut size={15} strokeWidth={2} aria-hidden="true" />
        Sign out
      </button>
    </div>
  )
}

export default PasskeyWayOutActions
