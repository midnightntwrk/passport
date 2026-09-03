/**
 * The waiting game's rules, drilled on a hand-wound clock and a fixed seed.
 *
 * Two of these matter more than the rest. The first is that a state which is
 * not running does not advance, because that is the property the screen leans
 * on to pause the instant a step completes or a passkey prompt appears — if it
 * were untrue, a game would go on eating frames behind a ceremony. The second
 * is the frame clamp: a backgrounded tab hands back a gap of seconds, and a
 * runner integrated through it lands on the far side of an obstacle it never
 * touched.
 */

import { describe, expect, it } from 'vitest';

import {
  createGame,
  FIELD,
  OFFER_AFTER_MS,
  formatScore,
  hits,
  jump,
  pause,
  randomStep,
  resume,
  score,
  scoreFor,
  tick,
  type WaitingGameState,
} from './waitingGame.js';

/** Run `frames` frames of `ms` each, pressing nothing. */
function run(state: WaitingGameState, frames: number, ms = 16): WaitingGameState {
  let current = state;
  for (let index = 0; index < frames; index += 1) current = tick(current, ms);
  return current;
}

describe('createGame', () => {
  it('starts grounded, empty, and waiting for a press', () => {
    const game = createGame();
    expect(game.status).toBe('ready');
    expect(game.y).toBe(0);
    expect(game.velocity).toBe(0);
    expect(game.obstacles).toEqual([]);
    expect(game.travelled).toBe(0);
    expect(game.seed).toBe(1);
    expect(game.best).toBe(0);
  });

  it('takes a seed and a best score when one is being carried over', () => {
    const game = createGame(4_242, 37);
    expect(game.seed).toBe(4_242);
    expect(game.best).toBe(37);
  });

  it('holds the first obstacle back so it does not arrive with the press', () => {
    expect(createGame().untilNextObstacle).toBeGreaterThan(0);
  });
});

describe('randomStep', () => {
  it('is a function of its seed alone, so a run replays exactly', () => {
    const first = randomStep(1);
    expect(randomStep(1)).toEqual(first);
    expect(first.value).toBeGreaterThanOrEqual(0);
    expect(first.value).toBeLessThan(1);
    expect(first.seed).not.toBe(1);
  });

  it('moves on rather than repeating itself', () => {
    const first = randomStep(1);
    expect(randomStep(first.seed).value).not.toBe(first.value);
  });
});

describe('jump', () => {
  it('starts a waiting game on the first press', () => {
    const game = jump(createGame());
    expect(game.status).toBe('running');
    expect(game.velocity).toBe(FIELD.jumpVelocity);
  });

  it('lifts a grounded runner', () => {
    const running = run(jump(createGame()), 60);
    expect(running.y).toBe(0);
    expect(jump(running).velocity).toBe(FIELD.jumpVelocity);
  });

  it('does nothing mid-jump, so a held key is not a hover', () => {
    const midair = tick(jump(createGame()), 16);
    expect(midair.y).toBeGreaterThan(0);
    expect(jump(midair)).toBe(midair);
  });

  it('does not act on a paused game — something else has the reader', () => {
    const paused = pause(jump(createGame()));
    expect(jump(paused)).toBe(paused);
  });

  it('restarts a finished game, keeping the best score of the sitting', () => {
    const over: WaitingGameState = {
      ...createGame(9, 0),
      status: 'over',
      travelled: 600,
      best: 50,
    };
    const restarted = jump(over);
    expect(restarted.status).toBe('ready');
    expect(restarted.travelled).toBe(0);
    expect(restarted.best).toBe(50);
    expect(restarted.seed).toBe(9);
  });
});

describe('pause and resume', () => {
  it('stops a running game and carries on from where it stopped', () => {
    const running = run(jump(createGame()), 20);
    const paused = pause(running);
    expect(paused.status).toBe('paused');
    expect(paused.travelled).toBe(running.travelled);
    const resumed = resume(paused);
    expect(resumed.status).toBe('running');
    expect(resumed.travelled).toBe(running.travelled);
  });

  it('leaves anything that is not running exactly as it is', () => {
    const ready = createGame();
    expect(pause(ready)).toBe(ready);
    expect(resume(ready)).toBe(ready);
  });
});

describe('tick', () => {
  it('does not advance a game that is not running', () => {
    const ready = createGame();
    expect(tick(ready, 16)).toBe(ready);
    const paused = pause(jump(ready));
    expect(tick(paused, 16)).toBe(paused);
    const over = { ...ready, status: 'over' as const };
    expect(tick(over, 16)).toBe(over);
  });

  it('carries the runner forward and scores the distance', () => {
    const moved = run(jump(createGame()), 10);
    expect(moved.travelled).toBeGreaterThan(0);
    expect(score(moved)).toBe(scoreFor(moved.travelled));
  });

  it('brings a jump back down and settles it exactly on the ground', () => {
    let game = jump(createGame());
    let peak = 0;
    for (let index = 0; index < 60; index += 1) {
      game = tick(game, 16);
      peak = Math.max(peak, game.y);
    }
    expect(peak).toBeGreaterThan(30);
    expect(peak).toBeLessThan(FIELD.groundY);
    expect(game.y).toBe(0);
    expect(game.velocity).toBe(0);
  });

  it('clamps a frame, so a backgrounded tab does not teleport the runner', () => {
    const running = jump(createGame());
    const huge = tick(running, 5_000);
    const clamped = tick(running, FIELD.maxFrameMs);
    expect(huge.travelled).toBe(clamped.travelled);
  });

  it('treats a negative frame as no frame at all', () => {
    const running = jump(createGame());
    expect(tick(running, -40).travelled).toBe(0);
  });

  it('speeds up with distance and then stops speeding up', () => {
    const early = tick(jump(createGame()), 16).travelled;
    const far = tick({ ...jump(createGame()), travelled: 1_000 }, 16).travelled - 1_000;
    const flat = tick({ ...jump(createGame()), travelled: 100_000 }, 16).travelled - 100_000;
    expect(far).toBeGreaterThan(early);
    expect(flat).toBeCloseTo(FIELD.maxSpeed * 16, 6);
  });

  it('sends obstacles in from the right and drops them once they are past', () => {
    let game = jump(createGame());
    let seen = false;
    let dropped = false;
    for (let index = 0; index < 400; index += 1) {
      const before = game.obstacles.length;
      game = tick(game, 16);
      if (game.obstacles.some((obstacle) => obstacle.x === FIELD.width)) seen = true;
      if (game.obstacles.length < before) dropped = true;
      /* Kept airborne over everything, so the run is about the obstacles
         arriving and leaving rather than about a collision. */
      game = { ...game, y: FIELD.groundY, velocity: 0 };
    }
    expect(seen).toBe(true);
    expect(dropped).toBe(true);
  });

  it('ends the game when the runner meets an obstacle', () => {
    let game = jump(createGame());
    for (let index = 0; index < 400 && game.status === 'running'; index += 1) {
      game = tick(game, 16);
    }
    expect(game.status).toBe('over');
    expect(game.travelled).toBeGreaterThan(0);
  });

  it('keeps the best score of the sitting as the run goes on', () => {
    const game = run(jump(createGame(1, 12)), 40);
    expect(game.best).toBeGreaterThanOrEqual(12);
    expect(game.best).toBe(Math.max(12, score(game)));
  });
});

describe('hits', () => {
  const obstacle = { x: FIELD.runnerX, height: 20 };

  it('is a hit when the runner is low and the obstacle is on it', () => {
    expect(hits(0, obstacle)).toBe(true);
    expect(hits(19, obstacle)).toBe(true);
  });

  it('is a miss when the runner is above the obstacle', () => {
    expect(hits(20, obstacle)).toBe(false);
    expect(hits(40, obstacle)).toBe(false);
  });

  it('is a miss when the obstacle has not arrived yet', () => {
    expect(hits(0, { x: FIELD.runnerX + FIELD.runnerSize, height: 20 })).toBe(false);
  });

  it('is a miss when the obstacle is already behind the runner', () => {
    expect(hits(0, { x: FIELD.runnerX - FIELD.obstacleWidth, height: 20 })).toBe(false);
  });
});

describe('the offer', () => {
  it('is held back until a wait is long enough to be worth distracting from', () => {
    expect(OFFER_AFTER_MS).toBe(8_000);
  });
});

describe('the score', () => {
  it('counts up with the distance and never runs backwards', () => {
    expect(scoreFor(0)).toBe(0);
    expect(scoreFor(12)).toBe(1);
    expect(scoreFor(1_200)).toBe(100);
  });

  it('is printed at a fixed width, so the counter does not reflow', () => {
    expect(formatScore(0)).toBe('0000');
    expect(formatScore(7)).toBe('0007');
    expect(formatScore(1_234)).toBe('1234');
    expect(formatScore(12_345)).toBe('12345');
  });
});
