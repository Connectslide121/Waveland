import type { Difficulty, SectionKind } from '../../../core';
import {
  ANCHOR_X,
  EQ_EASE,
  SPIKE_HEIGHT,
  SPIKE_MERCY,
  VIEW_WIDTH,
  type PhysicsWorld,
} from '../physics';

/**
 * The platformer's level in world space: what is where, and when the moving parts move.
 * Heights grow upward from the level's base line (see `physics.ts`).
 */

/**
 * ground: a column of ground, from its top down into the pit.
 * step: a bar of the drop staircase (a column too).
 * eq: an equaliser column whose height follows the bass.
 * bridge: a thin slab over a pit, there only after snare hits.
 * ledge: a thin slab added to make a jump possible.
 */
export type SolidKind = 'ground' | 'step' | 'eq' | 'bridge' | 'ledge';

export interface Solid {
  kind: SolidKind;
  x0: number;
  x1: number;
  /** Height of the top. For an equaliser, its height before its first key. */
  top: number;
  /** Equalisers: from each time on, the top eases to the matching height. */
  keys?: { times: number[]; tops: number[] };
  /** Bridges: the spans of song time they are there, [from, to]. */
  windows?: [number, number][];
}

/** A strip of spikes on a surface: out on the off-beats, back in on the beat. */
export interface SpikeStrip {
  x0: number;
  x1: number;
  /** The surface they stand on. */
  top: number;
}

/** Something to pick up: a coin on a hi-hat, a gem in a drop's set piece. */
export interface Pickup {
  kind: 'coin' | 'gem';
  x: number;
  y: number;
  /** The song moment it belongs to. */
  time: number;
}

export type ChunkKind =
  'run-in' | 'flat' | 'calm' | 'gap' | 'eq' | 'bridge' | 'spikes' | 'drop' | 'run-out';

/** A stretch of the level, a bar or two long, built from one idea. */
export interface Chunk {
  kind: ChunkKind;
  /** What the generator first wanted here, when a repair changed it. */
  planned: ChunkKind;
  start: number;
  end: number;
  x0: number;
  x1: number;
  section: SectionKind;
  /** How many times the validator sent it back to be made easier. */
  repairs: number;
}

export interface PlatformerLevel {
  seed: number;
  difficulty: Difficulty;
  duration: number;
  tempo: number;
  /** The beat grid: first beat and seconds per beat. Spikes follow it. */
  gridStart: number;
  beatPeriod: number;
  /** How fast the camera scrolls, px/s. */
  speed: number;
  /** Sorted by `x0`. */
  solids: Solid[];
  /** Sorted by `x0`. */
  spikes: SpikeStrip[];
  pickups: Pickup[];
  chunks: Chunk[];
  /** Where the player starts, at song time 0. */
  start: { x: number; y: number };
  /** Surviving until the song ends finishes the level; this is where the player is then. */
  finishX: number;
}

/** Where a player exactly in time with the music is at song time `t`. */
export function xAtTime(level: Pick<PlatformerLevel, 'speed'>, t: number): number {
  return level.speed * t + ANCHOR_X;
}

/** Top of a solid at time `t`, or null when it isn't there. */
export function solidTop(solid: Solid, t: number): number | null {
  if (solid.windows) {
    for (const [from, to] of solid.windows) if (t >= from && t <= to) return solid.top;
    return null;
  }
  const keys = solid.keys;
  if (!keys || keys.times.length === 0 || t < keys.times[0]!) return solid.top;
  // The last key at or before t, eased from the one before it.
  let lo = 0;
  let hi = keys.times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys.times[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  const from = lo > 0 ? keys.tops[lo - 1]! : solid.top;
  const to = keys.tops[lo]!;
  const progress = Math.min(1, (t - keys.times[lo]!) / EQ_EASE);
  return from + (to - from) * progress;
}

/** True when spikes are out at `t`: from each off-beat until the next beat. */
export function spikesOut(level: Pick<PlatformerLevel, 'gridStart' | 'beatPeriod'>, t: number) {
  const beats = (t - level.gridStart) / level.beatPeriod;
  return beats - Math.floor(beats) >= 0.5;
}

/** The first index whose `x0` is at least `x`. */
function lowerBound(items: { x0: number }[], x: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid]!.x0 < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The longest a solid gets: longer ground is split, so lookups stay local. */
export const MAX_SOLID_WIDTH = 480;

/** The level as the physics sees it. The generator grows it a chunk at a time. */
export class LevelWorld implements PhysicsWorld {
  constructor(readonly level: PlatformerLevel) {}

  /** Add solids and spikes past everything already there, splitting long ground. */
  add(solids: Solid[], spikes: SpikeStrip[] = []): void {
    for (const s of [...solids].sort((a, b) => a.x0 - b.x0)) {
      if (s.x1 - s.x0 <= MAX_SOLID_WIDTH) {
        this.level.solids.push(s);
        continue;
      }
      const pieces = Math.ceil((s.x1 - s.x0) / MAX_SOLID_WIDTH);
      const width = (s.x1 - s.x0) / pieces;
      for (let i = 0; i < pieces; i++)
        this.level.solids.push({
          ...s,
          x0: s.x0 + i * width,
          x1: i === pieces - 1 ? s.x1 : s.x0 + (i + 1) * width,
        });
    }
    this.level.spikes.push(...[...spikes].sort((a, b) => a.x0 - b.x0));
  }

  /** How much is there, to take a tentative chunk away again with `truncate`. */
  mark(): { solids: number; spikes: number } {
    return { solids: this.level.solids.length, spikes: this.level.spikes.length };
  }

  truncate(mark: { solids: number; spikes: number }): void {
    this.level.solids.length = mark.solids;
    this.level.spikes.length = mark.spikes;
  }

  /** Reused by `solidsBetween`, which runs several times every physics step. */
  readonly #found: number[] = [];

  solidsBetween(x0: number, x1: number): number[] {
    const solids = this.level.solids;
    const found = this.#found;
    found.length = 0;
    for (let i = lowerBound(solids, x0 - MAX_SOLID_WIDTH); i < solids.length; i++) {
      const s = solids[i]!;
      if (s.x0 >= x1) break;
      if (s.x1 > x0) found.push(i);
    }
    return found;
  }

  topAt(solid: number, t: number): number | null {
    return solidTop(this.level.solids[solid]!, t);
  }

  isSlab(solid: number): boolean {
    const kind = this.level.solids[solid]!.kind;
    return kind === 'bridge' || kind === 'ledge';
  }

  solidX(solid: number): { x0: number; x1: number } {
    return this.level.solids[solid]!;
  }

  spikesHit(x0: number, x1: number, y0: number, y1: number, t: number): boolean {
    if (!spikesOut(this.level, t)) return false;
    const spikes = this.level.spikes;
    for (let i = lowerBound(spikes, x0 - VIEW_WIDTH); i < spikes.length; i++) {
      const s = spikes[i]!;
      if (s.x0 + SPIKE_MERCY >= x1) break;
      if (s.x1 - SPIKE_MERCY <= x0) continue;
      if (y0 < s.top + SPIKE_HEIGHT - SPIKE_MERCY && y1 > s.top) return true;
    }
    return false;
  }

  leftEdge(t: number): number {
    return this.level.speed * t;
  }

  rightEdge(t: number): number {
    return this.level.speed * t + VIEW_WIDTH;
  }
}
