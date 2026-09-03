import {
  ArrowRight,
  Check,
  CircleSlash,
  Gamepad2,
  Home,
  Loader2,
  RotateCcw,
  Sparkles,
  Wifi,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

/* `../identity/midnamesText.js`, NOT `../identity/midnames.js`. This screen is
   on the first render path, and `midnames.ts` top-level awaits a 9.84 MB ledger
   WASM through `contractRuntime.ts` — importing a value from it here held
   React's mount behind that fetch. The registry itself is reached the way
   `App.tsx` has always reached it: a dynamic import at the moment of the claim. */
import {
  aliasDomain,
  normalizePassportAlias,
  type AliasAvailability,
  type AliasClaimProgress,
} from '../identity/midnamesText.js'
import { claimFailureCard } from '../lib/claimFailure.js'
import {
  claimSteps,
  claimSubStages,
  feeWaitLine,
  feeWaitState,
  formatElapsed,
  stepTimingLine,
  subscribeFeeWait,
  type ClaimStep,
  type FeeWait,
} from '../lib/claimSteps.js'
import { OFFER_AFTER_MS } from '../lib/waitingGame.js'
import { NETWORK_LABELS, type PassportNetwork } from './NetworkSwitcher.js'
import { PasskeyWayOutActions } from './PasskeyWayOut.js'
import WaitingGame from './WaitingGame.js'
import ThemeToggle from './ThemeToggle.js'
import './identity.css'

/**
 * Alias claiming — since 2026/08/06 the LAST onboarding screen before the
 * dashboard, and the default path rather than a detour. Claiming or skipping
 * both land on Home.
 *
 * A Passport alias IS a Midnames `.night` name, so everything on this
 * screen is a statement about the real registry:
 *
 *   - availability is `domains.member()` on the deployed `.night` TLD, probed
 *     live as the user types (debounced);
 *   - claiming deploys the account-custody contract if this Passport has none,
 *     then registers the name against it, and the transaction ids that come
 *     back are real.
 *
 * NO PRICE, AND NO BALANCE (2026/08/25). The registry's COST is paid by the
 * Passport service, from its own NIGHT — the user's wallet pays for nothing and
 * originates exactly one transaction in its life, the account deploy. So this
 * screen shows no price, reads no balance, and has no faucet link and no
 * not-enough-NIGHT panel: none of them describe anything that can happen here.
 *
 * When the registry cannot be reached, or Passport cannot register on the
 * network being shown, the screen says exactly that and offers to QUEUE the
 * name. A queued name is never shown as registered.
 */

const DEBOUNCE_MS = 500

export interface AliasClaimProps {
  /** Which network the name is being claimed on. */
  networkId: PassportNetwork
  /** False while the wallet is still opening — claiming needs it. */
  walletReady: boolean
  /**
   * Whether Passport can genuinely register on `networkId` — that is, whether
   * the open wallet signs and submits there. False turns the screen into an
   * honest queue: the copy says so, and the button reads "Queue name". Additive
   * to the contract's prop list, because a wrong "this is a real registration"
   * sentence would be exactly the kind of claim this work is meant to remove.
   */
  registrationSupported: boolean
  /**
   * Human label for the network Passport's wallet DOES sign on, used in the
   * queue copy. Passed in rather than derived here so one sentence about where
   * names land cannot drift from the one the Home card shows.
   */
  signingNetworkLabel: string
  checkAvailability: (alias: string) => Promise<AliasAvailability>
  /** Runs the REAL claim. Rejects with a message the caller has already shown. */
  onClaim: (alias: string) => Promise<void>
  /**
   * Records the name as queued, with the reason it is queued. Additive to the
   * contract's prop list: criterion 4 needs a queue action distinct from skip,
   * and the honest panels below all end in one.
   */
  onQueue: (alias: string, reason: string) => Promise<void>
  onSkip: () => void
  /**
   * Leaves the name step for Home, with the name still queued.
   *
   * NOT a skip, though the host runs the same handler for both: a claim that
   * failed has already persisted its name as queued, so Home is where that
   * name is waiting with its own "Register now" beside it. This is the
   * SECOND control on the failure card — the one that turns a refusal into a
   * destination — and it is a separate prop from {@link AliasClaimProps.onSkip}
   * because that one is the host's escape hatch for a network Passport cannot
   * register on, and the two must stay legible as different offers.
   */
  onContinueHome: () => void
  claimPhase: AliasClaimProgress['phase'] | null
  error: string | null
  /**
   * True when {@link AliasClaimProps.error} is a PASSKEY ceremony that could
   * not be completed, rather than anything about the name or the registry.
   *
   * It changes what the failure card carries, not what it says: the sentence
   * is still the host's, and beneath it go the two controls
   * {@link PasskeyWayOutActions} defines. The host decides, because only the
   * host saw the failure — see `lib/passkeyRecovery.ts` for the rule.
   *
   * This screen is the one that needed it most. Its header is the wordmark,
   * "Last step", and the theme toggle: there is NO sign-out on it, so before
   * this a user whose passkey the browser could not use read one line of error
   * text and had nowhere at all to go (reported with a screenshot,
   * 2026/08/31).
   */
  errorIsPasskeyWayOut?: boolean
  /**
   * Leaves the session for the landing screen. Required for the way out above
   * to be offered at all — a panel that named a control this screen could not
   * perform would be the same dead end with more words on it.
   */
  onSignOut?: () => void
  /**
   * Whether the Passport service will genuinely REGISTER this name — its own
   * `/status` reporting `aliasSponsorship: "available"` on this network, read
   * by the host and never assumed here.
   *
   * `undefined` (the default) and `false` keep the honest baseline: the name is
   * kept and registered when the service is back. Only a `true` the probe
   * actually produced may promise a registration, because the service is the
   * only thing that can make one — the wallet pays for nothing and there is no
   * self-paid claim behind this screen.
   *
   * Even a `true` is a prediction. A service can run out of NIGHT between the
   * probe and the call, and when it does the claim ends with the name queued
   * and the service's own sentence on the card — which is why nothing on this
   * screen reports a registration before one has happened.
   */
  nameSponsored?: boolean
}

type FieldState =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'checking'; alias: string }
  | { kind: 'answered'; alias: string; availability: AliasAvailability }

/**
 * What the button says at each stage, and why there are now seven of them.
 *
 * A reviewer clicked claim on the live site and watched one unchanging
 * sentence — "Deploying your name's resolver…" — for the whole stretch before
 * the passkey prompt appeared, which is a sentence about a step that had not
 * started yet. Three stages happen before that prompt (the registry re-check,
 * the sponsor's answer, and the ceremony), and each now says what it is.
 *
 * The account-contract stage says "Setting up your account". It used to name
 * the contract being deployed; that is the machinery, and a person waiting on
 * their Passport is owed the thing it is FOR.
 *
 * The stage after it now says "Setting your name up…" for the same reason, and
 * in the same words `Ecosystem.tsx` already used for that phase. The sentence
 * it replaces — "Deploying your name's resolver…" — survived the 2026/08/26
 * pass because the pass renamed the phases around it, and it was still on the
 * live site during a real claim: "resolver" is a thing inside the registry,
 * not a thing that is happening to the reader.
 */
const PHASE_COPY: Record<AliasClaimProgress['phase'], (domain: string) => string> = {
  checking: (domain) => `Checking ${domain} is still free…`,
  preparing: () => 'Preparing your Passport…',
  'confirm-passkey': () => 'Confirm with your passkey',
  'attaching-account': () => 'Setting up your account…',
  'deploying-resolver': () => 'Setting your name up…',
  registering: (domain) => `Registering ${domain}…`,
  confirming: () => 'Confirming your name…',
}

/**
 * What the third step says underneath itself, from the moment the claim
 * starts rather than when the wait begins.
 *
 * The reviewer's ask on 2026/08/26 was "your passport is on its way, please be
 * patient… you have to let the user know this will take time" — and a warning
 * about a wait is worth most before it starts. It names no transaction count:
 * how many proofs are involved is machinery, and "a few minutes" is the whole
 * of what a person can act on.
 */
const LONG_WAIT_NOTE = 'Your Passport is on its way. This part takes a few minutes.'

/**
 * The claim's clock: which step is being timed, when it started, and what the
 * time is now.
 *
 * `now` is state rather than a read at render time because a step whose phase
 * does not change would otherwise never re-render, and a counter that stops
 * moving is exactly the hang this whole view exists to disprove. It ticks once
 * a second from an interval that is cleared when the step changes, when the
 * claim ends, and when the screen unmounts.
 *
 * `done` keeps what each finished step actually cost, so a ticked row can say
 * so. It is measured, never estimated: a step that took eleven seconds against
 * an estimate of ten says eleven.
 */
interface ClaimClock {
  stepId: ClaimStep['id']
  startedAt: number
  now: number
  done: Partial<Record<ClaimStep['id'], number>>
}

export default function AliasClaimScreen(props: AliasClaimProps) {
  const {
    networkId,
    walletReady,
    registrationSupported,
    signingNetworkLabel,
    checkAvailability,
    onClaim,
    onQueue,
    onSkip,
    onContinueHome,
    claimPhase,
    error,
    errorIsPasskeyWayOut,
    onSignOut,
    nameSponsored,
  } = props

  const [value, setValue] = useState('')
  const [field, setField] = useState<FieldState>({ kind: 'empty' })
  const probe = useRef(0)

  const busy = claimPhase !== null

  useEffect(() => {
    const raw = value.trim()
    if (!raw) {
      setField({ kind: 'empty' })
      return undefined
    }
    let alias: string
    try {
      alias = normalizePassportAlias(raw)
    } catch (cause) {
      setField({ kind: 'invalid', message: cause instanceof Error ? cause.message : String(cause) })
      return undefined
    }
    setField({ kind: 'checking', alias })
    const token = probe.current + 1
    probe.current = token
    const timer = window.setTimeout(() => {
      void checkAvailability(alias).then(
        (availability) => {
          if (probe.current !== token) return
          setField({ kind: 'answered', alias, availability })
        },
        (cause: unknown) => {
          if (probe.current !== token) return
          setField({
            kind: 'answered',
            alias,
            availability: {
              status: 'unreachable',
              detail: cause instanceof Error ? cause.message : String(cause),
            },
          })
        },
      )
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [checkAvailability, value])

  const alias = field.kind === 'checking' || field.kind === 'answered' ? field.alias : null
  /** `alice.night`, or nothing at all — never `your name.night`. */
  const claimDomain = alias === null ? null : aliasDomain(alias)
  const availability = field.kind === 'answered' ? field.availability : null
  const isAvailable = availability?.status === 'available'
  const isUnreachable = availability?.status === 'unreachable'

  /**
   * What the panel promises, and it is the whole of what a claim does: the
   * service registers the name and pays for it. There is no balance to check
   * and no shortfall to warn about — the wallet pays for nothing, so an empty
   * one is not a wall in front of this screen and never was the user's problem.
   * With no sponsor the claim QUEUES; the host says so, and this screen simply
   * does not promise a registration nobody is going to make.
   */
  const sponsorRegisters = registrationSupported && isAvailable && nameSponsored === true

  const queueReasonForNetwork = `Passport signs and submits on ${signingNetworkLabel} only, so this name is reserved for you locally but is NOT registered on ${NETWORK_LABELS[networkId]}.`
  const queueReasonForRegistry = isUnreachable
    ? `Passport could not check names on ${NETWORK_LABELS[networkId]} when this one was chosen: ${
        availability?.status === 'unreachable' ? availability.detail : 'no detail reported'
      }`
    : ''

  const handleSubmit = useCallback(() => {
    if (!alias || busy) return
    if (isUnreachable) {
      void onQueue(alias, queueReasonForRegistry)
      return
    }
    if (!registrationSupported) {
      void onQueue(alias, queueReasonForNetwork)
      return
    }
    void onClaim(alias)
  }, [
    alias,
    busy,
    isUnreachable,
    onClaim,
    onQueue,
    queueReasonForNetwork,
    queueReasonForRegistry,
    registrationSupported,
  ])

  /* The three steps for the phase being reported, and the one that is
     running now. Computed once: the panel below paints them, the button names
     the running one, and the clock is keyed on its identity. */
  const steps = busy && claimPhase !== null ? claimSteps(claimPhase) : null
  const runningStep = steps?.find((step) => step.state === 'active') ?? null

  /* ---------------------------------------------------------------- */
  /* THE CLOCK (2026/08/31)                                             */
  /*                                                                    */
  /* "With a timer — this is how much it is supposed to take, and it's  */
  /* almost done — so I'm more in touch with the progress." Three steps */
  /* said WHERE the claim was and nothing about how long, and a wait    */
  /* with no measure against it is indistinguishable from a hang after  */
  /* about twenty seconds.                                              */
  /*                                                                    */
  /* The estimates live in `../lib/claimSteps.ts` with the copy built   */
  /* from them; what lives here is the measuring. The interval is keyed */
  /* on the RUNNING STEP, so it is cleared and restarted when the step  */
  /* changes, cleared when the claim ends or fails, and cleared on      */
  /* unmount — and, crucially, it is NOT keyed on the phase: the four   */
  /* phases of the account step share one clock, and a phase that sits  */
  /* still for two minutes goes on counting rather than looking stuck.  */
  /* ---------------------------------------------------------------- */
  const activeStepId = runningStep?.id ?? null
  const [clock, setClock] = useState<ClaimClock | null>(null)

  useEffect(() => {
    if (activeStepId === null) {
      // The claim ended, one way or the other. The next one starts from zero.
      setClock(null)
      return undefined
    }
    const at = Date.now()
    setClock((previous) => {
      if (previous === null) return { stepId: activeStepId, startedAt: at, now: at, done: {} }
      // An unchanged step keeps its start time, so the count never resets.
      if (previous.stepId === activeStepId) return previous
      return {
        stepId: activeStepId,
        startedAt: at,
        now: at,
        done: { ...previous.done, [previous.stepId]: at - previous.startedAt },
      }
    })
    const timer = window.setInterval(() => {
      setClock((previous) => (previous === null ? previous : { ...previous, now: Date.now() }))
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [activeStepId])

  /* ---------------------------------------------------------------- */
  /* THE OFFER OF SOMETHING TO DO (2026/09/03)                          */
  /*                                                                    */
  /* "An embedded game while you're waiting, like the Chrome dinosaur." */
  /* The stepper is what makes a two-minute wait legible; this is for   */
  /* the two minutes themselves.                                        */
  /*                                                                    */
  /* It is OFFERED, never started: a control appears once the claim has */
  /* been running for {@link OFFER_AFTER_MS}, and nothing is on screen  */
  /* until it is pressed. Most claims never reach that mark, and an     */
  /* offer of a distraction from a wait that is about to end is itself  */
  /* the distraction.                                                   */
  /*                                                                    */
  /* Three rules keep it subordinate to the claim, and they are the     */
  /* whole of what this state is for. It sits BENEATH the stepper in    */
  /* normal flow, so it covers nothing. It is taken off screen — and    */
  /* the loop stopped — the moment the passkey step is the running one, */
  /* because that is the one moment the claim needs the reader's hand,  */
  /* and it comes back afterwards where it left off rather than         */
  /* starting again. And it can be shut, for the rest of this claim.    */
  /* ---------------------------------------------------------------- */
  const [waitedMs, setWaitedMs] = useState(0)
  const [gameOpen, setGameOpen] = useState(false)
  const [gameDismissed, setGameDismissed] = useState(false)

  useEffect(() => {
    if (!busy) {
      // The claim ended, one way or the other. The next one is offered afresh.
      setWaitedMs(0)
      setGameOpen(false)
      setGameDismissed(false)
      return undefined
    }
    const startedAt = Date.now()
    const timer = window.setInterval(() => setWaitedMs(Date.now() - startedAt), 1_000)
    return () => window.clearInterval(timer)
  }, [busy])

  /* The passkey prompt is a browser dialogue over this screen, and the game
     goes away for it rather than competing with it. */
  const passkeyPromptUp = claimPhase === 'confirm-passkey'
  const offerGame = busy && waitedMs >= OFFER_AFTER_MS && !gameDismissed

  /* ---------------------------------------------------------------- */
  /* THE SPONSOR WAIT (2026/09/02)                                      */
  /*                                                                    */
  /* The fee gate no longer refuses a claim because the sponsor said    */
  /* `available: 0` at one instant — it waits up to three minutes for   */
  /* the sponsor's own DUST to come back, which on the deployed         */
  /* balancer takes two to four. See                                    */
  /* `../identity/passportContract.ts#checkPassportContractFunds` for   */
  /* the measurement and the rule.                                      */
  /*                                                                    */
  /* A wait nobody is told about is a hang, and this one lands inside   */
  /* the longest step of the claim — so it says what it is waiting on   */
  /* and counts, in the same grammar as every other line in the         */
  /* stepper. The value is published by `../lib/claimSteps.ts` rather   */
  /* than by the fee gate itself, because importing the fee gate here   */
  /* would put the 9.84 MB ledger WASM in front of React's mount.       */
  /* ---------------------------------------------------------------- */
  const [feeWait, setFeeWait] = useState<FeeWait>(feeWaitState)
  useEffect(() => subscribeFeeWait(setFeeWait), [])

  const [feeWaitNow, setFeeWaitNow] = useState(() => Date.now())
  useEffect(() => {
    if (!feeWait.waiting) return undefined
    setFeeWaitNow(Date.now())
    const timer = window.setInterval(() => setFeeWaitNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [feeWait.waiting])

  /* Shown only while a claim is on screen: the same wait can be entered by
     the Home card's own retry, which this screen is not mounted for, and a
     line about a claim that is not running would have nothing to sit under. */
  const feeWaitText =
    busy && feeWait.waiting && feeWait.since !== null
      ? feeWaitLine(feeWaitNow - feeWait.since)
      : null

  /** How long the step being timed has been running, in milliseconds. */
  const elapsedFor = (step: ClaimStep): number | null => {
    if (clock === null) return null
    if (step.state === 'active') {
      return clock.stepId === step.id ? clock.now - clock.startedAt : null
    }
    return clock.done[step.id] ?? null
  }

  /**
   * What the button says while a claim runs, and why it is no longer the
   * phase's own sentence.
   *
   * It used to repeat, with a spinner beside it, exactly the sentence already
   * printed under the running step: two spinners' worth of movement and one
   * fact, said twice. The STEPPER is the progress indicator now — it shows
   * which of the three is running, what that step is doing, and what is still
   * ahead — so the button says only which step is running, and says it once.
   *
   * `busy` is `claimPhase !== null`, so wherever this branch is taken the
   * stepper above is on screen and there is always an active step to name.
   */
  const primaryLabel = busy
    ? (runningStep?.label ?? PHASE_COPY[claimPhase](claimDomain ?? 'your name'))
    : isUnreachable || !registrationSupported
      ? 'Queue name'
      : alias
        ? `Claim ${aliasDomain(alias)}`
        : 'Claim your name'

  const primaryDisabled =
    busy ||
    !walletReady ||
    alias === null ||
    availability === null ||
    availability.status === 'taken'

  /* WHAT THE FAILURE CARD CARRIES, decided in `../lib/claimFailure.ts` rather
     than by the shape of the JSX below. The card used to be furnished for
     exactly one failure — the passkey one — and bare for every other, which is
     how a claim refused by the service after the account was already live
     ended on a panel with nothing on it (live acceptance, 2026/09/02). The
     rule is one answer for all of them, so a card with no controls is not a
     state this screen can be in. */
  const failure = claimFailureCard({
    error,
    passkeyWayOut: errorIsPasskeyWayOut === true,
    canSignOut: onSignOut !== undefined,
    alias,
    busy,
  })

  return (
    <section className="mnid-screen" aria-busy={busy}>
      <header className="mnid-bar">
        <img className="mnid-wordmark" src="/midnight-wordmark.svg" alt="Midnight" />
        {/* No step counter since 2026/08/06: the name is the LAST thing
            before the dashboard, not step 2 of a three-screen wizard. */}
        <span className="mnid-step">Last step</span>
        <ThemeToggle size="sm" className="mnid-theme" />
      </header>

      <div className="mnid-body">
        <p className="mnid-kicker">Your Midnight name</p>
        <h1 className="mnid-title">Choose your .night name</h1>
        <p className="mnid-lede">
          {registrationSupported ? (
            <>
              This is the name people send to and apps recognise you by. It is a real Midnames
              registration on {NETWORK_LABELS[networkId]} — one name per network, held by this
              passkey.
            </>
          ) : (
            <>
              This is the name people send to and apps recognise you by. Passport signs and
              submits on {signingNetworkLabel} only, so a name chosen for{' '}
              {NETWORK_LABELS[networkId]} is queued here rather than registered — and Passport says
              so wherever it appears.
            </>
          )}
        </p>

        <div
          className={`mnid-field${field.kind === 'invalid' ? ' mnid-field-invalid' : ''}`}
        >
          <input
            type="text"
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="yourname"
            aria-label="Your Midnight name"
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !primaryDisabled) handleSubmit()
            }}
          />
          <span className="mnid-suffix">.night</span>
        </div>

        <AvailabilityLine field={field} networkId={networkId} />

        {/* WHILE IT RUNS, SHOW WHERE IT IS. What stood here was a spinner and
            one sentence, and a reviewer on 2026/08/26 could not tell a slow
            network from a hung app: "no infinite spinner". What was promised
            in reply, the same afternoon, was this — three steps, circle and
            line, the finished ones ticked and the one running now alive.

            The seven phases the claim reports are folded into the three by
            `../lib/claimSteps.ts`, which is where that rule lives and is
            drilled. The phase's own words are still said — beneath the running
            step for the two short ones, and as the four filling rows beneath
            the long one, which are sub-states of setting the account up rather
            than four more circles.

            Since 2026/08/31 each row also carries TIME: what the step usually
            costs, and what it has cost so far. That was the second half of the
            same complaint — "with a timer… so I'm more in touch with the
            progress" — and it is the half a stepper alone cannot answer, since
            a step can be correct about where a claim is and still look hung. */}
        {steps !== null && claimPhase !== null ? (
          <div className="mnid-panel" role="status" aria-live="polite">
            <ol className="mnid-stepper">
              {steps.map((step) => {
                const elapsed = elapsedFor(step)
                /* The phase's own sentence, for the two steps that are ONE
                   thing. The third is four things and says so beneath itself
                   instead — a single line that read "Setting up your account…"
                   for two minutes under a step already labelled "Setting up
                   your account" was the whole of what the third step told you.
                   A sentence identical to its own label is dropped rather than
                   printed twice, which is what the passkey step used to do. */
                const detail =
                  step.state === 'active' && step.id !== 'account'
                    ? PHASE_COPY[claimPhase](claimDomain ?? 'your name')
                    : null
                /* WHAT THE ROW SAYS ABOUT TIME. A running step says what it
                   usually costs and what it has cost so far; a finished one
                   says what it took, measured rather than estimated. A step
                   that finished inside a second says nothing at all: "Took
                   0:00" is a number about nothing, and a ticked row is already
                   the whole of what happened. */
                const timing =
                  elapsed === null
                    ? null
                    : step.state === 'active'
                      ? stepTimingLine(step, elapsed)
                      : elapsed >= 1_000
                        ? `Took ${formatElapsed(elapsed)}`
                        : null
                return (
                  <li key={step.id} className="mnid-stepper-item" data-state={step.state}>
                    {/* Both marks are always in the DOM and the state chooses
                        which is painted, so a step never changes shape as it
                        completes — it only fills in. */}
                    <span className="mnid-stepper-mark" aria-hidden="true">
                      <span className="mnid-stepper-dot" />
                      <Check className="mnid-stepper-check" size={13} strokeWidth={3} />
                    </span>
                    <span className="mnid-stepper-text">
                      <span className="mnid-stepper-label">{step.label}</span>
                      {detail !== null && detail !== step.label ? (
                        <span className="mnid-stepper-detail">{detail}</span>
                      ) : null}
                      {/* THE TIMER. `aria-live="off"` because the panel around
                          it is polite and a value that changes every second
                          would otherwise be read aloud every second — the
                          number is for the eye, and the step changes it sits
                          between are what a screen reader is told. */}
                      {timing !== null ? (
                        <span className="mnid-stepper-timing" aria-live="off">
                          {timing}
                        </span>
                      ) : null}
                      {/* WHAT THE CLAIM IS ACTUALLY HELD ON, when it is held
                          on the fee sponsor. It carries the same class as the
                          note below it — it is the same kind of quiet line —
                          and its own, so a test can name it without also
                          naming the timer, whose text `claim-progress.spec.ts`
                          asserts one of per step. */}
                      {feeWaitText !== null && step.state === 'active' ? (
                        <span className="mnid-stepper-note mnid-stepper-wait" aria-live="off">
                          {feeWaitText}
                        </span>
                      ) : null}
                      {/* The four states of the long wait, on screen from the
                          first frame of the claim so they FILL IN rather than
                          appearing under the reader mid-wait. */}
                      {step.id === 'account' ? (
                        <ol className="mnid-substages">
                          {claimSubStages(claimPhase, claimDomain ?? undefined).map((stage) => (
                            <li key={stage.id} className="mnid-substage" data-state={stage.state}>
                              <span className="mnid-substage-pip" aria-hidden="true" />
                              <span className="mnid-substage-label">{stage.label}</span>
                            </li>
                          ))}
                        </ol>
                      ) : null}
                      {step.id === 'account' ? (
                        <span className="mnid-stepper-note">{LONG_WAIT_NOTE}</span>
                      ) : null}
                    </span>
                  </li>
                )
              })}
            </ol>
          </div>
        ) : null}

        {/* Beneath the stepper, never over it — see the block above. */}
        {steps !== null && offerGame ? (
          gameOpen ? (
            <WaitingGame
              paused={passkeyPromptUp}
              onDismiss={() => {
                setGameOpen(false)
                setGameDismissed(true)
              }}
            />
          ) : passkeyPromptUp ? null : (
            <button
              type="button"
              className="mngame-offer"
              onClick={() => setGameOpen(true)}
            >
              <Gamepad2 size={14} aria-hidden="true" />
              Play while you wait
            </button>
          )
        ) : null}

        {/* The promise, until it is being kept. "Press claim" is advice about a
            button the user has already pressed, so it stands down the moment a
            claim is running and the stepper above says where it has got to. */}
        {sponsorRegisters && !busy ? (
          <div className="mnid-panel" role="status">
            <p className="mnid-panel-head">
              <Sparkles size={15} aria-hidden="true" />
              Registered for you
            </p>
            {/* No price, no grant, no "your account is empty": the service
                registers the name and pays for it, and the user's balance is
                not part of the ceremony. The panel only says what will happen. */}
            <p>
              Press claim and Passport registers {aliasDomain(alias ?? '')} for you — the
              service pays for it, and you hold nothing. It usually takes a minute or two.
            </p>
          </div>
        ) : null}

        {isUnreachable ? (
          <div className="mnid-panel" role="status">
            <p className="mnid-panel-head">
              <Wifi size={15} aria-hidden="true" />
              Names cannot be checked right now
            </p>
            <p>
              Your name will be queued. Passport keeps it against{' '}
              {NETWORK_LABELS[networkId]} and shows it as queued — never as registered — until a
              real registration succeeds.
            </p>
            <code>
              {availability?.status === 'unreachable' ? availability.detail : ''}
            </code>
          </div>
        ) : null}

        {error ? (
          <div className="mnid-panel" role="alert">
            <p className="mnid-panel-head">
              <CircleSlash size={15} aria-hidden="true" />
              {/* PUNCTUATED, because the heading and the sentence beneath it
                  are read as one line by anybody scanning the card and by
                  every screen reader that runs them together: "The claim did
                  not complete alice.night was not registered" was the whole
                  of the first thing a refused claim said. */}
              The claim did not complete.
            </p>
            {/* THE ONE SENTENCE. It names what happened and that the name is
                kept, and it is composed once — `aliasRefusalMessage` in
                `identity/sponsoredAlias.ts`, or the host's own sentence for a
                failure the service never saw. Nothing is added to it here:
                this card carried the "kept" fact three times over until
                2026/09/03, the last copy of it a note describing the two
                buttons immediately below the two buttons. */}
            <p>{error}</p>
            {/* THE CARD THAT HAD NOTHING ON IT.
                A passkey failure here used to end at the line above, on a
                screen with no sign-out anywhere — so the only exits were the
                browser's back button and closing the tab. Both controls go in
                THIS card rather than in a toast: the card is where the user is
                already reading, and a toast that carried the only way out of a
                dead end would take it away again after five seconds.

                Since 2026/09/02 EVERY failure gets a pair, not just the passkey
                one. A name the service refused after the account was already
                live landed on this card with nothing but the sentence — and the
                "Register now" that could have finished the job was on Home,
                which the card never mentioned. "Continue to Home" below is
                that way there, and its label is the whole of the promise. */}
            {/* The passkey pair keeps the SURFACE's own busy flag rather than
                `failure.canRetry`: one flag governs both its controls, and a
                sign-out disabled because the name field happened to be empty
                would be this screen's dead end all over again. Its retry is
                guarded where it lands, in `handleSubmit`. */}
            {failure.way === 'passkey' && onSignOut ? (
              <PasskeyWayOutActions
                onRetry={handleSubmit}
                onSignOut={onSignOut}
                busy={busy}
              />
            ) : null}
            {/* The same two-pill row as the passkey pair, because they are the
                same object in the same card: a claim that did not complete, and
                the two things a person can do about it. The retry runs the claim
                that was pressed — one passkey assertion, exactly as the first
                attempt did — and nothing here is promptless. */}
            {failure.way === 'queued' ? (
              <div className="mnwo-actions">
                <button
                  type="button"
                  className="mnwo-action mnwo-action-primary"
                  onClick={handleSubmit}
                  disabled={!failure.canRetry}
                >
                  <RotateCcw size={15} strokeWidth={2} aria-hidden="true" />
                  Try again
                </button>
                <button
                  type="button"
                  className="mnwo-action"
                  onClick={onContinueHome}
                >
                  <Home size={15} strokeWidth={2} aria-hidden="true" />
                  Continue to Home
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mnid-actions" data-toast-clear>
          <button
            type="button"
            className="mnid-primary"
            onClick={handleSubmit}
            disabled={primaryDisabled}
          >
            {/* NO SPINNER while the stepper is up. A second spinner over a
                view whose whole job is to show where the claim has got to adds
                movement and no information — and it was what made the button
                read as the progress indicator rather than as the control that
                had already been pressed. */}
            {busy ? null : <ArrowRight size={17} aria-hidden="true" />}
            {primaryLabel}
          </button>
          {/* No skip. The name step IS the account ceremony — the custody
              contract deploys and the name binds to it inside this one action,
              and Home without an account is not a state onboarding may end in
              (ruled 2026/08/24 after exactly that was seen live). `onSkip`
              remains for the HOST's escape hatches (network unsupported), not
              as a user choice on this screen. */}
        </div>

        <p className="mnid-foot">
          <Check size={13} aria-hidden="true" />
          <span>
            Names are 1–32 characters: lowercase letters, numbers, and hyphens inside. This is a
            real registration on the network
            {nameSponsored
              ? ', paid for by the Passport service — you hold nothing and spend nothing'
              : '; with no sponsor available right now the name is kept for you and registered when the service is back — nothing is ever spent from your Passport for it'}
            .
          </span>
        </p>
      </div>
    </section>
  )
}

function AvailabilityLine({
  field,
  networkId,
}: {
  field: FieldState
  networkId: PassportNetwork
}) {
  if (field.kind === 'empty') {
    return (
      <p className="mnid-status mnid-status-checking">
        <span className="mnid-status-dot" aria-hidden="true" />
        <span>Type a name to see whether it is free on {NETWORK_LABELS[networkId]}.</span>
      </p>
    )
  }
  if (field.kind === 'invalid') {
    return (
      <p className="mnid-status mnid-status-error" role="alert">
        <span className="mnid-status-dot" aria-hidden="true" />
        <span>{field.message}</span>
      </p>
    )
  }
  if (field.kind === 'checking') {
    return (
      <p className="mnid-status mnid-status-checking" role="status">
        <Loader2 className="mnid-spin" size={13} aria-hidden="true" />
        <span>Checking that name…</span>
      </p>
    )
  }
  if (field.availability.status === 'available') {
    return (
      <p className="mnid-status mnid-status-available" role="status">
        <span className="mnid-status-dot" aria-hidden="true" />
        <span>
          {/* No price and no "more NIGHT needed": the service registers the
              name and pays for it, so the user's balance is not part of this
              screen at all. */}
          {aliasDomain(field.alias)} is available
        </span>
      </p>
    )
  }
  if (field.availability.status === 'taken') {
    return (
      <p className="mnid-status mnid-status-taken" role="status">
        <span className="mnid-status-dot" aria-hidden="true" />
        <span>
          {/* NO RESOLVER, AND NO ADDRESS (2026/08/31). This line used to end
              "Its resolver is 0291d8f9e4…", which is two things a Passport
              never shows its user: a piece of the registry's machinery, and an
              address that is not the one address a sender needs. What a person
              typing a name can act on is that this one is gone. */}
          {aliasDomain(field.alias)} is already taken on {NETWORK_LABELS[networkId]}. Try another
          name.
        </span>
      </p>
    )
  }
  return (
    <p className="mnid-status mnid-status-error" role="status">
      <span className="mnid-status-dot" aria-hidden="true" />
      <span>Names cannot be checked right now; your name will be queued.</span>
    </p>
  )
}
