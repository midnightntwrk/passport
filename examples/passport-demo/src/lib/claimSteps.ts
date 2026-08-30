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
 *      claim really costs. The four are distinguished in the live detail line
 *      beneath the step — they are sub-states of one wait, not four more
 *      circles, because a person cannot act on the difference between them.
 *
 * It is pure — a phase in, three labelled states out — so the rule can be
 * drilled directly rather than inferred from a rendered screen.
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
}

/** The three steps, in order. Exported so a screen cannot invent a fourth. */
export const CLAIM_STEPS: readonly { id: ClaimStep['id']; label: string }[] = [
  { id: 'name', label: 'Checking your name' },
  { id: 'passkey', label: 'Confirm with your passkey' },
  { id: 'account', label: 'Setting up your account' },
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
