/**
 * The tunnel's physics: the racer's constants and the one step function both the game
 * and the track validator run, so a track the validator passes is one the player can
 * really race through without a crash.
 *
 * The tunnel is song-locked like the platformer: the racer never controls speed. Their
 * distance down the tunnel, `z`, comes only from song time (`RacerWorld.zAt`, the track's
 * `zAtTime`), so they reach each obstacle on its beat. What the player does is steer
 * (hop one lane left or right) and jump low walls.
 *
 * Across the tunnel everything is in lane units: lane 0 is the leftmost slot on the
 * tunnel's lower arc, lane `lanes - 1` the rightmost, one unit apart, whatever the
 * tunnel's radius (the renderer maps lanes onto the arc). Heights are above the floor,
 * in the same units; `z` grows down the tunnel.
 */

/** Physics runs in fixed steps of this many seconds, whatever the frame rate. */
export const PHYSICS_DT = 1 / 60;
/** A hop from one lane to the next takes this long, eased, in seconds. */
export const LANE_HOP_TIME = 0.12;
/** Held, a steer hops again every this many beats (the run turns holding into presses). */
export const LANE_REPEAT = 0.5;
/** A jump's time in the air, landing at the floor, in seconds. */
export const JUMP_AIR = 0.32;
/** How high a jump peaks, in lane units. */
export const JUMP_HEIGHT = 0.8;
/** Upward speed when a jump starts, and the gravity that brings it down. */
export const JUMP_VELOCITY = (4 * JUMP_HEIGHT) / JUMP_AIR;
export const GRAVITY = (8 * JUMP_HEIGHT) / (JUMP_AIR * JUMP_AIR);
/** A low wall's height: feet at least this high pass over it. */
export const LOW_WALL_HEIGHT = 0.3;
/** Half the racer's width, in lane units. */
export const RACER_HALF = 0.25;
/** Half an obstacle's width in its lane. */
export const BLOCK_HALF = 0.4;
/** How long the racer is, front to back, in track units. */
export const RACER_DEPTH = 0.6;
/** How deep an obstacle is, in track units. */
export const BLOCK_DEPTH = 0.4;

/** What the step needs to know about an obstacle. */
export interface RacerObstacle {
  /** Where its front is down the tunnel, and its back. */
  z0: number;
  z1: number;
  /** The lanes it blocks (where a sliding block ends up). */
  lanes: number[];
  /** A low wall: jumped over. Everything else is too tall to jump. */
  low?: boolean;
  /** A sliding block: from lane `from` at `start` it slides to `lanes[0]` at `end`, eased. */
  slide?: { from: number; start: number; end: number };
}

/** What the step needs to know about the track at a moment in time. */
export interface RacerWorld {
  /** How many lanes the tunnel has. */
  readonly lanes: number;
  /** Where the racer's front is down the tunnel at song time `t`. */
  zAt(t: number): number;
  /** Indices of the obstacles overlapping [z0, z1]; the list may be reused by the next call. */
  obstaclesBetween(z0: number, z1: number): number[];
  obstacle(i: number): RacerObstacle;
}

export interface RacerState {
  /** The lane the racer is in, or hopping to. */
  lane: number;
  /** Where across the tunnel the racer is, in lanes (between two while hopping). */
  pos: number;
  /** Where the hop started from, and the seconds of it left (0 when not hopping). */
  hopFrom: number;
  hopLeft: number;
  /** Height of the feet above the floor, and its speed. */
  y: number;
  vy: number;
  grounded: boolean;
  /** Down the tunnel: always where song time puts it. */
  z: number;
  /** The obstacle hit on this step, or -1. */
  crash: number;
  /** The last obstacle hit: hitting it again on the next steps isn't a new crash. */
  lastHit: number;
}

export interface RacerInput {
  /** Hop a lane left (when there is one). */
  left?: boolean;
  /** Hop a lane right. */
  right?: boolean;
  /** Jump (only from the floor). */
  jump?: boolean;
}

export function startRacer(lane: number, z = 0): RacerState {
  return {
    lane,
    pos: lane,
    hopFrom: lane,
    hopLeft: 0,
    y: 0,
    vy: 0,
    grounded: true,
    z,
    crash: -1,
    lastHit: -1,
  };
}

/** Smoothstep: a hop starts and ends gently. */
const ease = (f: number) => f * f * (3 - 2 * f);

/** Where across the tunnel an obstacle's lane `k` is at song time `t`. */
export function obstacleLaneAt(o: RacerObstacle, k: number, t: number): number {
  const lane = o.lanes[k]!;
  if (!o.slide) return lane;
  const { from, start, end } = o.slide;
  if (t <= start) return from;
  if (t >= end) return lane;
  return from + (lane - from) * ease((t - start) / (end - start));
}

/** True when the racer at `pos`, `y` hits obstacle `o` at song time `t` (z overlap assumed). */
export function hits(o: RacerObstacle, pos: number, y: number, t: number): boolean {
  if (o.low && y >= LOW_WALL_HEIGHT) return false;
  for (let k = 0; k < o.lanes.length; k++)
    if (Math.abs(pos - obstacleLaneAt(o, k, t)) < BLOCK_HALF + RACER_HALF) return true;
  return false;
}

/**
 * One physics step of `dt` seconds ending at song time `t`. Pure: returns the new state.
 * A hop pressed while hopping turns from where the racer is toward the next lane over.
 * A crash never stops the racer: it is reported (`crash`) and the race goes on.
 */
export function stepRacer(
  p: RacerState,
  input: RacerInput,
  world: RacerWorld,
  t: number,
  dt = PHYSICS_DT,
): RacerState {
  const q: RacerState = { ...p, crash: -1 };

  // Steer.
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const target = q.lane + dir;
  if (dir !== 0 && target >= 0 && target < world.lanes) {
    q.hopFrom = q.pos;
    q.lane = target;
    q.hopLeft = LANE_HOP_TIME;
  }
  if (q.hopLeft > 0) {
    q.hopLeft = q.hopLeft - dt > 1e-9 ? q.hopLeft - dt : 0;
    q.pos = q.hopFrom + (q.lane - q.hopFrom) * ease(1 - q.hopLeft / LANE_HOP_TIME);
  } else q.pos = q.lane;

  // Jump.
  if (input.jump && q.grounded) {
    q.vy = JUMP_VELOCITY;
    q.grounded = false;
  }
  if (!q.grounded) {
    // The exact parabola, so a jump peaks at JUMP_HEIGHT and lasts JUMP_AIR at any step.
    q.y += q.vy * dt - 0.5 * GRAVITY * dt * dt;
    q.vy -= GRAVITY * dt;
    if (q.y <= 0) {
      q.y = 0;
      q.vy = 0;
      q.grounded = true;
    }
  }

  // Down the tunnel, meeting whatever the racer's length overlaps (a step is a fraction
  // of an obstacle's depth and the racer's length, so nothing is skipped over).
  q.z = world.zAt(t);
  let touching = -1;
  for (const i of world.obstaclesBetween(q.z - RACER_DEPTH, q.z)) {
    const o = world.obstacle(i);
    if (o.z1 <= q.z - RACER_DEPTH || o.z0 >= q.z) continue;
    if (!hits(o, q.pos, q.y, t)) continue;
    touching = i;
    if (i !== p.lastHit) {
      q.crash = i;
      break;
    }
  }
  if (q.crash >= 0) q.lastHit = q.crash;
  else if (touching < 0) q.lastHit = -1;
  return q;
}
