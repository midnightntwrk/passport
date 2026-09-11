import { AlertTriangle, ArrowRight, Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { formatElapsed, stepTimingLine } from '../lib/claimSteps.js'
import ThemeToggle from './ThemeToggle.js'
import './identity.css'
import './upgrade.css'

/**
 * "Your Passport is being upgraded" — the screen a pre-upgrade Passport sees
 * once, while it moves onto the account build that can send in one transaction.
 *
 * WHY IT LOOKS EXACTLY LIKE THE NAME STEP
 * ---------------------------------------
 * Because it is the same promise being kept a second time. A reviewer watching
 * a spinner on 2026/08/26 could not tell a slow network from a hung app — "no
 * infinite spinner… let the user know this will take time" — and what was
 * promised in reply, the same afternoon, was three steps, circle and line, the
 * finished ones ticked and the one running now alive, with the seconds counting
 * against what each usually takes. That is `../lib/claimSteps.ts` and the
 * stepper in `./AliasClaim.tsx`, and this screen reuses both: the same markup,
 * the same classes, the same clock. An upgrade is LONGER than a claim, which
 * makes the argument for it stronger rather than weaker.
 *
 * WHAT IT SAYS, AND WHAT IT DOES NOT
 * ----------------------------------
 * Six machine steps (`../identity/accountUpgrade.ts`) fold into three a person
 * can hold, by the rule `claimSteps.ts` states for the claim: a step boundary
 * goes where the reader's situation changes, not where the code's does. Nobody
 * can act on the difference between a withdrawal and a deposit, so both are
 * "your things"; nobody can act on the difference between deploying and
 * confirming, so both are "the new one".
 *
 * NOTHING SPENDABLE IS ON THIS SCREEN. No balance, no send, no name to copy,
 * no transaction to open. For the minutes an upgrade takes, what the Passport
 * holds is in motion — some of it out of the old account, some of it not back
 * in the new one yet — and any figure shown would be a number that is true of
 * neither. The host must not render Home beneath or beside this; see the props.
 *
 * THE WAY BACK. A stopped upgrade is not a lost Passport: nothing has been
 * destroyed, every step that landed is written down, and the next attempt picks
 * up from there. So a failure grows two controls — try again, and leave it for
 * now — and the copy says the true thing rather than an apology.
 */

/** Which of the three rows a reader is on. */
export type UpgradeStepState = 'done' | 'active' | 'todo'

/**
 * The machine's own step, as `../identity/accountUpgrade.ts` reports it.
 *
 * Restated here rather than imported so this screen — which is on the render
 * path of a Passport that has just signed in — does not import a module that
 * reaches the chain. It is one string union and it is checked by the mapping
 * below: a step the machine adds and this file does not know about would fail
 * to typecheck at `STEP_OF_PHASE`.
 */
export type UpgradeMachineStep = 'detect' | 'drain' | 'deploy' | 'repoint' | 'refund' | 'switch'

export interface UpgradeStep {
  /** Stable identity, for React keys and for tests. */
  id: 'check' | 'move' | 'finish'
  /** What the row says. Sentence case, no ellipsis — it is a step, not a status. */
  label: string
  state: UpgradeStepState
  /**
   * How long this step usually takes, in seconds.
   *
   * ESTIMATES, and deliberately generous ones. Nothing here has been measured
   * end to end — an upgrade needs a funded pre-upgrade Passport with its
   * passkey secret, which only a real device has — so these are built from
   * what the parts cost: a sponsored account call runs 35–40 s on stagenet
   * (the drill's own table), the first step is one or two of them, the second
   * is a deploy plus its confirmation, and the third is a name update and one
   * or two deposits. Over-stating an estimate costs a reader nothing;
   * understating one turns the normal case into an alarm, which is the rule
   * `claimSteps.ts` records and the reason these are rounded up.
   */
  expectedSeconds: number
}

/** The three steps, in order. Exported so a screen cannot invent a fourth. */
export const UPGRADE_STEPS: readonly Omit<UpgradeStep, 'state'>[] = [
  { id: 'check', label: 'Checking your Passport', expectedSeconds: 60 },
  { id: 'move', label: 'Setting up your new Passport', expectedSeconds: 120 },
  { id: 'finish', label: 'Putting everything back', expectedSeconds: 150 },
]

/** Which of the three each machine step belongs to. */
const STEP_OF_PHASE: Record<UpgradeMachineStep, 0 | 1 | 2> = {
  /* Reading which Passport this is, and then moving what it holds somewhere
     safe. One step, because the reader is waiting through one thing: their
     Passport being got ready. */
  detect: 0,
  drain: 0,
  deploy: 1,
  /* The name, the value, and the swap are one wait too — the reader has
     nothing to do through any of them, and the rows beneath say which is
     running. */
  repoint: 2,
  refund: 2,
  switch: 2,
}

/** The three steps with the state each one is in for `step`. */
export function upgradeSteps(step: UpgradeMachineStep): UpgradeStep[] {
  const active = STEP_OF_PHASE[step]
  return UPGRADE_STEPS.map((row, index) => ({
    ...row,
    state: index < active ? 'done' : index === active ? 'active' : 'todo',
  }))
}

/** Stable identity for one of the three states the last step passes through. */
export type UpgradeSubStageId = 'name' | 'value' | 'swap'

export interface UpgradeSubStage {
  id: UpgradeSubStageId
  label: string
  state: UpgradeStepState
}

/** The machine steps the last row is made of, in the order it runs them. */
const FINISH_PHASES = ['repoint', 'refund', 'switch'] as const

/**
 * The three sub-states of the last step, with the one running now.
 *
 * NOT three more circles — a person cannot act on the difference between them,
 * which is why the stepper folds them into one step. What they are is the
 * answer to "is anything actually happening", which two minutes of one
 * unchanging sentence cannot give. They are returned for EVERY step, all three
 * `todo` before the last one is reached, because a row fills in — it never
 * appears under the reader mid-wait.
 */
export function upgradeSubStages(
  step: UpgradeMachineStep,
  name?: string | null,
): UpgradeSubStage[] {
  const active = (FINISH_PHASES as readonly string[]).indexOf(step)
  const labels: readonly { id: UpgradeSubStageId; label: string }[] = [
    { id: 'name', label: name ? `Moving ${name} across` : 'Moving your name across' },
    { id: 'value', label: 'Returning what you hold' },
    { id: 'swap', label: 'Switching you over' },
  ]
  return labels.map((stage, index) => ({
    ...stage,
    state: index < active ? 'done' : index === active ? 'active' : 'todo',
  }))
}

/**
 * The one line beneath the three steps, for the whole of the wait.
 *
 * It says the two things a person needs and nothing else: their Passport is
 * safe, and this happens once. Both are true — nothing is destroyed at any
 * point, every step that lands is written down, and an upgraded Passport never
 * comes back here.
 */
export const UPGRADE_NOTE =
  'Nothing is lost if you close this — it carries on from where it stopped. This happens once.'

export interface UpgradeProps {
  /**
   * The `.night` name being carried across, in its display form
   * (`alice.night`), or null for a Passport that holds none.
   */
  name: string | null
  /**
   * The machine step running now, or null before the first attempt starts.
   *
   * Null renders the three rows with the first one active, which is what the
   * frame before the first phase arrives should look like — a stepper that
   * appeared a second late would be a screen that flickered.
   */
  step: UpgradeMachineStep | null
  /** True while an attempt is running. */
  busy: boolean
  /**
   * The sentence to show when an attempt STOPPED, or null.
   *
   * `AccountUpgradeError.message` is written for this line — it says what the
   * reader was waiting for and what they can do, never which part of the
   * machinery did not start. The `detail` on that error is for the console.
   */
  error?: string | null
  /** Runs the upgrade, or runs it again. Resumes; it never starts over. */
  onRetry: () => void
  /**
   * Leaves this screen with the upgrade unfinished, or undefined where the host
   * offers no way out.
   *
   * The Passport is still on its old account at that point and still works —
   * it sends in two transactions, which is what it did yesterday. This is
   * offered only alongside {@link error}, because leaving mid-attempt would
   * abandon a transaction that is in the air.
   */
  onLeave?: () => void
}

export default function UpgradeScreen({
  name,
  step,
  busy,
  error,
  onRetry,
  onLeave,
}: UpgradeProps) {
  const steps = upgradeSteps(step ?? 'detect')
  const running = steps.find((row) => row.state === 'active') ?? null

  /**
   * When each step started, and the clock that counts against it.
   *
   * The same shape `./AliasClaim.tsx` keeps: a timestamp per step id, stamped
   * the first time that step is seen running, and a one-second tick while
   * anything is running. The tick stops when nothing is, so a stopped upgrade
   * does not sit there counting at a reader who is deciding what to do.
   */
  const startedAt = useRef<Partial<Record<UpgradeStep['id'], number>>>({})
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    if (startedAt.current[running.id] === undefined) {
      startedAt.current[running.id] = Date.now()
    }
  }, [running])
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000)
    return () => window.clearInterval(timer)
  }, [busy])

  const elapsedFor = (row: UpgradeStep): number | null => {
    const began = startedAt.current[row.id]
    if (began === undefined) return null
    return Date.now() - began
  }

  return (
    <section className="mnid-screen mnup-screen" aria-busy={busy}>
      <header className="mnid-bar">
        <img className="mnid-wordmark" src="/midnight-wordmark.svg" alt="Midnight" />
        <span className="mnid-step">One-off</span>
        <ThemeToggle size="sm" className="mnid-theme" />
      </header>

      <div className="mnid-body">
        <p className="mnid-kicker">Your Passport</p>
        <h1 className="mnid-title">Your Passport is being upgraded</h1>
        <p className="mnid-lede">
          {name ? (
            <>
              {name} is moving to a newer Passport that can pay in a single step. Everything you
              hold moves with it, and the name stays yours.
            </>
          ) : (
            <>
              Your Passport is moving to a newer one that can pay in a single step. Everything you
              hold moves with it.
            </>
          )}
        </p>

        {/* WHERE IT HAS GOT TO. The claim screen's stepper, class for class, so
            the two waits in this app look like one thing to a reader who has
            already sat through the other. */}
        <div className="mnid-panel" role="status" aria-live="polite">
          <ol className="mnid-stepper">
            {steps.map((row) => {
              const elapsed = elapsedFor(row)
              /* A running step says what it usually costs and what it has cost
                 so far; a finished one says what it took, measured rather than
                 estimated. A step that finished inside a second says nothing —
                 "Took 0:00" is a number about nothing, and a ticked row is
                 already the whole of what happened. */
              const timing =
                elapsed === null
                  ? null
                  : row.state === 'active'
                    ? busy
                      ? stepTimingLine(row, elapsed)
                      : null
                    : elapsed >= 1_000
                      ? `Took ${formatElapsed(elapsed)}`
                      : null
              return (
                <li key={row.id} className="mnid-stepper-item" data-state={row.state}>
                  {/* Both marks are always in the DOM and the state chooses
                      which is painted, so a step never changes shape as it
                      completes — it only fills in. */}
                  <span className="mnid-stepper-mark" aria-hidden="true">
                    <span className="mnid-stepper-dot" />
                    <Check className="mnid-stepper-check" size={13} strokeWidth={3} />
                  </span>
                  <span className="mnid-stepper-text">
                    <span className="mnid-stepper-label">{row.label}</span>
                    {timing !== null ? (
                      /* `aria-live="off"`: the panel around it is polite, and a
                         value that changes every second would otherwise be read
                         aloud every second. The number is for the eye. */
                      <span className="mnid-stepper-timing" aria-live="off">
                        {timing}
                      </span>
                    ) : null}
                    {row.id === 'finish' ? (
                      <ol className="mnid-substages">
                        {upgradeSubStages(step ?? 'detect', name).map((stage) => (
                          <li key={stage.id} className="mnid-substage" data-state={stage.state}>
                            <span className="mnid-substage-pip" aria-hidden="true" />
                            <span className="mnid-substage-label">{stage.label}</span>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    {row.id === 'finish' ? (
                      <span className="mnid-stepper-note">{UPGRADE_NOTE}</span>
                    ) : null}
                  </span>
                </li>
              )
            })}
          </ol>
        </div>

        {/* THE WAY BACK, and it only exists when something stopped. Mid-attempt
            there is a transaction in the air and no control here could recall
            it; the honest screen in that moment is the one above. */}
        {error && !busy ? (
          <div className="mnup-stopped" role="alert">
            <p className="mnup-stopped-head">
              <AlertTriangle size={15} aria-hidden="true" />
              This did not finish
            </p>
            <p className="mnup-stopped-body">{error}</p>
            <p className="mnup-stopped-foot">
              Your Passport is safe and still works. Picking this up again carries on from where it
              stopped rather than starting over.
            </p>
          </div>
        ) : null}

        <div className="mnid-actions" data-toast-clear>
          <button type="button" className="mnid-primary" onClick={onRetry} disabled={busy}>
            {/* NO SPINNER while the stepper is up: a second moving thing over a
                view whose whole job is to show where this has got to adds
                movement and no information. */}
            {busy ? null : <ArrowRight size={17} aria-hidden="true" />}
            {busy ? 'Upgrading your Passport…' : error ? 'Try again' : 'Upgrade my Passport'}
          </button>
          {onLeave && error && !busy ? (
            <button type="button" className="mnid-alt" onClick={onLeave}>
              Not now — I’ll do this later
            </button>
          ) : null}
        </div>
      </div>
    </section>
  )
}
