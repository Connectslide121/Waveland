import {
  LANE_HOP_TIME,
  PHYSICS_DT,
  startRacer,
  stepRacer,
  type RacerInput,
  type RacerState,
} from '../physics';
import { TrackWorld, type TunnelTrack } from './track';

/**
 * Proves a track can be raced through without a crash by finding a way: a search over
 * the racer's inputs, run through the same `stepRacer` the game uses, against the track's
 * obstacles at the song time they are met.
 *
 * The racer's z comes from song time, so every candidate at a moment is at the same z: a
 * candidate is only its lane, where it is in a hop, and its height and speed in a jump.
 * Every few physics steps each one tries doing nothing, hopping left, hopping right and
 * jumping. A candidate that crashes is dropped (the run must be clean); candidates in the
 * same state are merged and the rest thinned evenly, so the search stays small. That only
 * ever misses ways through, never invents one: a track it passes can be raced clean.
 */

/** Physics steps between decisions: the player changes input up to 20 times a second. */
export const DECISION_STEPS = 3;
/** Candidates kept besides those settled in a lane on the floor. */
const KEEP = 40;
/**
 * A new hop is only pressed once the one under way is this far through: the search never
 * leans on presses faster than a player's.
 */
const HOP_AGAIN = 0.5;

const NOTHING: RacerInput = {};
const LEFT: RacerInput = { left: true };
const RIGHT: RacerInput = { right: true };
const JUMP: RacerInput = { jump: true };

/** What a candidate can do at a decision: only what changes something. */
function choices(p: RacerState, lanes: number): RacerInput[] {
  const out = [NOTHING];
  const hopReady = p.hopLeft <= LANE_HOP_TIME * (1 - HOP_AGAIN) + 1e-9;
  if (hopReady && p.lane > 0) out.push(LEFT);
  if (hopReady && p.lane < lanes - 1) out.push(RIGHT);
  if (p.grounded) out.push(JUMP);
  return out;
}

/** The step a song time falls on. */
export function stepAt(time: number): number {
  return Math.round(time / PHYSICS_DT);
}

function keyOf(p: RacerState): string {
  const hop = `${p.lane}:${Math.round(p.pos * 16)}:${Math.round(p.hopLeft / PHYSICS_DT)}`;
  return p.grounded ? `${hop}:g` : `${hop}:${Math.round(p.y * 20)}:${Math.round(p.vy)}`;
}

/** Settled: on the floor in its lane, free to do anything. */
const settled = (p: RacerState) => p.grounded && p.hopLeft === 0;

/** Up to `n` of the states, evenly spread across the tunnel and in height. */
function spread(states: RacerState[], n: number): RacerState[] {
  if (states.length <= n) return states;
  states.sort((a, b) => a.pos - b.pos || a.y - b.y);
  const out: RacerState[] = [];
  for (let i = 0; i < n; i++) out.push(states[Math.floor(((i + 0.5) * states.length) / n)]!);
  return out;
}

/** How a candidate got where it is: its last press, on which step, and the one before. */
interface Trail {
  input: RacerInput;
  step: number;
  prev: Trail | undefined;
}

/** The candidates at one moment, and how they go on. */
export class Explorer {
  /** When kept (`solveLevel`), how each candidate got there. */
  trails: WeakMap<RacerState, Trail> | null = null;

  constructor(
    readonly world: TrackWorld,
    public states: RacerState[],
    public step: number,
    /** When the last surviving candidates were. */
    public furthest = 0,
  ) {}

  static start(world: TrackWorld): Explorer {
    return new Explorer(world, [startRacer(world.track.startLane, world.zAt(0))], 0);
  }

  clone(): Explorer {
    const copy = new Explorer(this.world, this.states, this.step, this.furthest);
    copy.trails = this.trails;
    return copy;
  }

  get alive(): boolean {
    return this.states.length > 0;
  }

  /** The lanes some candidate is settled in. */
  settledLanes(): Set<number> {
    return new Set(this.states.filter(settled).map((p) => p.lane));
  }

  /** Search on until `untilStep` (or until no candidate is left). True when one survives. */
  run(untilStep: number): boolean {
    const lanes = this.world.lanes;
    while (this.step < untilStep && this.states.length > 0) {
      const steps = Math.min(DECISION_STEPS, untilStep - this.step);
      const seen = new Map<string, RacerState>();
      for (const state of this.states) {
        for (const input of choices(state, lanes)) {
          let p = state;
          let clean = true;
          // The press is on the first step only.
          for (let i = 1; i <= steps && clean; i++) {
            p = stepRacer(p, i === 1 ? input : NOTHING, this.world, (this.step + i) * PHYSICS_DT);
            clean = p.crash < 0;
          }
          if (!clean) continue;
          const key = keyOf(p);
          if (seen.has(key)) continue;
          seen.set(key, p);
          if (!this.trails) continue;
          if (input !== NOTHING)
            this.trails.set(p, { input, step: this.step + 1, prev: this.trails.get(state) });
          else {
            const trail = this.trails.get(state);
            if (trail) this.trails.set(p, trail);
          }
        }
      }
      this.step += steps;
      // Every settled candidate stays (one a lane at most); the rest are thinned.
      const all = [...seen.values()];
      this.states = [
        ...all.filter(settled),
        ...spread(
          all.filter((p) => !settled(p)),
          KEEP,
        ),
      ];
      if (this.states.length > 0) this.furthest = this.step * PHYSICS_DT;
    }
    return this.states.length > 0;
  }
}

export interface Validation {
  ok: boolean;
  /** How far into the song some clean way got, in seconds. */
  reached: number;
}

/** Whether a finished track can be raced from its start to the end of the song without a crash. */
export function validateLevel(track: TunnelTrack): Validation {
  const explorer = Explorer.start(new TrackWorld(track));
  const ok = explorer.run(stepAt(track.duration));
  return { ok, reached: ok ? track.duration : explorer.furthest };
}

/**
 * One clean way through the track, as the presses that make it: the input on each
 * physics step that has one (every other step is doing nothing). Null when the search
 * finds none. For playing a track by itself, to watch it or time its frames.
 */
export function solveLevel(track: TunnelTrack): Map<number, RacerInput> | null {
  const explorer = Explorer.start(new TrackWorld(track));
  explorer.trails = new WeakMap();
  if (!explorer.run(stepAt(track.duration))) return null;
  // Rather one settled in a lane: it has finished what it did.
  const end = explorer.states.find(settled) ?? explorer.states[0]!;
  const presses = new Map<number, RacerInput>();
  for (let t = explorer.trails.get(end); t; t = t.prev) presses.set(t.step, t.input);
  return presses;
}
