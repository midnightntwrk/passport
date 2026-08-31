/**
 * Drills for the claim stepper's rule, and for the clock beside it.
 *
 * What is worth holding to here is not that a function returns three objects.
 * It is that the stepper can never tell the user a lie about where they are:
 * every phase the claim path can report lands on a step, the step it lands on
 * is the one the user is actually waiting through, nothing before it is left
 * un-ticked, and nothing after it is claimed as done. Those are the four ways
 * a progress view goes wrong, and each has a test.
 *
 * Since 2026/08/31 there is a fifth way, and it is about time rather than
 * place: an estimate that is presented as a fact. So the timing copy is drilled
 * as hard as the mapping — that an estimate is always hedged, that a stage past
 * its estimate says so rather than freezing, and that the elapsed value is the
 * measured one whatever the estimate said.
 */

import { describe, expect, it } from 'vitest';

import {
  CLAIM_STEPS,
  claimSteps,
  claimSubStages,
  formatElapsed,
  stepTimingLine,
  type ClaimPhase,
} from './claimSteps.js';

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

  it('carries an estimate for the two waits, and none for the one prompt', () => {
    /* The passkey step is the USER'S. A number against somebody's own hands is
       a deadline, not an estimate, so that step has none — and the copy built
       from it names what is being waited on instead. */
    const seconds = claimSteps('checking').map((step) => step.expectedSeconds);
    expect(seconds).toEqual([10, null, 120]);
    // And the estimate travels with the step whatever phase is asked about.
    for (const phase of EVERY_PHASE) {
      expect(claimSteps(phase).map((step) => step.expectedSeconds)).toEqual([10, null, 120]);
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

describe('claimSubStages', () => {
  /** The four, in the order the claim runs them. */
  const ACCOUNT_PHASES = [
    'attaching-account',
    'deploying-resolver',
    'registering',
    'confirming',
  ] as const;

  it('names the long wait in plain words, and names the name being claimed', () => {
    expect(claimSubStages('attaching-account', 'alice.night').map((stage) => stage.label)).toEqual([
      'Creating your account',
      'Setting your name up',
      'Registering alice.night',
      'Confirming your name',
    ]);
  });

  it('says "your name" when no name is passed', () => {
    // The Home card's re-run narrates the same four stages without a domain.
    expect(claimSubStages('registering').map((stage) => stage.label)).toEqual([
      'Creating your account',
      'Setting your name up',
      'Registering your name',
      'Confirming your name',
    ]);
  });

  it('flags exactly the one that is running, in order', () => {
    ACCOUNT_PHASES.forEach((phase, index) => {
      const stages = claimSubStages(phase, 'alice.night');
      expect(stages).toHaveLength(4);
      expect(stages.map((stage) => stage.id)).toEqual(['account', 'name', 'register', 'confirm']);
      expect(stages.filter((stage) => stage.state === 'active')).toHaveLength(1);
      expect(stages.findIndex((stage) => stage.state === 'active')).toBe(index);
      expect(stages.slice(0, index).every((stage) => stage.state === 'done')).toBe(true);
      expect(stages.slice(index + 1).every((stage) => stage.state === 'todo')).toBe(true);
    });
  });

  it('exists, all four still ahead, before the account step is reached', () => {
    /* The stepper's shape rule holds INSIDE the step as well as outside it: the
       four rows are on screen from the first frame of the claim and fill in.
       A row that appeared mid-wait would reflow the panel under the reader. */
    for (const phase of ['checking', 'preparing', 'confirm-passkey'] as const) {
      const stages = claimSubStages(phase, 'alice.night');
      expect(stages).toHaveLength(4);
      expect(stages.every((stage) => stage.state === 'todo')).toBe(true);
    }
  });

  it('says nothing about the machinery behind any of it', () => {
    for (const phase of EVERY_PHASE) {
      for (const stage of claimSubStages(phase, 'alice.night')) {
        expect(stage.label).not.toMatch(/contract|resolver|registry|indexer|wallet|DUST/i);
      }
    }
  });
});

describe('formatElapsed', () => {
  it('reads as a clock, from the first second', () => {
    expect(formatElapsed(7_000)).toBe('0:07');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(720_000)).toBe('12:00');
  });

  it('never rolls over, so an hour of waiting is not reported as a minute of it', () => {
    expect(formatElapsed(3_600_000)).toBe('60:00');
    expect(formatElapsed(4_215_000)).toBe('70:15');
  });

  it('floors rather than rounds, so it never claims a second that has not passed', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(999)).toBe('0:00');
    expect(formatElapsed(1_999)).toBe('0:01');
  });

  it('reads 0:00 for the values a clock can be handed between two frames', () => {
    // A step start recorded after the tick that renders it gives a negative.
    expect(formatElapsed(-5_000)).toBe('0:00');
    expect(formatElapsed(Number.NaN)).toBe('0:00');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('stepTimingLine', () => {
  const [name, passkey, account] = claimSteps('checking');

  it('hedges the estimate and counts towards it', () => {
    expect(stepTimingLine(name, 4_000)).toBe('Usually about 10 seconds — 0:04 so far');
    expect(stepTimingLine(account, 63_000)).toBe('Usually about 2 minutes — 1:03 so far');
  });

  it('keeps counting past the estimate, and says why the number is bigger', () => {
    /* The honesty mechanism. A sponsor queue or a slow indexer can hold a phase
       for minutes; the line must not freeze, must not reset, and must not
       quietly widen the estimate — it says the true thing and goes on. */
    expect(stepTimingLine(name, 10_001)).toBe('Taking a little longer than usual — 0:10');
    expect(stepTimingLine(account, 400_000)).toBe('Taking a little longer than usual — 6:40');
    // The estimate is the boundary, and the boundary itself is not "longer".
    expect(stepTimingLine(name, 10_000)).toBe('Usually about 10 seconds — 0:10 so far');
  });

  it('waits on the reader rather than on a clock, where the step is theirs', () => {
    expect(stepTimingLine(passkey, 0)).toBe('Waiting for you — 0:00');
    expect(stepTimingLine(passkey, 95_000)).toBe('Waiting for you — 1:35');
  });

  it('says a singular unit as a singular unit', () => {
    expect(stepTimingLine({ expectedSeconds: 1 }, 0)).toBe('Usually about 1 second — 0:00 so far');
    expect(stepTimingLine({ expectedSeconds: 60 }, 0)).toBe('Usually about 1 minute — 0:00 so far');
    expect(stepTimingLine({ expectedSeconds: 90 }, 0)).toBe('Usually about 2 minutes — 0:00 so far');
  });

  it('never invents a percentage, and never names the machinery', () => {
    /* House rule, and the reason this file rather than a screenshot holds it:
       there is no quantity to take a percentage OF — a proof either lands or it
       does not — so a bar filling to 60% would be a number nobody measured. */
    for (const step of claimSteps('registering')) {
      for (const elapsed of [0, 5_000, 121_000, 3_600_000]) {
        const line = stepTimingLine(step, elapsed);
        expect(line).not.toMatch(/%|percent/i);
        expect(line).not.toMatch(/contract|resolver|registry|indexer|wallet|DUST/i);
      }
    }
  });
});
