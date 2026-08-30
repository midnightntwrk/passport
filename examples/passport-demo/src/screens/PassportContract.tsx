import { CheckCircle2, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react'

import type { PassportContractRecord } from '../identity/passportContractStore.js'
import './identity.css'

/**
 * Your account, in one line.
 *
 * STATUS, NOT A CHOICE (2026/08/19)
 * ---------------------------------
 * Hector, at the check-in: "this has to be completely transparent for the user.
 * The user shouldn't choose to deploy the contract. It should automatically
 * happen." So there is no deploy button. Claiming a `.night` name sets the
 * account up as part of the same single user action; this card reports what
 * that produced.
 *
 * The one action that remains is a RETRY, and only where a previous automatic
 * attempt FAILED — the single state where the user has a genuine decision
 * rather than a chore the app should have done for them.
 *
 * ONE CALM LINE (ruled 2026/08/26)
 * --------------------------------
 * This card used to be a developer panel: the account's address as a truncated
 * hexadecimal string, the deployment's transaction id, a sentence about which
 * transaction identifier the indexer had or had not mapped yet, and a sentence
 * about who paid the fee. Shown that on the live site, Karmel's answer was
 * "let's also hide that, please" — and she is right that none of it is a fact a
 * person acts on. The address a sender needs is offered in Receive, where it is
 * the thing you copy; the transaction is linked from the activity trail, where
 * a hash belongs.
 *
 * What is left is the answer to the only question this card was ever asked:
 * is my account ready? Three states, one line each, and a retry on the one that
 * failed. A state with nothing to report — no account yet, nothing in flight —
 * renders nothing at all rather than explaining machinery that has not run.
 */

export type PassportContractPhase = 'deriving' | 'deploying' | 'confirming'

/* User-facing wording, ruled 2026/08/26: what this narrates is the account
   being set up, not a contract being deployed. The contract is HOW Passport
   does it; "setting up your account" is what is happening to the person
   reading. All three phases now say the same calm thing, because the
   difference between them is machinery — the stages a user is genuinely
   waiting through are narrated on the claim screen's own stepper. */
const PHASE_LABELS: Record<PassportContractPhase, string> = {
  deriving: 'Setting up your account…',
  deploying: 'Setting up your account…',
  confirming: 'Setting up your account…',
}

export interface PassportContractCardProps {
  /** The stored record for this credential and network, or null when none. */
  record: PassportContractRecord | null
  /**
   * Re-runs an attempt that FAILED. Offered on nothing else: there is no
   * first-run action, because the first run is the name claim's job. Omit
   * (with no disabled reason) to hide the affordance.
   */
  onRetry?: () => void
  /** True while the account is genuinely being set up. */
  busy?: boolean
  /** Live phase while that is in flight. */
  phase?: PassportContractPhase | null
  /**
   * When set, the retry renders disabled with this sentence beneath it — the
   * honest reason it cannot run right now (Passport is still starting up, the
   * network is not one this build sets accounts up on).
   */
  disabledReason?: string | null
}

export default function PassportContractCard(props: PassportContractCardProps) {
  const { record, onRetry, busy, phase, disabledReason } = props

  const failed = record?.status === 'failed'
  /* Submitted, and not yet answered for by the network — the state a restore
     also lands in, where the address came from a file and nothing on this
     device has seen it. It is not "ready", so it does not say so: it is still
     being set up, and the next refresh settles it. */
  const settling = record?.status === 'deployed' && record.ledgerConfirmed === false
  const working = Boolean(busy) || settling
  /* The ONLY action: retrying an attempt that failed. */
  const showRetry = failed && !busy && (Boolean(onRetry) || Boolean(disabledReason))

  /* Nothing to report is reported as nothing. A Passport with no account and
     nothing in flight is mid-onboarding — the name step is what makes the
     account exist, and it is on screen at the time. A card explaining that
     here would be machinery narrating itself. */
  if (!record && !busy) return null

  return (
    <article
      className="mnid-card mnid-card-embedded mnid-account"
      /* This card is what a claim's own toast is ABOUT, and on Home the
         bottom-pinned stack landed straight on top of "Your account is ready".
         The stack measures anything marked this way and lifts clear of it —
         see the layout effect in `ToastStack.tsx`. */
      data-toast-clear
    >
      <p className={`mnid-account-line${working ? ' mnid-account-line-busy' : ''}`} role="status">
        {working ? (
          <Loader2 className="mnid-spin" size={16} aria-hidden="true" />
        ) : failed ? (
          <TriangleAlert className="mnid-account-icon-attention" size={16} aria-hidden="true" />
        ) : (
          <CheckCircle2 className="mnid-account-icon-ready" size={16} aria-hidden="true" />
        )}
        <span>
          {working
            ? PHASE_LABELS[phase ?? 'deploying']
            : failed
              ? 'Your account needs attention'
              : 'Your account is ready'}
        </span>
      </p>

      {/* The reason it failed, because "needs attention" without one is not an
          explanation. It is the record's own sentence, unedited. */}
      {failed ? <p className="mnid-reason">{record.failureReason}</p> : null}

      {showRetry ? (
        <div className="mnid-panel-actions mnid-register-row">
          <button
            type="button"
            className="mnid-register"
            onClick={onRetry}
            disabled={Boolean(disabledReason || !onRetry)}
          >
            <ShieldCheck size={14} aria-hidden="true" />
            Try setting up again
          </button>
          {disabledReason ? (
            <p className="mnid-reason mnid-register-reason">{disabledReason}</p>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}
