import {
  canJump,
  PHYSICS_DT,
  PLAYER_WIDTH,
  startState,
  stepPlayer,
  type PlayerInput,
  type PlayerState,
} from '../physics';
import { LevelWorld, type PlatformerLevel } from './level';

/**
 * Proves a level can be finished by finding a way through it: a search over the player's
 * inputs, run through the same `stepPlayer` the game uses, against the level's moving
 * parts at the song time they happen.
 *
 * Every few physics steps each candidate player tries running left, standing and running
 * right, each with and without a jump. Candidates that end up in the same place are
 * merged, and the rest are thinned evenly by position, so the search stays small. That
 * only ever misses ways through, never invents one: a level it passes is finishable, and
 * one it fails is made easier.
 */

/** Physics steps between decisions: the player changes input up to 20 times a second. */
export const DECISION_STEPS = 3;
/** Candidates kept on the ground, and in the air. */
const KEEP_GROUNDED = 24;
const KEEP_AIRBORNE = 24;

const INPUTS: PlayerInput[] = [];
for (const dir of [1, 0, -1] as const) for (const jump of [false, true]) INPUTS.push({ dir, jump });

/** The step a song time falls on. */
export function stepAt(time: number): number {
  return Math.round(time / PHYSICS_DT);
}

function keyOf(p: PlayerState): string {
  const x = Math.round(p.x / 6);
  if (p.grounded) return `g${p.surface}:${x}`;
  return `a${x}:${Math.round(p.y / 12)}:${Math.round(p.vy / 150)}:${canJump(p) ? 1 : 0}`;
}

/** Up to `n` of the states, evenly spread from left to right. */
function spread(states: PlayerState[], n: number): PlayerState[] {
  if (states.length <= n) return states;
  states.sort((a, b) => a.x - b.x || a.y - b.y);
  const out: PlayerState[] = [];
  for (let i = 0; i < n; i++) out.push(states[Math.floor(((i + 0.5) * states.length) / n)]!);
  return out;
}

/** The candidates at one moment, and how they go on. */
export class Explorer {
  constructor(
    readonly world: LevelWorld,
    public states: PlayerState[],
    public step: number,
    /** Where the furthest candidate got, and how the last ones died. */
    public furthest = { x: 0, time: 0 },
  ) {}

  static start(world: LevelWorld): Explorer {
    const { x, y } = world.level.start;
    const first = startState(x, y);
    const support = world.solidsBetween(x, x + 1)[0];
    return new Explorer(world, [{ ...first, surface: support ?? -1 }], 0);
  }

  clone(): Explorer {
    return new Explorer(this.world, this.states, this.step, { ...this.furthest });
  }

  get alive(): boolean {
    return this.states.length > 0;
  }

  get anyGrounded(): boolean {
    return this.states.some((s) => s.grounded);
  }

  /**
   * Search on until `untilStep` (or until no candidate is left). True when one survives.
   * Candidates that reach past `limitX`, where the level isn't built yet, are dropped:
   * so every candidate kept is one the finished level really allows.
   */
  run(untilStep: number, limitX = Infinity): boolean {
    while (this.step < untilStep && this.states.length > 0) {
      const steps = Math.min(DECISION_STEPS, untilStep - this.step);
      const seen = new Map<string, PlayerState>();
      for (const state of this.states) {
        for (const input of INPUTS) {
          if (input.jump && !canJump(state)) continue;
          // Standing still covers waiting on the ground; running back only helps in the air.
          if (input.dir < 0 && state.grounded) continue;
          let p = state;
          for (let i = 1; i <= steps && p.alive; i++) {
            // The jump is pressed on the first step only.
            const held = i === 1 ? input : { dir: input.dir, jump: false };
            p = stepPlayer(p, held, this.world, (this.step + i) * PHYSICS_DT);
          }
          if (!p.alive || p.x + PLAYER_WIDTH > limitX) continue;
          const key = keyOf(p);
          if (!seen.has(key)) seen.set(key, p);
        }
      }
      this.step += steps;
      const next = [...seen.values()];
      this.states = [
        ...spread(
          next.filter((s) => s.grounded),
          KEEP_GROUNDED,
        ),
        ...spread(
          next.filter((s) => !s.grounded),
          KEEP_AIRBORNE,
        ),
      ];
      for (const s of this.states)
        if (s.x > this.furthest.x) this.furthest = { x: s.x, time: this.step * PHYSICS_DT };
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

/** Whether a finished level can be survived from its start to the end of the song. */
export function validateLevel(level: PlatformerLevel): Validation {
  const explorer = Explorer.start(new LevelWorld(level));
  const ok = explorer.run(stepAt(level.duration));
  return {
    ok,
    reached: ok ? level.duration : explorer.step * PHYSICS_DT,
    furthestX: explorer.furthest.x,
  };
}
