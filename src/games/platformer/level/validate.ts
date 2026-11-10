import {
  canDash,
  canJump,
  canSlam,
  JUMP_CUT_VELOCITY,
  PHYSICS_DT,
  startState,
  STEP_UP,
  stepPlayer,
  type PlayerInput,
  type PlayerState,
} from '../physics';
import { LevelWorld, type Ability, type PlatformerLevel } from './level';

/**
 * Proves a level can be finished by finding a way through it: a search over the player's
 * inputs, run through the same `stepPlayer` the game uses, against the level's moving
 * parts at the song time they happen.
 *
 * The player's x comes from song time, so every candidate at a moment is at the same x:
 * a candidate is only its height, speed, ground, dash and slam. Every few physics steps
 * each one tries doing nothing, jumping, letting go of jump (a lower jump), dashing and
 * slamming. Candidates in the same state are merged and the rest thinned evenly by
 * height, so the search stays small. That only ever misses ways through, never invents
 * one: a level it passes is finishable, and one it fails is made easier.
 */

/** Physics steps between decisions: the player changes input up to 20 times a second. */
export const DECISION_STEPS = 3;
/** Candidates kept on the ground, and in each kind of being in the air. */
const KEEP_GROUNDED = 16;
const KEEP_AIRBORNE = 12;

const NOTHING: PlayerInput = { jump: false };
const JUMP: PlayerInput = { jump: true };
const RELEASE: PlayerInput = { jump: false, release: true };
const DASH: PlayerInput = { jump: false, dash: true };
const SLAM: PlayerInput = { jump: false, slam: true };

/**
 * What a candidate can do at a decision: only what changes something. Without slam, it
 * doesn't let go of jump early either: a short hop gets under an overhang as a slam does.
 */
function choices(p: PlayerState, without?: Ability): PlayerInput[] {
  const out = [NOTHING];
  if (canJump(p)) out.push(JUMP);
  if (p.jumped && p.vy > JUMP_CUT_VELOCITY && without !== 'slam') out.push(RELEASE);
  if (canDash(p) && without !== 'dash') out.push(DASH);
  if (canSlam(p) && without !== 'slam') out.push(SLAM);
  return out;
}

/** The step a song time falls on. */
export function stepAt(time: number): number {
  return Math.round(time / PHYSICS_DT);
}

function keyOf(p: PlayerState): string {
  const dash = `${p.dashReady ? 1 : 0}${Math.round(p.dashLeft / PHYSICS_DT)}`;
  if (p.grounded) return `g${p.surface}:${dash}`;
  const flags = `${canJump(p) ? 1 : 0}${p.jumped ? 1 : 0}${p.slamming ? 1 : 0}`;
  return `a${Math.round(p.y / 4)}:${Math.round(p.vy / 80)}:${flags}:${dash}`;
}

/** On the ground, or in the air with a dash ready, dashing, spent, or slamming. */
function groupOf(p: PlayerState): string {
  if (p.grounded) return 'ground';
  if (p.slamming) return 'slam';
  return p.dashLeft > 0 ? 'dashing' : p.dashReady ? 'ready' : 'spent';
}

/** Up to `n` of the states, evenly spread from low to high. */
function spread(states: PlayerState[], n: number): PlayerState[] {
  if (states.length <= n) return states;
  states.sort((a, b) => a.y - b.y || a.vy - b.vy);
  const out: PlayerState[] = [];
  for (let i = 0; i < n; i++) out.push(states[Math.floor(((i + 0.5) * states.length) / n)]!);
  return out;
}

/** How a candidate got where it is: its last press, on which step, and the one before. */
interface Trail {
  input: PlayerInput;
  step: number;
  prev: Trail | undefined;
}

/** The candidates at one moment, and how they go on. */
export class Explorer {
  /** When kept (`solveLevel`), how each candidate got there. */
  trails: WeakMap<PlayerState, Trail> | null = null;

  constructor(
    readonly world: LevelWorld,
    public states: PlayerState[],
    public step: number,
    /** Where the last surviving candidates got. */
    public furthest = { x: 0, time: 0 },
    /** An ability the search never uses: to check an obstacle really needs it. */
    readonly without?: Ability,
  ) {}

  static start(world: LevelWorld, without?: Ability): Explorer {
    const { x, y } = world.level.start;
    const first = startState(x, y);
    const support = world.solidsBetween(x, x + 1)[0];
    return new Explorer(world, [{ ...first, surface: support ?? -1 }], 0, { x, time: 0 }, without);
  }

  clone(): Explorer {
    const copy = new Explorer(
      this.world,
      this.states,
      this.step,
      { ...this.furthest },
      this.without,
    );
    copy.trails = this.trails;
    return copy;
  }

  get alive(): boolean {
    return this.states.length > 0;
  }

  get anyGrounded(): boolean {
    return this.states.some((s) => s.grounded);
  }

  /** Search on until `untilStep` (or until no candidate is left). True when one survives. */
  run(untilStep: number): boolean {
    while (this.step < untilStep && this.states.length > 0) {
      const steps = Math.min(DECISION_STEPS, untilStep - this.step);
      const seen = new Map<string, PlayerState>();
      const floor = this.world.lowestTop - STEP_UP - 1;
      for (const state of this.states) {
        for (const input of choices(state, this.without)) {
          let p = state;
          // The press is on the first step only.
          for (let i = 1; i <= steps && p.alive; i++)
            p = stepPlayer(p, i === 1 ? input : NOTHING, this.world, (this.step + i) * PHYSICS_DT);
          if (!p.alive || p.y < floor) continue;
          const key = keyOf(p);
          if (seen.has(key)) continue;
          seen.set(key, p);
          if (this.trails && input !== NOTHING)
            this.trails.set(p, { input, step: this.step + 1, prev: this.trails.get(state) });
          else if (this.trails) {
            const trail = this.trails.get(state);
            if (trail) this.trails.set(p, trail);
          }
        }
      }
      this.step += steps;
      // Thinned per kind of candidate, so the ones with a dash still to use aren't crowded
      // out by the many that have spent theirs.
      const groups = new Map<string, PlayerState[]>();
      for (const p of seen.values()) {
        const kind = groupOf(p);
        const group = groups.get(kind);
        if (group) group.push(p);
        else groups.set(kind, [p]);
      }
      this.states = [];
      for (const [kind, group] of groups)
        this.states.push(...spread(group, kind === 'ground' ? KEEP_GROUNDED : KEEP_AIRBORNE));
      if (this.states.length > 0)
        this.furthest = { x: this.states[0]!.x, time: this.step * PHYSICS_DT };
    }
    return this.states.length > 0;
  }
}

export interface Validation {
  ok: boolean;
  /** How far into the song some way through got, in seconds. */
  reached: number;
  /** The furthest x a candidate got to. */
  furthestX: number;
}

/**
 * Whether a finished level can be survived from its start to the end of the song;
 * `without` an ability, to check where it is needed.
 */
export function validateLevel(level: PlatformerLevel, without?: Ability): Validation {
  const explorer = Explorer.start(new LevelWorld(level), without);
  const ok = explorer.run(stepAt(level.duration));
  return {
    ok,
    reached: ok ? level.duration : explorer.furthest.time,
    furthestX: explorer.furthest.x,
  };
}

/**
 * One way through the level, as the presses that make it: the input on each physics step
 * that has one (every other step is doing nothing). Null when the search finds none. For
 * playing a level by itself, to watch it or time its frames.
 */
export function solveLevel(level: PlatformerLevel): Map<number, PlayerInput> | null {
  const explorer = Explorer.start(new LevelWorld(level));
  explorer.trails = new WeakMap();
  if (!explorer.run(stepAt(level.duration))) return null;
  // Rather one on the ground: it has landed what it did.
  const end = explorer.states.find((s) => s.grounded) ?? explorer.states[0]!;
  const presses = new Map<number, PlayerInput>();
  for (let t = explorer.trails.get(end); t; t = t.prev) presses.set(t.step, t.input);
  return presses;
}
