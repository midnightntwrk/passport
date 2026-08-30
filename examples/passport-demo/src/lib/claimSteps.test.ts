/**
 * Drills for the claim stepper's rule.
 *
 * What is worth holding to here is not that a function returns three objects.
 * It is that the stepper can never tell the user a lie about where they are:
 * every phase the claim path can report lands on a step, the step it lands on
 * is the one the user is actually waiting through, nothing before it is left
 * un-ticked, and nothing after it is claimed as done. Those are the four ways
 * a progress view goes wrong, and each has a test.
 */

import { describe, expect, it } from 'vitest';

import { CLAIM_STEPS, claimSteps, type ClaimPhase } from './claimSteps.js';

/** Every phase the claim path reports, in the order it reports them. */
const EVERY_PHASE: ClaimPhase[] = [
  'checking',
  'preparing',
  'confirm-passkey',
  'attaching-account',
  'deploying-resolver',
  'registering',
  'confirming',
];

const states = (phase: ClaimPhase) => claimSteps(phase).map((step) => step.state);

describe('claimSteps', () => {
  it('is three steps, in the order the user meets them', () => {
    expect(CLAIM_STEPS.map((step) => step.id)).toEqual(['name', 'passkey', 'account']);
    expect(CLAIM_STEPS.map((step) => step.label)).toEqual([
      'Checking your name',
      'Confirm with your passkey',
      'Setting up your account',
    ]);
  });

  it('puts the two pre-prompt questions on the first step', () => {
    /* Both are asked of somebody else, both are seconds long, and a boundary
       between them would put a step change in the middle of one wait. */
    expect(states('checking')).toEqual(['active', 'todo', 'todo']);
    expect(states('preparing')).toEqual(['active', 'todo', 'todo']);
  });

  it('gives the passkey prompt a step of its own', () => {
    // The only step that is the USER'S, which is the whole reason it has one.
    expect(states('confirm-passkey')).toEqual(['done', 'active', 'todo']);
  });

  it('keeps all four of the long wait’s stages on the third step', () => {
    /* "Registering…" and "Waiting to confirm…" are sub-states of one wait, not
       two more circles: nothing a person does changes between them. */
    for (const phase of ['attaching-account', 'deploying-resolver', 'registering', 'confirming'] as const) {
      expect(states(phase)).toEqual(['done', 'done', 'active']);
    }
  });

  it('answers for every phase the claim can report, with exactly one running', () => {
    for (const phase of EVERY_PHASE) {
      const steps = claimSteps(phase);
      expect(steps).toHaveLength(3);
      expect(steps.filter((step) => step.state === 'active')).toHaveLength(1);
      expect(steps.map((step) => step.id)).toEqual(['name', 'passkey', 'account']);
    }
  });

  it('never leaves a gap behind the running step or a tick in front of it', () => {
    for (const phase of EVERY_PHASE) {
      const order = states(phase);
      const active = order.indexOf('active');
      // Everything behind it is done…
      expect(order.slice(0, active).every((state) => state === 'done')).toBe(true);
      // …and everything ahead of it is still ahead.
      expect(order.slice(active + 1).every((state) => state === 'todo')).toBe(true);
    }
  });

  it('only ever moves forwards as the claim progresses', () => {
    /* The phases are declared in the order the claim runs them, so the step
       index they map to must never decrease. A mapping that went backwards
       would tick a step and then un-tick it in front of the user. */
    const indices = EVERY_PHASE.map((phase) => states(phase).indexOf('active'));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});
