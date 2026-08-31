/**
 * The three steps a person is actually waiting through while a name is
 * claimed, and which of the claim's seven phases each of them covers.
 *
 * WHY THIS EXISTS
 * ---------------
 * A claim reports seven phases. A person waiting on one is not living through
 * seven things — they are answering a prompt in the middle of a wait, and the
 * wait before that prompt is nothing like the wait after it. On 2026/08/26 a
 * reviewer watched a spinner and could not tell a slow network from a hung
 * app: "no infinite spinner… let the user know this will take time." What was
 * promised in reply, the same afternoon, was a three-step view — circle, line,
 * circle — and this is the rule that drives it.
 *
 * The mapping is the whole design decision, so it is stated once, here, rather
 * than spread through a component's JSX:
 *
 *   1. Checking your name        `checking`, `preparing`
 *      Both are questions asked of somebody else before anything is committed:
 *      is the name still free, and will the service register it. Neither is a
 *      thing the user does, and splitting them would put a step boundary in
 *      the middle of a single two-second wait.
 *
 *   2. Confirm with your passkey `confirm-passkey`
 *      The one step that is the USER'S. It gets a step to itself for that
 *      reason and for no other: it is the only point in the ceremony where
 *      being told which step is running changes what the person does next.
 *
 *   3. Setting up your account   `attaching-account`, `deploying-resolver`,
 *                               `registering`, `confirming`
 *      Four proved transactions' worth of waiting, and the minutes the whole
 *      claim really costs. The four are named beneath the step, as rows that
 *      fill in — see {@link claimSubStages}. They are sub-states of one wait
 *      rather than four more circles, because a person cannot act on the
 *      difference between them; what they CAN act on is knowing that something
 *      is still moving, which two minutes of one sentence cannot tell them.
 *
 * It is pure — a phase in, three labelled states out — so the rule can be
 * drilled directly rather than inferred from a rendered screen.
 *
 * WHAT WAS ADDED ON 2026/08/31, AND WHY
 * -------------------------------------
 * Three steps told a person WHERE they were and nothing about HOW LONG. The
 * product owner watched the third one and asked for the rest: "instead of three
 * steps, I want to see that you're deploying the contract and other things,
 * with a timer — this is how much it is supposed to take, and it's almost done
 * — so I'm more in touch with the progress."
 *
 * So each step now carries the time it USUALLY takes, the long one names the
 * four sub-stages it is made of, and the screen counts the real seconds against
 * the estimate. The honesty mechanism is the copy, not the number: an estimate
 * is said as "usually about", elapsed time is measured rather than modelled,
 * and a stage that outlives its estimate says so and keeps counting. Nothing
 * here invents a percentage, because there is no quantity to take a percentage
 * of — a proof either lands or it does not.
 *
 * The passkey step deliberately has NO estimate. It is the one step the user
 * performs, so a number there would be a deadline set for the reader rather
 * than a promise made to them.
 */

import type { AliasClaimProgress } from '../identity/midnames.js'

/** A claim phase, as the claim path reports it. */
export type ClaimPhase = AliasClaimProgress['phase']

/** Which of the three steps a row is: done, running now, or still ahead. */
export type ClaimStepState = 'done' | 'active' | 'todo'

export interface ClaimStep {
  /** Stable identity, for React keys and for tests. */
  id: 'name' | 'passkey' | 'account'
  /** What the row says. Sentence case, no ellipsis — it is a step, not a status. */
  label: string
  state: ClaimStepState
  /**
   * How long this step usually takes, in seconds, or `null` when the answer is
   * "as long as you take".
   *
   * The two numbers are measurements of the mocked and live walks rather than
   * targets: a name re-check plus the sponsor's answer is seconds, and the
   * account step is two proved transactions and the minutes they cost. They are
   * ESTIMATES against a live network, which is why the copy built from them
   * says "usually about" and why {@link stepTimingLine} keeps counting past
   * them instead of stalling at 100%.
   */
  expectedSeconds: number | null
}

/** The three steps, in order. Exported so a screen cannot invent a fourth. */
export const CLAIM_STEPS: readonly Omit<ClaimStep, 'state'>[] = [
  { id: 'name', label: 'Checking your name', expectedSeconds: 10 },
  /* No estimate, on purpose: this step is the USER'S, and a countdown against
     somebody's own hands is a deadline rather than an estimate. */
  { id: 'passkey', label: 'Confirm with your passkey', expectedSeconds: null },
  { id: 'account', label: 'Setting up your account', expectedSeconds: 120 },
]

/** Which step each phase belongs to, as an index into {@link CLAIM_STEPS}. */
const STEP_OF_PHASE: Record<ClaimPhase, 0 | 1 | 2> = {
  checking: 0,
  preparing: 0,
  'confirm-passkey': 1,
  'attaching-account': 2,
  'deploying-resolver': 2,
  registering: 2,
  confirming: 2,
}

/**
 * The three steps with the state each one is in for `phase`.
 *
 * Everything before the running step is done, everything after it is still
 * ahead. A step is never skipped and never goes backwards, because the phases
 * themselves do not: the claim path runs them in the order they are declared.
 */
export function claimSteps(phase: ClaimPhase): ClaimStep[] {
  const active = STEP_OF_PHASE[phase]
  return CLAIM_STEPS.map((step, index) => ({
    ...step,
    state: index < active ? 'done' : index === active ? 'active' : 'todo',
  }))
}

/* ------------------------------------------------------------------ */
/* The long step, from the inside                                      */
/* ------------------------------------------------------------------ */

/** Stable identity for one of the four states the account step passes through. */
export type ClaimSubStageId = 'account' | 'name' | 'register' | 'confirm'

export interface ClaimSubStage {
  id: ClaimSubStageId
  /** Plain words, in {@link CLAIM_STEPS}' register. Never the machinery. */
  label: string
  state: ClaimStepState
}

/** The four account phases, in the order the claim runs them. */
const ACCOUNT_PHASES = [
  'attaching-account',
  'deploying-resolver',
  'registering',
  'confirming',
] as const

/**
 * The four sub-states of the third step, with the one that is running now.
 *
 * They are NOT four more circles — a person cannot act on the difference
 * between them, which is the whole reason the stepper folds them into one step.
 * What they are is the answer to "is anything actually happening", which two
 * minutes of one unchanging sentence cannot give. They are returned for EVERY
 * phase, all four `todo` before the account step is reached, because the
 * stepper's shape rule holds inside the step as well as outside it: a row fills
 * in, it never appears.
 *
 * `domain` is the name being claimed — `alice.night` — so the registration
 * sub-stage can name it. Omitted, it says "your name", which is what the same
 * stage is called on the Home card's re-run.
 */
export function claimSubStages(phase: ClaimPhase, domain?: string): ClaimSubStage[] {
  const active = (ACCOUNT_PHASES as readonly string[]).indexOf(phase)
  const labels: readonly { id: ClaimSubStageId; label: string }[] = [
    /* Not "Setting up your account": that is the STEP this sits under, and a
       sub-stage that repeats its parent word for word says nothing. This is
       the account itself coming into existence, and that is what it says. */
    { id: 'account', label: 'Creating your account' },
    { id: 'name', label: 'Setting your name up' },
    { id: 'register', label: domain ? `Registering ${domain}` : 'Registering your name' },
    { id: 'confirm', label: 'Confirming your name' },
  ]
  return labels.map((stage, index) => ({
    ...stage,
    state:
      index < active ? 'done' : index === active ? 'active' : 'todo',
  }))
}

/* ------------------------------------------------------------------ */
/* The clock                                                           */
/* ------------------------------------------------------------------ */

/**
 * An elapsed duration as `m:ss` — `0:07`, `1:05`, `12:00`.
 *
 * It never rolls over into hours and never stops: a claim that has been running
 * for seventy minutes reads `70:00`, because a counter that wrapped would tell
 * somebody who has been waiting an hour that they have been waiting ten
 * minutes. Anything that is not a positive number of milliseconds — the one
 * frame between a step starting and the clock's first tick can produce a
 * negative — reads `0:00` rather than throwing or printing `NaN`.
 */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** "about 10 seconds", "about 2 minutes" — never a decimal, never a range. */
function expectedPhrase(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? 'about 1 second' : `about ${seconds} seconds`
  const minutes = Math.round(seconds / 60)
  return minutes === 1 ? 'about 1 minute' : `about ${minutes} minutes`
}

/**
 * The one line under a running step: what it usually costs, and what it has
 * cost so far.
 *
 * Three sentences, and the third is the reason the other two can be trusted.
 * A step inside its estimate says what the estimate is and counts towards it.
 * A step PAST its estimate does not freeze, does not reset, and does not
 * quietly widen the estimate — it says the true thing, that this one is taking
 * longer than usual, and goes on counting. That is what a stalled sponsor queue
 * or a slow indexer looks like from the outside, and it is the difference
 * between a wait and a hang: the exact defect reported on 2026/08/26.
 *
 * The passkey step has no estimate, so its line names what is being waited on
 * instead — the reader — and counts.
 */
export function stepTimingLine(step: Pick<ClaimStep, 'expectedSeconds'>, elapsedMs: number): string {
  const elapsed = formatElapsed(elapsedMs)
  if (step.expectedSeconds === null) return `Waiting for you — ${elapsed}`
  if (elapsedMs > step.expectedSeconds * 1000) {
    return `Taking a little longer than usual — ${elapsed}`
  }
  return `Usually ${expectedPhrase(step.expectedSeconds)} — ${elapsed} so far`
}
