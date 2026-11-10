/**
 * The platformer's physics: the player's constants and the one step function both the
 * game and the level validator run, so a level the validator passes is one the player
 * can really finish.
 *
 * World units are pixels. `x` grows to the right, `y` is the height above the level's
 * base line and grows upward (the game flips it for the screen). The player's position
 * is the bottom-left corner of their box: `y` is where their feet are.
 */

/** Physics runs in fixed steps of this many seconds, whatever the frame rate. */
export const PHYSICS_DT = 1 / 60;
/** Downward acceleration, px/s². */
export const GRAVITY = 2400;
/** Upward speed when a jump starts, px/s: a jump peaks about 140 px up after 0.34 s. */
export const JUMP_VELOCITY = 820;
/** The fastest fall, px/s. */
export const MAX_FALL_SPEED = 1400;
/** Running speed, px/s. Always faster than the camera, so the player can catch up. */
export const RUN_SPEED = 380;
/** A jump still works this long after running off an edge, in seconds. */
export const COYOTE_TIME = 0.08;
/** The player's box. */
export const PLAYER_WIDTH = 28;
export const PLAYER_HEIGHT = 40;
/** Running onto a surface at most this much higher than the feet steps up onto it. */
export const STEP_UP = 6;

/** The view, in world pixels. */
export const VIEW_WIDTH = 960;
export const VIEW_HEIGHT = 540;
/** Where in the view the player stands when exactly in time with the music, px from its left. */
export const ANCHOR_X = 288;
/** Feet below this height mean the player fell into a pit. */
export const DEATH_Y = -160;
/** How far spikes stick out of the surface, px. */
export const SPIKE_HEIGHT = 18;
/** The spikes' hit box is this much smaller than they look, on each side. */
export const SPIKE_MERCY = 4;
/** Equaliser platforms take this long to reach a new height, in seconds. */
export const EQ_EASE = 0.08;

/** The camera covers this many pixels per beat at a tempo folded into 80–160 BPM. */
const PX_PER_FOLDED_BEAT = 110;

/**
 * How fast the camera scrolls for a tempo, px/s. Fast songs count in half time and slow
 * ones in double time, so the speed stays between 147 and 293 px/s, below `RUN_SPEED`.
 */
export function scrollSpeed(tempo: number): number {
  let bpm = tempo > 0 ? tempo : 120;
  while (bpm >= 160) bpm /= 2;
  while (bpm < 80) bpm *= 2;
  return (PX_PER_FOLDED_BEAT * bpm) / 60;
}

export interface PlayerState {
  /** Left edge of the box. */
  x: number;
  /** Feet. */
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  /** Index of the solid stood on, or -1. */
  surface: number;
  /** Seconds since last on the ground (for coyote time). */
  airTime: number;
  /** True from a jump until the next landing. */
  jumped: boolean;
  alive: boolean;
  /** Why the player died, once dead. */
  death?: 'pit' | 'behind' | 'spikes';
}

export interface PlayerInput {
  /** Run left, stand, or run right. */
  dir: -1 | 0 | 1;
  /** Jump (only starts a jump when one is possible). */
  jump: boolean;
}

/** What the step needs to know about the level at a moment in time. */
export interface PhysicsWorld {
  /** Indices of the solids that overlap [x0, x1]; the list may be reused by the next call. */
  solidsBetween(x0: number, x1: number): number[];
  /** Top of a solid at time `t`, or null when it isn't there (a bridge between snares). */
  topAt(solid: number, t: number): number | null;
  /** True for a solid the player can stand on but pass through from below and the sides. */
  isSlab(solid: number): boolean;
  solidX(solid: number): { x0: number; x1: number };
  /** True when a spike strip overlaps the box and its spikes are out at `t`. */
  spikesHit(x0: number, x1: number, y0: number, y1: number, t: number): boolean;
  /** The camera's left edge at `t`: anything behind it is lost. */
  leftEdge(t: number): number;
  /** The furthest right the player can go at `t`. */
  rightEdge(t: number): number;
}

export function startState(x: number, y: number): PlayerState {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    grounded: true,
    surface: -1,
    airTime: 0,
    jumped: false,
    alive: true,
  };
}

/** True when a jump would start now: on the ground, or just off it. */
export function canJump(p: PlayerState): boolean {
  return p.grounded || (!p.jumped && p.airTime <= COYOTE_TIME);
}

/** The highest surface the feet can stand on at `t`, within `below` under and `above` over them. */
function supportAt(
  world: PhysicsWorld,
  x: number,
  y: number,
  t: number,
  below: number,
  above: number,
): { solid: number; top: number } | null {
  let best: { solid: number; top: number } | null = null;
  for (const s of world.solidsBetween(x, x + PLAYER_WIDTH)) {
    const top = world.topAt(s, t);
    if (top === null || top < y - below || top > y + above) continue;
    if (!best || top > best.top) best = { solid: s, top };
  }
  return best;
}

/**
 * One physics step of `dt` seconds ending at song time `t`. Pure: returns the new state.
 * The game calls it every fixed step with the player's input; the validator with every
 * input it tries.
 */
export function stepPlayer(
  p: PlayerState,
  input: PlayerInput,
  world: PhysicsWorld,
  t: number,
  dt = PHYSICS_DT,
): PlayerState {
  if (!p.alive) return p;
  const q: PlayerState = { ...p };
  const before = t - dt;

  if (input.jump && canJump(q)) {
    q.vy = JUMP_VELOCITY;
    q.grounded = false;
    q.surface = -1;
    q.jumped = true;
  }

  // Across: run, stopped by the sides of columns that reach above the feet.
  q.vx = input.dir * RUN_SPEED;
  let nx = Math.min(q.x + q.vx * dt, world.rightEdge(t) - PLAYER_WIDTH);
  for (const s of world.solidsBetween(Math.min(q.x, nx), Math.max(q.x, nx) + PLAYER_WIDTH)) {
    if (world.isSlab(s)) continue;
    const top = world.topAt(s, t);
    if (top === null || q.y >= top - STEP_UP) continue;
    const { x0, x1 } = world.solidX(s);
    if (q.x + PLAYER_WIDTH <= x0 + 1e-6 && nx + PLAYER_WIDTH > x0) nx = x0 - PLAYER_WIDTH;
    else if (q.x >= x1 - 1e-6 && nx < x1) nx = x1;
  }
  q.x = nx;

  // Up and down.
  if (q.grounded) {
    // Carried by the surface (equalisers move), or onto the next one at about the same height.
    const support = supportAt(world, q.x, q.y, t, STEP_UP, STEP_UP);
    const current = q.surface >= 0 ? world.topAt(q.surface, t) : null;
    const { x0, x1 } = q.surface >= 0 ? world.solidX(q.surface) : { x0: 0, x1: -1 };
    if (current !== null && q.x + PLAYER_WIDTH > x0 && q.x < x1) {
      q.y = current;
    } else if (support) {
      q.y = support.top;
      q.surface = support.solid;
    } else {
      q.grounded = false;
      q.surface = -1;
      q.airTime = 0;
      q.jumped = false;
    }
    q.vy = 0;
  }
  if (!q.grounded) {
    q.vy = Math.max(q.vy - GRAVITY * dt, -MAX_FALL_SPEED);
    const ny = q.y + q.vy * dt;
    let landing: { solid: number; top: number } | null = null;
    if (q.vy <= 0) {
      for (const s of world.solidsBetween(q.x, q.x + PLAYER_WIDTH)) {
        const top = world.topAt(s, t);
        if (top === null) continue;
        const was = world.topAt(s, before) ?? top;
        // Feet were on or above the surface (columns forgive a step's height) and now reach it.
        const slack = world.isSlab(s) ? 1e-6 : STEP_UP;
        if (q.y >= Math.min(was, top) - slack && ny <= top && (!landing || top > landing.top))
          landing = { solid: s, top };
      }
    }
    if (landing) {
      q.y = landing.top;
      q.vy = 0;
      q.grounded = true;
      q.surface = landing.solid;
      q.jumped = false;
      q.airTime = 0;
    } else {
      q.y = ny;
      q.airTime += dt;
    }
  }

  if (q.y < DEATH_Y) return { ...q, alive: false, death: 'pit' };
  if (q.x < world.leftEdge(t)) return { ...q, alive: false, death: 'behind' };
  if (world.spikesHit(q.x, q.x + PLAYER_WIDTH, q.y, q.y + PLAYER_HEIGHT, t))
    return { ...q, alive: false, death: 'spikes' };
  return q;
}
