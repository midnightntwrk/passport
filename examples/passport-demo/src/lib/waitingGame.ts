/**
 * The little runner offered while a claim is proving, as a rule rather than a
 * render.
 *
 * WHY THIS EXISTS
 * ---------------
 * The third step of a claim is four proved transactions and takes minutes. The
 * stepper says where the claim is and counts the seconds against an estimate,
 * which is what stops a wait reading as a hang — but it is still a wait, and a
 * reviewer on 2026/09/02 asked for the obvious thing: "an embedded game while
 * you're waiting, like the Chrome dinosaur."
 *
 * WHAT IS IN HERE AND WHAT IS NOT
 * -------------------------------
 * Everything that DECIDES is here: where the runner is, where the obstacles
 * are, whether the two have met, and what the score is. It is a state in and a
 * state out, with no canvas, no `requestAnimationFrame`, no clock, no
 * `Math.random`, and no keyboard — the elapsed milliseconds are handed in, and
 * the obstacle sizes come from a seeded generator carried in the state itself.
 * So a run is reproducible: the same seed and the same frames give the same
 * game, which is the only way a collision rule can be drilled rather than
 * eyeballed.
 *
 * `../screens/WaitingGame.tsx` is the other half — a canvas, a frame loop, and
 * two event listeners — and it holds no rules at all.
 *
 * THE ONE RULE THAT IS NOT ABOUT THE GAME
 * ---------------------------------------
 * A game beside a claim must never become a reason a claim goes wrong, so the
 * screen can take the state out of `running` at any moment and nothing here
 * resists: {@link tick} on a state that is not running returns that same state,
 * unchanged and unadvanced. That is what makes "pause the instant the step
 * completes or the passkey prompt appears" a single call rather than a race —
 * and why the frame loop can be stopped mid-jump and resumed exactly where it
 * was, or dropped entirely without anything to clean up.
 */

/**
 * How long a wait has to last before the game is offered at all.
 *
 * Eight seconds, because most steps of a claim are done inside that and an
 * offer of a distraction from a wait that is about to end is itself the
 * distraction. Below this the stepper is the whole of the screen.
 */
export const OFFER_AFTER_MS = 8_000;

/** Every state the game can be in. Only `running` advances. */
export type WaitingGameStatus = 'ready' | 'running' | 'paused' | 'over';

/** One obstacle: how far along the field it is, and how tall it stands. */
export interface Obstacle {
  readonly x: number;
  readonly height: number;
}

export interface WaitingGameState {
  readonly status: WaitingGameStatus;
  /** The runner's height ABOVE the ground line. Zero is grounded. */
  readonly y: number;
  /** Vertical speed in pixels per millisecond; positive is upward. */
  readonly velocity: number;
  readonly obstacles: readonly Obstacle[];
  /** Pixels of field passed under the runner. The score is derived from it. */
  readonly travelled: number;
  /** Pixels still to pass before the next obstacle enters from the right. */
  readonly untilNextObstacle: number;
  /** The generator's position. Carried in the state so a run is reproducible. */
  readonly seed: number;
  /** The best score of this sitting, kept across a restart. */
  readonly best: number;
}

/**
 * The field's measurements, in pixels and milliseconds.
 *
 * They are tuned so a jump clears an obstacle at the starting speed with room
 * to spare and still fits inside the canvas: 0.46 px/ms against 0.0016 px/ms²
 * peaks at 66 px after 287 ms and lands 575 ms after take-off, which is 92 px
 * of field at the opening speed against a 10 px obstacle. The speed climbs
 * with distance and stops climbing at `maxSpeed`, which is the point where the
 * smallest gap is still clearable.
 */
export const FIELD = {
  width: 320,
  height: 108,
  /** Distance from the top of the canvas down to the ground line. */
  groundY: 88,
  runnerX: 34,
  runnerSize: 14,
  obstacleWidth: 10,
  gravity: 0.0016,
  jumpVelocity: 0.46,
  startSpeed: 0.16,
  maxSpeed: 0.36,
  /** Extra pixels per millisecond gained for every pixel already travelled. */
  acceleration: 0.00004,
  minGap: 130,
  gapSpread: 150,
  minObstacle: 14,
  obstacleSpread: 14,
  /**
   * The longest frame the game will integrate in one go. A backgrounded tab
   * hands back a gap of seconds when it returns, and integrating it whole
   * would teleport the runner through an obstacle.
   */
  maxFrameMs: 48,
  pointsPerPixel: 1 / 12,
} as const;

/**
 * One step of the generator (mulberry32): a value in [0, 1) and the seed to
 * ask next. Pure, so a seed replays a run exactly.
 */
export function randomStep(seed: number): { value: number; seed: number } {
  const next = (seed + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296, seed: next };
}

/** A fresh game, grounded and waiting for the first press. */
export function createGame(seed = 1, best = 0): WaitingGameState {
  return {
    status: 'ready',
    y: 0,
    velocity: 0,
    obstacles: [],
    travelled: 0,
    /* Not zero: the first obstacle arrives a beat after the first press,
       rather than at the same instant as it. */
    untilNextObstacle: 90,
    seed,
    best,
  };
}

/** The score a distance is worth. */
export function scoreFor(travelled: number): number {
  return Math.floor(travelled * FIELD.pointsPerPixel);
}

/** The score of a state, which is the only number the screen prints. */
export function score(state: WaitingGameState): number {
  return scoreFor(state.travelled);
}

/** The score as it is shown: four digits, so the counter does not reflow. */
export function formatScore(value: number): string {
  return String(value).padStart(4, '0');
}

/** Whether the runner at height `y` is inside `obstacle`. */
export function hits(y: number, obstacle: Obstacle): boolean {
  const overlapping =
    obstacle.x < FIELD.runnerX + FIELD.runnerSize &&
    obstacle.x + FIELD.obstacleWidth > FIELD.runnerX;
  return overlapping && y < obstacle.height;
}

/**
 * The one control. A press starts a waiting game, jumps a grounded runner,
 * does nothing at all mid-jump, and restarts a finished game keeping the best
 * score of the sitting. A paused game does not jump: the screen paused it
 * because something else needs the reader.
 */
export function jump(state: WaitingGameState): WaitingGameState {
  if (state.status === 'over') return createGame(state.seed, state.best);
  if (state.status === 'paused') return state;
  if (state.y > 0) return state;
  return { ...state, status: 'running', velocity: FIELD.jumpVelocity };
}

/** Stop advancing. Anything not running is already stopped. */
export function pause(state: WaitingGameState): WaitingGameState {
  return state.status === 'running' ? { ...state, status: 'paused' } : state;
}

/** Carry on from exactly where a pause left off. */
export function resume(state: WaitingGameState): WaitingGameState {
  return state.status === 'paused' ? { ...state, status: 'running' } : state;
}

/**
 * Advance the game by `dtMs` milliseconds.
 *
 * A state that is not running is returned untouched — see the module header;
 * that is the property the screen leans on to pause without a race.
 */
export function tick(state: WaitingGameState, dtMs: number): WaitingGameState {
  if (state.status !== 'running') return state;

  const step = Math.max(0, Math.min(dtMs, FIELD.maxFrameMs));
  const speed = Math.min(
    FIELD.maxSpeed,
    FIELD.startSpeed + state.travelled * FIELD.acceleration,
  );
  const advance = speed * step;

  let y = state.y + state.velocity * step;
  let velocity = state.velocity - FIELD.gravity * step;
  if (y <= 0) {
    y = 0;
    velocity = 0;
  }

  const obstacles: Obstacle[] = [];
  for (const obstacle of state.obstacles) {
    const moved = obstacle.x - advance;
    /* Passed obstacles are dropped rather than kept at a negative x: the list
       is walked once per frame for the collision test, and a game left open
       for a minute would otherwise walk hundreds of them. */
    if (moved + FIELD.obstacleWidth > 0) obstacles.push({ x: moved, height: obstacle.height });
  }

  let untilNextObstacle = state.untilNextObstacle - advance;
  let seed = state.seed;
  if (untilNextObstacle <= 0) {
    const gap = randomStep(seed);
    const size = randomStep(gap.seed);
    seed = size.seed;
    untilNextObstacle = FIELD.minGap + gap.value * FIELD.gapSpread;
    obstacles.push({
      x: FIELD.width,
      height: FIELD.minObstacle + size.value * FIELD.obstacleSpread,
    });
  }

  const travelled = state.travelled + advance;
  const struck = obstacles.some((obstacle) => hits(y, obstacle));
  return {
    status: struck ? 'over' : 'running',
    y,
    velocity,
    obstacles,
    travelled,
    untilNextObstacle,
    seed,
    best: Math.max(state.best, scoreFor(travelled)),
  };
}
