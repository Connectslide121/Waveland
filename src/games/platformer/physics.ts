/**
 * The platformer's physics: the player's constants and the one step function both the
 * game and the level validator run, so a level the validator passes is one the player
 * can really finish.
 *
 * The platformer is a song-locked auto-runner: the player never walks. Their `x` comes
 * only from song time (`PhysicsWorld.xAt`, the level's `xAtTime`), so they are always in
 * time with the music, at the anchor of the view. What the player does is go up and
 * down: jump, dash (hold level for a moment) and slam (drop fast).
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
/** A full jump's time in the air, landing at the height it took off from, in seconds. */
export const JUMP_AIR = (2 * JUMP_VELOCITY) / GRAVITY;
/** The fastest fall, px/s. */
export const MAX_FALL_SPEED = 1400;
/** A jump still works this long after running off an edge, in seconds. */
export const COYOTE_TIME = 0.08;
/**
 * Letting go of jump on the way up cuts the rise to this speed, px/s, for a lower jump.
 * The validator lets go too (`release`), at every decision, so it knows the short hops.
 */
export const JUMP_CUT_VELOCITY = 300;
/** A jump pressed this long before landing still happens on landing, in seconds. */
export const JUMP_BUFFER = 0.1;
/**
 * A dash holds the cube level (no gravity) this long, in seconds: half a beat at 120 BPM,
 * about half a beat at any folded tempo. One per time in the air, refilled on landing.
 */
export const DASH_TIME = 0.25;
/** A slam drops the cube at this speed, px/s, until it lands. */
export const SLAM_SPEED = 1600;
/** The player's box. */
export const PLAYER_WIDTH = 28;
export const PLAYER_HEIGHT = 40;
/** Running onto a surface at most this much higher than the feet steps up onto it. */
export const STEP_UP = 6;

/**
 * The view at 16:9, in world pixels. The scene fits its height to the screen's (its width
 * on screens narrower than 16:9) and a wider screen shows more of the level either side.
 */
export const VIEW_WIDTH = 960;
export const VIEW_HEIGHT = 540;
/** Where across the screen the player's left edge always is, as a share of its width. */
export const ANCHOR_SHARE = 0.4;
/** Where in the 16:9 view the player always is, px from its left. */
export const ANCHOR_X = ANCHOR_SHARE * VIEW_WIDTH;
/**
 * The widest view the level keeps its changes out of (ground reshaping, columns starting
 * to move): a 32:9 screen. Narrower screens see less of it.
 */
export const MAX_VIEW_WIDTH = (VIEW_HEIGHT * 32) / 9;
/** How much of the level the widest view shows ahead of the player's left edge, and behind it. */
export const VIEW_AHEAD = (1 - ANCHOR_SHARE) * MAX_VIEW_WIDTH;
export const VIEW_BEHIND = ANCHOR_SHARE * MAX_VIEW_WIDTH;
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
 * ones in double time, so the speed stays between 147 and 293 px/s.
 */
export function scrollSpeed(tempo: number): number {
  let bpm = tempo > 0 ? tempo : 120;
  while (bpm >= 160) bpm /= 2;
  while (bpm < 80) bpm *= 2;
  return (PX_PER_FOLDED_BEAT * bpm) / 60;
}

/** Why the player died. */
export type DeathCause = 'pit' | 'wall' | 'spikes' | 'gate';

export interface PlayerState {
  /** Left edge of the box: always where song time puts it. */
  x: number;
  /** Feet. */
  y: number;
  vy: number;
  grounded: boolean;
  /** Index of the solid stood on, or -1. */
  surface: number;
  /** Seconds since last on the ground (for coyote time). */
  airTime: number;
  /** True from a jump until the next landing. */
  jumped: boolean;
  /** Seconds of dash left: while above 0 the cube holds its height. */
  dashLeft: number;
  /** A dash can start: refilled on the ground once the dash is over. */
  dashReady: boolean;
  /** Dropping in a slam, until the next landing. */
  slamming: boolean;
  alive: boolean;
  /** Why the player died, once dead. */
  death?: DeathCause;
}

export interface PlayerInput {
  /** Jump (only starts a jump when one is possible). */
  jump: boolean;
  /** Jump is let go: a rising jump is cut short. */
  release?: boolean;
  /** Dash (only when one is ready). */
  dash?: boolean;
  /** Slam (only in the air). */
  slam?: boolean;
}

/** What the step needs to know about the level at a moment in time. */
export interface PhysicsWorld {
  /** Where the player's left edge is at song time `t`. */
  xAt(t: number): number;
  /** Indices of the solids that overlap [x0, x1]; the list may be reused by the next call. */
  solidsBetween(x0: number, x1: number): number[];
  /** Top of a solid at time `t`, or null when it isn't there (a bridge between snares). */
  topAt(solid: number, t: number): number | null;
  /** The underside of a solid hanging from the sky, or -Infinity for one standing on the ground. */
  bottomOf(solid: number): number;
  /** True for a solid the player can stand on but pass through from below and the sides. */
  isSlab(solid: number): boolean;
  /** True for a slam plate: a slab a slam goes through (it breaks), as nothing else does. */
  isPlate(solid: number): boolean;
  solidX(solid: number): { x0: number; x1: number };
  /** True when a spike strip overlaps the box and its spikes are out at `t`. */
  spikesHit(x0: number, x1: number, y0: number, y1: number, t: number): boolean;
  /** True when a dash gate stands in (x0, x1]: the box's front passes it. */
  gateBetween(x0: number, x1: number): boolean;
}

export function startState(x: number, y: number): PlayerState {
  return {
    x,
    y,
    vy: 0,
    grounded: true,
    surface: -1,
    airTime: 0,
    jumped: false,
    dashLeft: 0,
    dashReady: true,
    slamming: false,
    alive: true,
  };
}

/** True when a jump would start now: on the ground, or just off it. */
export function canJump(p: PlayerState): boolean {
  return p.grounded || (!p.jumped && p.airTime <= COYOTE_TIME);
}

/** True when a dash would start now. */
export function canDash(p: PlayerState): boolean {
  return p.dashReady && !p.slamming;
}

/** True when a slam would start now: in the air and not slamming already. */
export function canSlam(p: PlayerState): boolean {
  return !p.grounded && !p.slamming;
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

  // The abilities.
  if (input.jump && canJump(q)) {
    q.vy = JUMP_VELOCITY;
    q.grounded = false;
    q.surface = -1;
    q.jumped = true;
    q.dashLeft = 0;
  } else if (input.release && q.jumped && q.vy > JUMP_CUT_VELOCITY) {
    q.vy = JUMP_CUT_VELOCITY;
  }
  if (input.dash && canDash(q)) {
    q.dashLeft = DASH_TIME;
    q.dashReady = false;
    q.vy = 0;
  }
  if (input.slam && canSlam(q)) {
    q.slamming = true;
    q.dashLeft = 0;
    q.vy = -SLAM_SPEED;
  }

  // Across: where song time puts the player. Running into the side of a column, or a
  // dash gate without dashing, is a death: there is no stopping.
  const nx = world.xAt(t);
  const front = q.x + PLAYER_WIDTH;
  const nextFront = nx + PLAYER_WIDTH;
  for (const s of world.solidsBetween(q.x, nextFront)) {
    if (world.isSlab(s)) continue;
    const top = world.topAt(s, t);
    if (top === null) continue;
    const { x0 } = world.solidX(s);
    if (front > x0 + 1e-6 || nextFront <= x0) continue;
    if (q.y < top - STEP_UP && q.y + PLAYER_HEIGHT > world.bottomOf(s))
      return { ...q, x: x0 - PLAYER_WIDTH, alive: false, death: 'wall' };
  }
  if (q.dashLeft <= 0 && world.gateBetween(front, nextFront))
    return { ...q, x: nx, alive: false, death: 'gate' };
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
    // A dash holds the height; a slam drops at its own speed; otherwise gravity.
    if (q.dashLeft > 0) q.vy = 0;
    else if (q.slamming) q.vy = -SLAM_SPEED;
    else q.vy = Math.max(q.vy - GRAVITY * dt, -MAX_FALL_SPEED);
    let ny = q.y + q.vy * dt;
    const solids = world.solidsBetween(q.x, q.x + PLAYER_WIDTH);
    // The head bumps the underside of what hangs from the sky.
    if (q.vy > 0)
      for (const s of solids) {
        const bottom = world.bottomOf(s);
        if (bottom === -Infinity || world.topAt(s, t) === null) continue;
        if (q.y + PLAYER_HEIGHT <= bottom + 1e-6 && ny + PLAYER_HEIGHT > bottom) {
          ny = bottom - PLAYER_HEIGHT;
          q.vy = 0;
        }
      }
    let landing: { solid: number; top: number } | null = null;
    if (q.vy <= 0) {
      for (const s of solids) {
        const top = world.topAt(s, t);
        if (top === null || (q.slamming && world.isPlate(s))) continue;
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
      q.slamming = false;
      q.airTime = 0;
    } else {
      q.y = ny;
      q.airTime += dt;
    }
  }

  // The dash runs out; on the ground once it has, the next one is ready.
  if (q.dashLeft > 0) q.dashLeft = q.dashLeft - dt > 1e-9 ? q.dashLeft - dt : 0;
  if (q.grounded && q.dashLeft === 0) q.dashReady = true;

  if (q.y < DEATH_Y) return { ...q, alive: false, death: 'pit' };
  if (world.spikesHit(q.x, q.x + PLAYER_WIDTH, q.y, q.y + PLAYER_HEIGHT, t))
    return { ...q, alive: false, death: 'spikes' };
  return q;
}
