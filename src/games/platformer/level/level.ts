import { beatAt, type Difficulty, type SectionKind, type TempoGrid } from '../../../core';
import {
  ANCHOR_X,
  EQ_EASE,
  scrollSpeed,
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
 * overhang: a wall hanging from the sky down to `bottom`, to slam (or hop low) under.
 */
export type SolidKind = 'ground' | 'step' | 'eq' | 'bridge' | 'ledge' | 'overhang';

export interface Solid {
  kind: SolidKind;
  x0: number;
  x1: number;
  /** Height of the top. For an equaliser, its height before its first key. */
  top: number;
  /** Overhangs: the underside. Other solids reach down into the pit. */
  bottom?: number;
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

/**
 * A dash gate: an orange barrier from its surface up into the sky, on a snare or an
 * accent (`time`). The player meets it `GATE_GRACE` later (`at`), so a dash pressed right
 * on the beat, or a little either side of it, gets through. Passing it without dashing
 * is a death; dashing smashes through.
 */
export interface Gate {
  x: number;
  /** The musical moment it stands for. */
  time: number;
  /** When the front of the player meets it. */
  at: number;
  /** The surface it stands on. */
  top: number;
}

/** How long after its beat the player meets a gate, in seconds. */
export const GATE_GRACE = 0.1;

/** An ability the player needs, taught in an easy spot: the first obstacle that needs it. */
export interface Lesson {
  action: 'dash' | 'slam';
  /** When the anchored player meets the obstacle, and when it is behind them. */
  time: number;
  end: number;
}

/** Abilities beyond jumping that an obstacle needs. */
export type Ability = Lesson['action'];

export type ChunkKind =
  | 'run-in'
  | 'flat'
  | 'calm'
  | 'gap'
  | 'dash-gap'
  | 'gate'
  | 'overhang'
  | 'eq'
  | 'bridge'
  | 'spikes'
  | 'drop'
  | 'run-out';

/** What each chunk kind needs beyond a jump. */
export const CHUNK_NEEDS: Partial<Record<ChunkKind, Ability>> = {
  'dash-gap': 'dash',
  gate: 'dash',
  overhang: 'slam',
};

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

/**
 * A piece of the scroll: from song time `t` the player's x is `x + v·dt + a·dt²/2`. Steady
 * through a tempo segment (`a` 0), easing from one segment's speed to the next over a beat.
 */
export interface ScrollPiece {
  t: number;
  x: number;
  /** Speed at `t`, px/s. */
  v: number;
  /** Change of speed, px/s². */
  a: number;
}

export interface PlatformerLevel {
  seed: number;
  difficulty: Difficulty;
  duration: number;
  /** The main tempo, for display. */
  tempo: number;
  /** The song's beat grid, following its tempo map. Spikes, scoring and the HUD follow it. */
  grid: TempoGrid;
  /** How the camera scrolls with song time, sorted by `t`: see `xAtTime`. */
  scroll: ScrollPiece[];
  /** Sorted by `x0`. */
  solids: Solid[];
  /** Sorted by `x0`. */
  spikes: SpikeStrip[];
  /** Sorted by `x`. */
  gates: Gate[];
  pickups: Pickup[];
  chunks: Chunk[];
  /** The first obstacle needing each ability, for the HUD's one-line hint. */
  lessons: Lesson[];
  /** Where the player starts, at song time 0. */
  start: { x: number; y: number };
  /** Surviving until the song ends finishes the level; this is where the player is then. */
  finishX: number;
}

/** The scroll piece at song time `t` (the first before the song). */
function pieceAt(scroll: readonly ScrollPiece[], t: number): ScrollPiece {
  let lo = 0;
  let hi = scroll.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (scroll[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return scroll[lo]!;
}

/**
 * Where the player is at song time `t`: the left edge of their box, always at the view's
 * anchor. Everything in the level is placed with it, and the physics takes the player's
 * x from it, so nothing else works out positions from the speed. The integral of the
 * scroll's speed, which follows the tempo map.
 */
export function xAtTime(level: Pick<PlatformerLevel, 'scroll'>, t: number): number {
  const p = pieceAt(level.scroll, t);
  const dt = t - p.t;
  return p.a === 0 ? p.v * dt + p.x : p.x + p.v * dt + 0.5 * p.a * dt * dt;
}

/** How fast the camera scrolls at song time `t`, px/s. */
export function speedAt(level: Pick<PlatformerLevel, 'scroll'>, t: number): number {
  const p = pieceAt(level.scroll, t);
  return p.v + p.a * (t - p.t);
}

/** The song time the player is at `x`: the inverse of `xAtTime`. */
export function timeAtX(level: Pick<PlatformerLevel, 'scroll'>, x: number): number {
  const scroll = level.scroll;
  let lo = 0;
  let hi = scroll.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (scroll[mid]!.x <= x) lo = mid;
    else hi = mid - 1;
  }
  const p = scroll[lo]!;
  const dx = x - p.x;
  if (p.a === 0) return p.t + dx / p.v;
  return p.t + (Math.sqrt(Math.max(0, p.v * p.v + 2 * p.a * dx)) - p.v) / p.a;
}

/** The camera's left edge at song time `t`. */
export function cameraAt(level: Pick<PlatformerLevel, 'scroll'>, t: number): number {
  return xAtTime(level, t) - ANCHOR_X;
}

/** Speeds closer than this share are one: the scroll doesn't ease between them. */
const SAME_SPEED = 0.01;

/** A scroll at one speed, px/s: the player at the anchor at song time 0. */
export function steadyScroll(speed: number): ScrollPiece[] {
  return [{ t: 0, x: ANCHOR_X, v: speed, a: 0 }];
}

/**
 * The scroll for a tempo map: each segment at `scrollSpeed` of its tempo, easing to the
 * next segment's speed over that segment's first beat, so a tempo change speeds the
 * player up or slows them down without a jerk. Segments that fold to the same speed (a
 * switch to half time) keep the speed they had.
 */
export function scrollFor(grid: Pick<TempoGrid, 'segments'>): ScrollPiece[] {
  const [first, ...rest] = grid.segments;
  const scroll = steadyScroll(scrollSpeed(first?.tempo ?? 0));
  for (const s of rest) {
    const last = scroll[scroll.length - 1]!;
    const v = scrollSpeed(s.tempo);
    // A switch to half or double time (or a nudge of the tempo) keeps the speed.
    if (Math.abs(v - last.v) < SAME_SPEED * last.v) continue;
    const ease = Math.min(s.beatPeriod, s.end - s.start);
    const from = { t: s.start, x: xAtTime({ scroll }, s.start), v: last.v, a: (v - last.v) / ease };
    scroll.push(from, {
      t: s.start + ease,
      x: xAtTime({ scroll: [from] }, s.start + ease),
      v,
      a: 0,
    });
  }
  return scroll;
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
export function spikesOut(level: Pick<PlatformerLevel, 'grid'>, t: number) {
  const beats = beatAt(level.grid, t);
  return beats - Math.floor(beats) >= 0.5;
}

/** The first index whose `x0` is at least `x`. */
export function lowerBound(items: { x0: number }[], x: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid]!.x0 < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** No surface of a generated level is lower than this. */
export const LOWEST_TOP = 0;

/** The longest a solid gets: longer ground is split, so lookups stay local. */
export const MAX_SOLID_WIDTH = 480;

/** The level as the physics sees it. The generator grows it a chunk at a time. */
export class LevelWorld implements PhysicsWorld {
  #lowest = Infinity;

  constructor(readonly level: PlatformerLevel) {
    for (const s of level.solids)
      this.#lowest = Math.min(this.#lowest, s.top, ...(s.keys ? s.keys.tops : []));
  }

  /**
   * The lowest any surface's top ever is: `LOWEST_TOP`, or lower in a hand-built level.
   * Feet more than a step below it can never land again, so the validator stops
   * following them. Never higher than `LOWEST_TOP`, so a level being built a stretch at a
   * time is searched just as the finished one is.
   */
  get lowestTop(): number {
    return Math.min(LOWEST_TOP, this.#lowest);
  }

  /** Add solids, spikes and gates past everything already there, splitting long ground. */
  add(solids: Solid[], spikes: SpikeStrip[] = [], gates: Gate[] = []): void {
    // Split first, then sort: an overhang overlaps the ground under it.
    const pieces: Solid[] = [];
    for (const s of solids) {
      const count = Math.ceil((s.x1 - s.x0) / MAX_SOLID_WIDTH);
      if (count <= 1) {
        pieces.push(s);
        continue;
      }
      const width = (s.x1 - s.x0) / count;
      for (let i = 0; i < count; i++)
        pieces.push({
          ...s,
          x0: s.x0 + i * width,
          x1: i === count - 1 ? s.x1 : s.x0 + (i + 1) * width,
        });
    }
    this.level.solids.push(...pieces.sort((a, b) => a.x0 - b.x0));
    for (const s of pieces)
      this.#lowest = Math.min(this.#lowest, s.top, ...(s.keys ? s.keys.tops : []));
    this.level.spikes.push(...[...spikes].sort((a, b) => a.x0 - b.x0));
    this.level.gates.push(...[...gates].sort((a, b) => a.x - b.x));
  }

  /** How much is there, to take a tentative chunk away again with `truncate`. */
  mark(): { solids: number; spikes: number; gates: number } {
    const { solids, spikes, gates } = this.level;
    return { solids: solids.length, spikes: spikes.length, gates: gates.length };
  }

  truncate(mark: { solids: number; spikes: number; gates: number }): void {
    this.level.solids.length = mark.solids;
    this.level.spikes.length = mark.spikes;
    this.level.gates.length = mark.gates;
  }

  xAt(t: number): number {
    return xAtTime(this.level, t);
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

  bottomOf(solid: number): number {
    return this.level.solids[solid]!.bottom ?? -Infinity;
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

  gateBetween(x0: number, x1: number): boolean {
    const gates = this.level.gates;
    // The first gate past x0.
    let lo = 0;
    let hi = gates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (gates[mid]!.x <= x0) lo = mid + 1;
      else hi = mid;
    }
    return lo < gates.length && gates[lo]!.x <= x1;
  }
}
