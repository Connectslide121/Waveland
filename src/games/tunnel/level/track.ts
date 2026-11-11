import {
  type Difficulty,
  type LevelMap,
  type SectionFeel,
  type SectionKind,
  type TempoGrid,
} from '../../../core';
import { BLOCK_DEPTH, type RacerObstacle, type RacerWorld } from '../physics';

/**
 * The tunnel's track: pure data built from the core's `LevelMap`, the same for the same
 * song and difficulty. Down the tunnel is `z` (track units, a lane is one unit wide),
 * reached from song time by `zAtTime`; the centreline bends and climbs with the melody
 * (`path`); each section has its look (`looks`); the bass pulses it (`pulse`, visual
 * only); obstacles and pickups sit on the music's moments.
 */

/**
 * What an obstacle is, by the musical moment it comes from (the grammar in
 * `generate.ts`): a block on a kick, a block opposite it on a snare, a wall with a gap on
 * an accent, a low wall on the strongest accents, a wall with a gap where the band comes
 * back after a stop, a sliding block on a syncopation, a slalom block on a fill's hit, and
 * a squeeze: three walls on the last bar of a build, each leaving a narrower way open.
 */
export type ObstacleKind =
  'kick' | 'snare' | 'wall' | 'low' | 'stop' | 'slide' | 'slalom' | 'squeeze';

/** One obstacle: where it is for the physics, and why it is there. */
export interface Obstacle extends RacerObstacle {
  kind: ObstacleKind;
  /** Its musical moment: the racer's front meets it then. */
  time: number;
  /** What it is, in words: "Wall". */
  label: string;
  /** Its musical reason, in words: "accent". */
  reason: string;
  /** The song's bar (from 1) it repeats, when the song plays that bar again here. */
  repeats?: number;
}

/**
 * Something to pick up: a gem (magenta) on a hi-hat, an off-beat or a drop's beat, or a
 * gem of a rail along a held note.
 */
export interface Pickup {
  kind: 'gem' | 'rail';
  time: number;
  z: number;
  lane: number;
}

/** What a booster pickup gives: see `run.ts`. */
export type BoosterKind = 'magnet' | 'shield' | 'surge';

/**
 * A booster to collect, on a section's first phrase: never needed, so the validator never
 * sees it.
 */
export interface Booster {
  kind: BoosterKind;
  time: number;
  z: number;
  lane: number;
}

/**
 * A boost hoop (magenta): flown through in its lane for points. The hoops of one phrase
 * (a chorus's or a drop's first four downbeats) share a `group`; flying through every
 * one earns a streak bonus. A fill's slalom ends in a single hoop on the bar line.
 */
export interface Hoop {
  kind: 'phrase' | 'fill';
  time: number;
  z: number;
  lane: number;
  group: number;
  /** Which of the group's `size` hoops this is, from 0. */
  slot: number;
  size: number;
}

/**
 * A held sound to ride: a rail of pickups along one lane while a note holds, or a
 * tunnel-wide ring of light while a chord (or a cymbal) rings.
 */
export interface Hold {
  kind: 'rail' | 'ring';
  sound: 'note' | 'chord' | 'ring';
  time: number;
  end: number;
  z0: number;
  z1: number;
  /** The rail's lane; null for a ring across every lane. */
  lane: number | null;
}

/** A stop: the tunnel goes dark and empty from `time` until the band comes back at `end`. */
export interface Dark {
  time: number;
  end: number;
}

/**
 * A piece of the run: from song time `t` the racer is at `z + v·dt + a·dt²/2`. Steady
 * through a tempo segment (`a` 0), easing from one segment's speed to the next over a beat.
 */
export interface RunPiece {
  t: number;
  z: number;
  /** Speed at `t`, units/s. */
  v: number;
  /** Change of speed, units/s². */
  a: number;
}

/**
 * A point of the centreline, one per grid beat: where it is (`x` across, `y` up, `z`
 * down the tunnel) and which way it heads across (radians, positive to the right).
 */
export interface PathPoint {
  time: number;
  z: number;
  x: number;
  y: number;
  heading: number;
}

/** How a section looks: the tube's width and how its rings go, from the section's feel. */
export interface SectionLook {
  start: number;
  end: number;
  feel: SectionFeel;
  /** The tube's radius as a share of the usual, at the section's start and its end. */
  radius: number;
  radiusEnd: number;
  /** Beats between the rings of light running down the tube. */
  ringBeats: number;
  /** How bright the tube glows, 0 to 1. */
  glow: number;
  /** Ring walls on every beat (a chorus). */
  ringWalls: boolean;
  /** How fast the ring walls turn, radians a beat (0: they stand still). */
  spin: number;
  /** How much further the tube opens on each downbeat, a share of its radius (the drop). */
  burst: number;
  /** A starfield of dim points in the tube: 0 for none, 1 in calm parts and breakdowns. */
  stars: number;
}

/** What makes the tunnel pulse with the bass: visual only, it never moves a lane. */
export interface Pulse {
  /** Bass energy per grid beat, 0 to 1 over the song's own range. */
  bass: number[];
  /** Every kick, with how hard it hits. */
  kicks: { time: number; strength: number }[];
}

/** A stretch of the track, a bar or a few long, and how many repairs it took. */
export interface Chunk {
  start: number;
  end: number;
  section: SectionKind;
  feel: SectionFeel;
  /** Obstacles the grammar planned for it, and those it kept. */
  planned: number;
  kept: number;
  /** How many times the validator sent it back to be made easier. */
  repairs: number;
}

export interface TunnelTrack {
  seed: number;
  difficulty: Difficulty;
  duration: number;
  /** The main tempo, for display. */
  tempo: number;
  /** The song's beat grid, following its tempo map. */
  grid: TempoGrid;
  /** How many lanes: 3 on easy, 5 on normal and hard. */
  lanes: number;
  /** How far down the tunnel the racer is with song time, sorted by `t`: see `zAtTime`. */
  run: RunPiece[];
  /** The centreline, one point per grid beat (and one at song time 0 when that is earlier). */
  path: PathPoint[];
  /** Each section's look, in order. */
  looks: SectionLook[];
  pulse: Pulse;
  /** Sorted by `z0`. */
  obstacles: Obstacle[];
  /** Sorted by time. */
  pickups: Pickup[];
  /** Boosters to collect, sorted by time: at most one a section, several bars apart. */
  boosters: Booster[];
  /** Boost hoops, sorted by time. */
  hoops: Hoop[];
  holds: Hold[];
  dark: Dark[];
  chunks: Chunk[];
  /** The lane the racer starts in, at song time 0. */
  startLane: number;
  /** Where the racer is when the song ends. */
  finishZ: number;
}

// ---------- the run: song time to distance ----------

/** The track covers this many units per beat at a tempo folded into 80–160 BPM. */
export const Z_PER_FOLDED_BEAT = 6;

/**
 * How fast the racer goes for a tempo, units/s. Fast songs count in half time and slow
 * ones in double time, so the speed stays between 8 and 16 units/s.
 */
export function runSpeed(tempo: number): number {
  let bpm = tempo > 0 ? tempo : 120;
  while (bpm >= 160) bpm /= 2;
  while (bpm < 80) bpm *= 2;
  return (Z_PER_FOLDED_BEAT * bpm) / 60;
}

/** The run piece at song time `t` (the first before the song). */
function pieceAt(run: readonly RunPiece[], t: number): RunPiece {
  let lo = 0;
  let hi = run.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (run[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return run[lo]!;
}

/**
 * How far down the tunnel the racer's front is at song time `t`: the integral of the
 * run's speed, which follows the tempo map. Everything on the track is placed with it,
 * and the physics takes the racer's z from it.
 */
export function zAtTime(track: Pick<TunnelTrack, 'run'>, t: number): number {
  const p = pieceAt(track.run, t);
  const dt = t - p.t;
  return p.z + p.v * dt + 0.5 * p.a * dt * dt;
}

/** How fast the racer goes at song time `t`, units/s. */
export function speedAt(track: Pick<TunnelTrack, 'run'>, t: number): number {
  const p = pieceAt(track.run, t);
  return p.v + p.a * (t - p.t);
}

/** The song time the racer's front is at `z`: the inverse of `zAtTime`. */
export function timeAtZ(track: Pick<TunnelTrack, 'run'>, z: number): number {
  const run = track.run;
  let lo = 0;
  let hi = run.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (run[mid]!.z <= z) lo = mid;
    else hi = mid - 1;
  }
  const p = run[lo]!;
  const dz = z - p.z;
  if (p.a === 0) return p.t + dz / p.v;
  return p.t + (Math.sqrt(Math.max(0, p.v * p.v + 2 * p.a * dz)) - p.v) / p.a;
}

/** Speeds closer than this share are one: the run doesn't ease between them. */
const SAME_SPEED = 0.01;

/** A run at one speed, units/s, from z 0 at song time 0. */
export function steadyRun(speed: number): RunPiece[] {
  return [{ t: 0, z: 0, v: speed, a: 0 }];
}

/**
 * The run for a tempo map: each segment at `runSpeed` of its tempo, easing to the next
 * segment's speed over that segment's first beat (the platformer's scroll's scheme).
 * Segments that fold to the same speed (a switch to half time) keep the speed they had.
 */
export function runFor(grid: Pick<TempoGrid, 'segments'>): RunPiece[] {
  const [first, ...rest] = grid.segments;
  const run = steadyRun(runSpeed(first?.tempo ?? 0));
  for (const s of rest) {
    const last = run[run.length - 1]!;
    const v = runSpeed(s.tempo);
    if (Math.abs(v - last.v) < SAME_SPEED * last.v) continue;
    const ease = Math.min(s.beatPeriod, s.end - s.start);
    const from = { t: s.start, z: zAtTime({ run }, s.start), v: last.v, a: (v - last.v) / ease };
    run.push(from, { t: s.start + ease, z: zAtTime({ run: [from] }, s.start + ease), v, a: 0 });
  }
  return run;
}

// ---------- the path: the melody bends and climbs it ----------

/** How high the melody's top lifts the centreline over its bottom, units. */
export const CLIMB_RANGE = 4;
/** The centreline climbs at most this much a beat, units. */
export const MAX_CLIMB = 0.35;
/** Share of the way to the melody's height the centreline climbs each beat. */
const CLIMB_EASE = 0.35;
/** How fast a rising or falling melody turns the path: radians of heading a beat. */
export const MAX_TURN = 0.04;
/** Share of the way to its turn the path gets each beat, so bends come in gently. */
const TURN_EASE = 0.3;
/**
 * The path never heads further off straight than this, radians. With `MAX_TURN` it keeps
 * the far end of the tunnel on screen: eight beats ahead it has turned 0.32 at most.
 */
export const MAX_HEADING = 0.3;
/** Share of its heading a held note, or no melody, straightens each beat. */
const STRAIGHTEN = 0.15;

/**
 * The centreline, one point per grid beat. The melody's height (`LevelMap.mood.melody`)
 * sets the climb, eased and capped; its movement the bend: rising turns right, falling
 * left, a held note straightens. Where no melody is heard (`melodyMove` none) the path
 * has no climb or bend of its own: it holds the last heard height and straightens.
 */
export function pathFor(map: LevelMap, run: RunPiece[]): PathPoint[] {
  const z = (t: number) => zAtTime({ run }, t);
  const melody = map.mood?.melody ?? [];
  const moves = map.mood?.melodyMove ?? [];
  const path: PathPoint[] = [];
  let heard = melody[0] ?? 0.5;
  let y = heard * CLIMB_RANGE;
  let turn = 0;
  let heading = 0;
  let x = 0;
  map.beats.forEach((time, i) => {
    const move = moves[i] ?? 'none';
    if (move !== 'none') heard = melody[i] ?? heard;
    const prev = path[path.length - 1];
    if (prev) {
      x += Math.sin(prev.heading) * (z(time) - prev.z);
      const climb = (heard * CLIMB_RANGE - y) * CLIMB_EASE;
      y += Math.max(-MAX_CLIMB, Math.min(MAX_CLIMB, climb));
      const want = move === 'rising' ? MAX_TURN : move === 'falling' ? -MAX_TURN : 0;
      turn += (want - turn) * TURN_EASE;
      heading += turn;
      if (move === 'held' || move === 'none') heading *= 1 - STRAIGHTEN;
      heading = Math.max(-MAX_HEADING, Math.min(MAX_HEADING, heading));
    }
    path.push({ time, z: z(time), x, y, heading });
  });
  const first = path[0];
  if (!first) return [{ time: 0, z: 0, x: 0, y, heading: 0 }];
  if (first.time > 0) path.unshift({ ...first, time: 0, z: 0 });
  return path;
}

/** The centreline at `z`, between its points (straight on before the first and past the last). */
export function pathAt(track: Pick<TunnelTrack, 'path'>, z: number): PathPoint {
  const path = track.path;
  let lo = 0;
  let hi = path.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (path[mid]!.z <= z) lo = mid;
    else hi = mid - 1;
  }
  const a = path[lo]!;
  const b = path[lo + 1];
  if (!b || z <= a.z) {
    const dz = z - a.z;
    return { ...a, z, x: a.x + Math.sin(a.heading) * dz };
  }
  const f = (z - a.z) / (b.z - a.z);
  const mix = (u: number, v: number) => u + (v - u) * f;
  return {
    time: mix(a.time, b.time),
    z,
    x: mix(a.x, b.x),
    y: mix(a.y, b.y),
    heading: mix(a.heading, b.heading),
  };
}

// ---------- looks per section ----------

/**
 * Each feel's look: calm parts and breakdowns open into a wide tube with sparse rings and
 * a starfield, grooves are steady, choruses tighten and brighten with ring walls that turn
 * with the beat, builds narrow as they go and speed the rings up, the drop bursts open and
 * opens wider still on every downbeat.
 */
const LOOK_OF_FEEL: Record<SectionFeel, Omit<SectionLook, 'start' | 'end' | 'feel'>> = {
  calm: {
    radius: 1.35,
    radiusEnd: 1.35,
    ringBeats: 4,
    glow: 0.45,
    ringWalls: false,
    spin: 0,
    burst: 0,
    stars: 1,
  },
  breakdown: {
    radius: 1.35,
    radiusEnd: 1.35,
    ringBeats: 4,
    glow: 0.4,
    ringWalls: false,
    spin: 0,
    burst: 0,
    stars: 1,
  },
  groove: {
    radius: 1,
    radiusEnd: 1,
    ringBeats: 1,
    glow: 0.65,
    ringWalls: false,
    spin: 0,
    burst: 0,
    stars: 0,
  },
  chorus: {
    radius: 0.9,
    radiusEnd: 0.9,
    ringBeats: 1,
    glow: 0.9,
    ringWalls: true,
    spin: 0.3,
    burst: 0.03,
    stars: 0,
  },
  build: {
    radius: 1,
    radiusEnd: 0.8,
    ringBeats: 0.5,
    glow: 0.75,
    ringWalls: false,
    spin: 0,
    burst: 0,
    stars: 0,
  },
  drop: {
    radius: 1.5,
    radiusEnd: 1.5,
    ringBeats: 1,
    glow: 1,
    ringWalls: false,
    spin: 0,
    burst: 0.1,
    stars: 0,
  },
};

/** The feel of a section by its kind, for a map without moods. */
export const FEEL_OF_KIND: Record<SectionKind, SectionFeel> = {
  intro: 'calm',
  outro: 'calm',
  breakdown: 'breakdown',
  build: 'build',
  drop: 'drop',
  main: 'groove',
};

/** Every section's look, from its feel. */
export function looksFor(map: LevelMap): SectionLook[] {
  return map.sections.map((s, i) => {
    const feel = map.moods?.[i]?.feel ?? FEEL_OF_KIND[s.kind];
    return { start: s.start, end: s.end, feel, ...LOOK_OF_FEEL[feel] };
  });
}

/** The bass pulse: the bass per beat and every kick. */
export function pulseFor(map: LevelMap): Pulse {
  return {
    bass: [...map.bass],
    kicks: map.events
      .filter((e) => e.kind === 'kick')
      .map((e) => ({ time: e.time, strength: e.intensity })),
  };
}

// ---------- the track as the physics sees it ----------

/** The first index whose `z0` is at least `z`. */
function lowerBound(items: readonly { z0: number }[], z: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid]!.z0 < z) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The track as the physics sees it. The generator grows it a stretch at a time. */
export class TrackWorld implements RacerWorld {
  constructor(readonly track: TunnelTrack) {}

  get lanes(): number {
    return this.track.lanes;
  }

  /** Add obstacles past everything already there. */
  add(obstacles: Obstacle[]): void {
    this.track.obstacles.push(...[...obstacles].sort((a, b) => a.z0 - b.z0));
  }

  /** How many obstacles there are, to take a tentative stretch away again with `truncate`. */
  mark(): number {
    return this.track.obstacles.length;
  }

  truncate(mark: number): void {
    this.track.obstacles.length = mark;
  }

  zAt(t: number): number {
    return zAtTime(this.track, t);
  }

  /** Reused by `obstaclesBetween`, which runs every physics step. */
  readonly #found: number[] = [];

  obstaclesBetween(z0: number, z1: number): number[] {
    const obstacles = this.track.obstacles;
    const found = this.#found;
    found.length = 0;
    for (let i = lowerBound(obstacles, z0 - BLOCK_DEPTH); i < obstacles.length; i++) {
      const o = obstacles[i]!;
      if (o.z0 >= z1) break;
      if (o.z1 > z0) found.push(i);
    }
    return found;
  }

  obstacle(i: number): Obstacle {
    return this.track.obstacles[i]!;
  }
}
