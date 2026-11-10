import {
  beatIndexAt,
  hashOf,
  Random,
  type Difficulty,
  type LevelMap,
  type SectionKind,
} from '../../../core';
import {
  ANCHOR_X,
  GRAVITY,
  JUMP_VELOCITY,
  PLAYER_WIDTH,
  RUN_SPEED,
  scrollSpeed,
  SPIKE_MERCY,
  VIEW_WIDTH,
} from '../physics';
import {
  LevelWorld,
  solidTop,
  xAtTime,
  type ChunkKind,
  type Pickup,
  type PlatformerLevel,
  type Solid,
  type SpikeStrip,
} from './level';
import { Explorer, stepAt } from './validate';

/**
 * Builds the platformer's level from a song's level map, a bar or two at a time, and checks
 * each stretch with the validator as it goes: a stretch nobody can get through is built
 * again easier (narrower gaps, lower steps, longer bridges, a ledge in a gap) and, as a
 * last resort, as flat ground, which is always passable. Seeded by the song and the
 * difficulty, so the same song always gives the same level.
 */

export interface DifficultySettings {
  /** Chance a bar in a busy section gets an obstacle rather than plain ground. */
  hazard: number;
  /** Gap width, as a share of the longest running jump. */
  gap: number;
  /** Chance a gap bar has a second gap. */
  doubleGap: number;
  /** Most the ground's height changes at a gap, px. */
  rise: number;
  /** Spike strip length, in beats. */
  spike: number;
  /** Beats a bridge stays after its snare. */
  bridgeHold: number;
  /** How far equalisers move with the bass, px. */
  eqRange: number;
  /** Gap between equaliser columns, as a share of a beat. */
  eqGap: number;
  /** Height of each step of a drop's staircase, px. */
  stepRise: number;
  /** A coin on every n-th hi-hat. */
  coinEvery: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultySettings> = {
  easy: {
    hazard: 0.45,
    gap: 0.35,
    doubleGap: 0,
    rise: 36,
    spike: 0.3,
    bridgeHold: 1.75,
    eqRange: 50,
    eqGap: 0,
    stepRise: 40,
    coinEvery: 2,
  },
  normal: {
    hazard: 0.7,
    gap: 0.55,
    doubleGap: 0.25,
    rise: 60,
    spike: 0.45,
    bridgeHold: 1.5,
    eqRange: 80,
    eqGap: 0.15,
    stepRise: 52,
    coinEvery: 1,
  },
  hard: {
    hazard: 0.9,
    gap: 0.75,
    doubleGap: 0.5,
    rise: 80,
    spike: 0.65,
    bridgeHold: 1.25,
    eqRange: 110,
    eqGap: 0.25,
    stepRise: 64,
    coinEvery: 1,
  },
};

/** The longest running jump across flat ground, px. */
export const MAX_JUMP = (RUN_SPEED * 2 * JUMP_VELOCITY) / GRAVITY;
/** Heights the ground stays between, and where it starts. */
export const MIN_TOP = 0;
export const MAX_TOP = 320;
const START_TOP = 40;
/** Seconds of plain ground at the start and the end of every level. */
const RUN_IN_SECONDS = 3;
const RUN_OUT_SECONDS = 3;
/** Steps narrower than this count two beats each, for fast songs. */
const MIN_STEP_WIDTH = 70;
/** Bars narrower than this are built two at a time, px. */
const MIN_BAR_WIDTH = 340;
/** Coins are at least this far apart, and from gems, px. */
const COIN_SPACING = 26;
/** The drop staircase's steps. */
const STAIR_STEPS = 5;

/** A stretch to build: one bar, or more for a drop or a fast song. */
interface Stretch {
  start: number;
  end: number;
  /** The beats it is laid out on (every beat, or every other one for fast songs). */
  steps: number[];
}

interface BuildContext {
  map: LevelMap;
  settings: DifficultySettings;
  rng: Random;
  /** 1 as planned, smaller to make it easier. */
  ease: number;
  /** Add ledges in gaps. */
  support: boolean;
  /** Height the stretch starts at. */
  h: number;
  stretch: Stretch;
  x: (t: number) => number;
}

interface Built {
  kind: ChunkKind;
  solids: Solid[];
  spikes: SpikeStrip[];
  pickups: Pickup[];
  /** Height the stretch ends at: it always ends on plain ground at this height. */
  h: number;
}

const clampTop = (h: number) => Math.max(MIN_TOP, Math.min(MAX_TOP, h));
const ground = (x0: number, x1: number, top: number): Solid => ({ kind: 'ground', x0, x1, top });

function flat({ stretch, x, h }: BuildContext, kind: ChunkKind = 'flat'): Built {
  return {
    kind,
    solids: [ground(x(stretch.start), x(stretch.end), h)],
    spikes: [],
    pickups: [],
    h,
  };
}

/** Plain ground for breakdowns and intros, now and then a low step. */
function calm(ctx: BuildContext): Built {
  const { stretch, x, h, rng } = ctx;
  if (stretch.steps.length < 3 || !rng.chance(0.5)) return flat(ctx, 'calm');
  const mid = x(stretch.steps[Math.floor(stretch.steps.length / 2)]!);
  const next = clampTop(h + (rng.chance(0.5) ? 24 : -24));
  return {
    kind: 'calm',
    solids: [ground(x(stretch.start), mid, h), ground(mid, x(stretch.end), next)],
    spikes: [],
    pickups: [],
    h: next,
  };
}

/** Ground with one or two pits to jump, taking off on a beat, landing higher or lower. */
function gap(ctx: BuildContext): Built {
  const { stretch, x, rng, settings, ease } = ctx;
  const end = x(stretch.end);
  const width = Math.max(40, settings.gap * ease * MAX_JUMP * rng.range(0.85, 1.1));
  // Take off on a beat after the first, with room to land before the stretch ends.
  const takeoffs = stretch.steps
    .slice(1)
    .map(x)
    .filter((t) => t + width + 48 <= end);
  if (takeoffs.length === 0) return flat(ctx);
  const picked = [takeoffs[rng.int(0, takeoffs.length - 1)]!];
  if (rng.chance(settings.doubleGap)) {
    const later = takeoffs.filter((t) => t >= picked[0]! + width + 80);
    if (later.length > 0) picked.push(later[rng.int(0, later.length - 1)]!);
  }
  const solids: Solid[] = [];
  let from = x(stretch.start);
  let h = ctx.h;
  for (const takeoff of picked) {
    solids.push(ground(from, takeoff, h));
    const landing = clampTop(h + rng.range(-1, 1) * settings.rise * ease);
    if (ctx.support) {
      const ledge = Math.min(64, width * 0.4);
      const mid = takeoff + width / 2;
      solids.push({
        kind: 'ledge',
        x0: mid - ledge / 2,
        x1: mid + ledge / 2,
        top: Math.min(h, landing),
      });
    }
    from = takeoff + width;
    h = landing;
  }
  solids.push(ground(from, end, h));
  return { kind: 'gap', solids, spikes: [], pickups: [], h };
}

/** Equaliser columns, one per beat, their heights following the bass. */
function equaliser(ctx: BuildContext): Built {
  const { stretch, x, rng, settings, ease, map } = ctx;
  const steps = stretch.steps;
  if (steps.length < 3) return gap(ctx);
  const range = settings.eqRange * ease;
  const base = clampTop(Math.min(ctx.h - range * 0.25, MAX_TOP - range));
  const stepWidth = x(steps[1]!) - x(steps[0]!);
  const gapWidth = settings.eqGap * stepWidth;
  const exit = Math.max(36, stepWidth * 0.4);
  const end = x(stretch.end);
  // Keys from a few bars before to a few after, so they move whenever they are in view.
  const first = Math.max(0, beatIndexAt(map, stretch.start) - 12);
  const last = Math.min(map.beats.length - 1, beatIndexAt(map, stretch.end) + 8);
  const solids: Solid[] = [ground(x(stretch.start), x(steps[1]!) - gapWidth, ctx.h)];
  for (let k = 1; k < steps.length; k++) {
    const x0 = x(steps[k]!);
    const x1 = k === steps.length - 1 ? end - exit - gapWidth : x(steps[k + 1]!) - gapWidth;
    if (x1 - x0 < PLAYER_WIDTH) continue;
    const shape = rng.range(0.55, 1);
    const times: number[] = [];
    const tops: number[] = [];
    for (let i = first; i <= last; i++) {
      times.push(map.beats[i]!);
      tops.push(base + range * shape * (map.bass[i] ?? 0));
    }
    solids.push({ kind: 'eq', x0, x1, top: tops[0] ?? base, keys: { times, tops } });
  }
  solids.push(ground(end - exit, end, base));
  return { kind: 'eq', solids, spikes: [], pickups: [], h: base };
}

/** Pits spanned by bridges that come out on the snares and stay a beat or two. */
function bridges(ctx: BuildContext): Built {
  const { stretch, x, settings, ease, map, h } = ctx;
  const period = map.beatPeriod;
  const beatWidth = x(period) - x(0);
  const hold = Math.min(3, settings.bridgeHold / ease) * period;
  const snares = map.events.filter((e) => e.kind === 'snare').map((e) => e.time);
  const inStretch = snares.filter(
    (t) => t >= stretch.start + 0.25 * period && t <= stretch.end - 0.5 * period,
  );
  // A bridge is there after every snare near it, so a player off the beat gets another go.
  const windows = snares
    .filter((t) => t >= stretch.start - 8 * period && t <= stretch.end + 8 * period)
    .map((t): [number, number] => [t, t + hold]);
  const end = x(stretch.end);
  const solids: Solid[] = [];
  let from = x(stretch.start);
  let free = stretch.start;
  for (const snare of inStretch) {
    if (snare < free) continue;
    const x0 = x(snare) + 0.1 * beatWidth;
    const x1 = Math.min(x(snare + hold) - 0.1 * beatWidth, end - 0.4 * beatWidth);
    if (x1 - x0 < 40) continue;
    solids.push(ground(from, x0, h));
    solids.push({ kind: 'bridge', x0, x1, top: h, windows });
    from = x1;
    free = snare + hold + 0.5 * period;
  }
  if (solids.length === 0) return gap(ctx);
  solids.push(ground(from, end, h));
  return { kind: 'bridge', solids, spikes: [], pickups: [], h };
}

/** Ground with spike strips that come out on the off-beats: cross on the beat, or jump. */
function spikes(ctx: BuildContext): Built {
  const { stretch, x, rng, settings, ease, h, map } = ctx;
  const beatWidth = x(map.beatPeriod) - x(0);
  const length = Math.max(16, settings.spike * ease * beatWidth);
  const end = x(stretch.end);
  const strips: SpikeStrip[] = [];
  let free = -Infinity;
  for (const beat of stretch.steps.slice(1)) {
    // The strip starts where the front of a player on the beat is, as the spikes go in.
    const x0 = x(beat) + PLAYER_WIDTH - SPIKE_MERCY;
    const x1 = x0 + length;
    if (x0 < free || x1 > end - 24 || !rng.chance(0.6)) continue;
    strips.push({ x0, x1, top: h });
    free = x1 + beatWidth;
  }
  if (strips.length === 0) {
    const beat = stretch.steps[1];
    const x0 = beat === undefined ? end : x(beat) + PLAYER_WIDTH - SPIKE_MERCY;
    if (x0 + length > end - 24) return flat(ctx);
    strips.push({ x0, x1: x0 + length, top: h });
  }
  return {
    kind: 'spikes',
    solids: [ground(x(stretch.start), end, h)],
    spikes: strips,
    pickups: [],
    h,
  };
}

/** The drop's set piece: a staircase of bars to climb on the beat, and gems on top. */
function drop(ctx: BuildContext): Built {
  const { stretch, x, settings, ease, map } = ctx;
  const steps = stretch.steps;
  const count = Math.min(STAIR_STEPS, steps.length - 3);
  if (count < 2) return flat(ctx);
  const rise = settings.stepRise * ease;
  const base = clampTop(Math.min(ctx.h, MAX_TOP - count * rise));
  const end = x(stretch.end);
  const solids: Solid[] = [ground(x(stretch.start), x(steps[1]!), ctx.h)];
  const pickups: Pickup[] = [];
  const stepTime = steps[1]! - steps[0]!;
  let top = base;
  for (let k = 1; k <= count; k++) {
    top = base + k * rise;
    const x0 = x(steps[k]!);
    const x1 = x(steps[k + 1]!);
    solids.push({ kind: 'step', x0, x1, top });
    pickups.push({ kind: 'gem', x: (x0 + x1) / 2, y: top + 56, time: steps[k]! + stepTime / 2 });
  }
  // The plateau, with an arc of gems to jump for.
  const plateau = x(steps[count + 1]!);
  solids.push({ kind: 'step', x0: plateau, x1: end, top });
  for (let i = 0; i < 3; i++) {
    const t = steps[count + 1]! + (i + 0.5) * (map.beatPeriod / 2);
    pickups.push({ kind: 'gem', x: x(t), y: top + 70 + (i === 1 ? 30 : 0), time: t });
  }
  return { kind: 'drop', solids, spikes: [], pickups, h: top };
}

const BUILDERS: Record<ChunkKind, (ctx: BuildContext) => Built> = {
  'run-in': flat,
  'run-out': flat,
  flat,
  calm,
  gap,
  eq: equaliser,
  bridge: bridges,
  spikes,
  drop,
};

/** What a section's bars are made of. */
const PLANS: Record<SectionKind, readonly (readonly [ChunkKind, number])[]> = {
  intro: [
    ['flat', 3],
    ['gap', 1],
  ],
  breakdown: [
    ['calm', 3],
    ['gap', 1],
  ],
  outro: [
    ['flat', 2],
    ['calm', 1],
    ['gap', 1],
  ],
  build: [
    ['eq', 3],
    ['gap', 2],
    ['spikes', 2],
    ['bridge', 1],
  ],
  drop: [
    ['eq', 2],
    ['bridge', 3],
    ['spikes', 2],
    ['gap', 2],
  ],
  main: [
    ['eq', 2],
    ['bridge', 2],
    ['spikes', 2],
    ['gap', 2],
  ],
};

/** Calm sections are built this much easier, with wider ground and narrower gaps. */
const CALM_EASE = 0.6;
const isCalm = (kind: SectionKind) => kind === 'intro' || kind === 'breakdown' || kind === 'outro';

/** The ways to build a stretch, from as planned to easiest. */
interface Attempt {
  ease: number;
  support: boolean;
}

function attemptsFor(kind: ChunkKind, calm: boolean): Attempt[] {
  const start = calm ? CALM_EASE : 1;
  if (kind === 'flat' || kind === 'calm') return [{ ease: 1, support: false }];
  if (kind === 'drop')
    return [1, 0.75, 0.55, 0.4].map((ease) => ({ ease: ease * start, support: false }));
  return [
    { ease: start, support: false },
    { ease: start * 0.7, support: false },
    { ease: start * 0.45, support: false },
    { ease: start * 0.45, support: true },
  ];
}

/**
 * Coins on the hi-hats, over the ground or up in the jump over a pit. Where there are no
 * hats for a while (a quiet intro, a breakdown without drums) the coins go on the beats
 * instead, so there is always something to run to in time.
 */
function coins(level: PlatformerLevel, map: LevelMap, every: number, from: number, to: number) {
  const world = new LevelWorld(level);
  const inDrop = (t: number) =>
    level.chunks.some((c) => c.kind === 'drop' && t >= c.start && t < c.end);
  // Fast hats (sixteenths at 174 BPM are 14 px apart) would pile coins into a clump, and
  // onto the drop's gems: keep each coin clear of the others and of the gems.
  const taken = level.pickups.filter((p) => p.kind === 'gem').map((p) => p.x);
  const clear = (x: number) => taken.every((t) => Math.abs(t - x) >= COIN_SPACING);
  const place = (time: number) => {
    const x = xAtTime(level, time) + PLAYER_WIDTH / 2;
    if (!clear(x)) return;
    let top: number | null = null;
    let near = -Infinity;
    for (const i of world.solidsBetween(x - 150, x + 150)) {
      const s = level.solids[i]!;
      const at = solidTop(s, time);
      if (at === null) continue;
      if (s.x0 <= x && s.x1 > x) top = Math.max(top ?? -Infinity, at);
      near = Math.max(near, at);
    }
    const y = top !== null ? top + 28 : near + 110;
    if (!Number.isFinite(y)) return;
    level.pickups.push({ kind: 'coin', x, y, time });
    taken.push(x);
  };

  const hats = map.events.filter((e) => e.kind === 'hat').map((e) => e.time);
  let n = 0;
  for (const time of hats) {
    if (time < from || time > to) continue;
    // Drops get every hat; elsewhere every n-th.
    if (!inDrop(time) && n++ % every !== 0) continue;
    place(time);
  }
  // Beats with no hat within a beat either side, every other one (or every 2n-th).
  let h = 0;
  let quiet = 0;
  for (const time of map.beats) {
    if (time < from || time > to) continue;
    while (h < hats.length && hats[h]! < time - map.beatPeriod) h++;
    if (h < hats.length && hats[h]! <= time + map.beatPeriod) continue;
    if (quiet++ % (2 * every) === 0) place(time);
  }
  level.pickups.sort((a, b) => a.time - b.time);
}

/** Thrown when even flat ground can't be got through: a bug, never a hard song. */
export class LevelGenerationError extends Error {}

/**
 * The platformer's level for a song at a difficulty. Every stretch is proven passable by
 * the validator before the next is built; see `validate.ts`.
 */
export function generateLevel(map: LevelMap, difficulty: Difficulty): PlatformerLevel {
  const settings = DIFFICULTY[difficulty];
  const seed = hashOf(map.seed, difficulty);
  const speed = scrollSpeed(map.tempo);
  const period = map.beatPeriod;
  const level: PlatformerLevel = {
    seed,
    difficulty,
    duration: map.duration,
    tempo: map.tempo,
    gridStart: map.beats[0] ?? 0,
    beatPeriod: period,
    speed,
    solids: [],
    spikes: [],
    pickups: [],
    chunks: [],
    start: { x: ANCHOR_X, y: START_TOP },
    finishX: xAtTime({ speed }, map.duration),
  };
  const x = (t: number) => xAtTime(level, t);
  const world = new LevelWorld(level);
  const sectionAt = (t: number): SectionKind =>
    map.sections.find((s) => t >= s.start && t < s.end)?.kind ?? 'main';

  // Bars between the run-in and the run-out, each as a stretch.
  const runIn = map.downbeats.find((d) => d >= RUN_IN_SECONDS) ?? map.duration;
  const lastBar = [...map.downbeats].reverse().find((d) => d <= map.duration - RUN_OUT_SECONDS);
  const runOut = lastBar !== undefined && lastBar > runIn ? lastBar : runIn;
  const bars = map.downbeats.filter((d) => d >= runIn && d < runOut);
  const barEnd = (i: number) => map.downbeats.find((d) => d > bars[i]!) ?? runOut;
  const stepTime = x(period) - x(0) >= MIN_STEP_WIDTH ? period : 2 * period;
  const narrow = x(4 * period) - x(0) < MIN_BAR_WIDTH;
  const stretchOf = (start: number, end: number): Stretch => {
    const steps: number[] = [];
    for (let t = start; t < end - 1e-6; t += stepTime) steps.push(t);
    return { start, end, steps };
  };

  const snares = map.events.filter((e) => e.kind === 'snare').map((e) => e.time);

  // Each drop's set piece starts on the first bar at or after it.
  const dropBars = new Set<number>();
  for (const e of map.events) {
    if (e.kind !== 'drop') continue;
    const i = bars.findIndex((b) => b >= e.time - 1e-6);
    const at = i < 0 && e.time < runIn && bars.length > 0 ? 0 : i;
    if (at >= 0) dropBars.add(at);
  }

  // The run-in: plain ground under the player from before the screen's left edge.
  level.chunks.push({
    kind: 'run-in',
    planned: 'run-in',
    start: 0,
    end: runIn,
    x0: -40,
    x1: x(runIn),
    section: sectionAt(0),
    repairs: 0,
  });
  world.add([ground(-40, x(runIn), START_TOP)]);
  let explorer = Explorer.start(world);
  if (!explorer.run(stepAt(runIn), x(runIn)))
    throw new LevelGenerationError('Nobody gets through the run-in');

  let h = START_TOP;
  let previous: ChunkKind = 'run-in';
  for (let i = 0; i < bars.length;) {
    const isDrop = dropBars.has(i);
    // Every stretch of a song whose bars are too short for an obstacle takes two bars, and
    // drops two (four on such a song, for room to climb the staircase), never into a drop.
    const want = isDrop ? (narrow ? 4 : 2) : narrow ? 2 : 1;
    let span = 1;
    while (span < want && i + span < bars.length && !dropBars.has(i + span)) span++;
    const stretch = stretchOf(bars[i]!, barEnd(i + span - 1));
    const section = sectionAt(stretch.start);
    const calmSection = isCalm(section);
    const planRng = new Random(hashOf(seed, 'plan', i));
    // Bridges only where there are snares to bring them out.
    const hasSnares = snares.some((t) => t >= stretch.start && t < stretch.end);
    const options = PLANS[section].filter(([kind]) => kind !== 'bridge' || hasSnares);
    let plan: ChunkKind;
    if (isDrop) plan = 'drop';
    else if (calmSection || planRng.chance(settings.hazard)) {
      plan = planRng.weighted(options);
      // Not the same obstacle twice running, as a rule.
      if (plan === previous && plan !== 'flat' && plan !== 'calm' && planRng.chance(0.5))
        plan = planRng.weighted(options);
    } else plan = 'flat';

    const attempts: (Attempt | null)[] = [...attemptsFor(plan, calmSection), null];
    let accepted = false;
    for (let a = 0; a < attempts.length && !accepted; a++) {
      const attempt = attempts[a];
      const ctx: BuildContext = {
        map,
        settings,
        rng: new Random(hashOf(seed, i, a)),
        ease: attempt?.ease ?? 1,
        support: attempt?.support ?? false,
        h,
        stretch,
        x,
      };
      // The last resort is flat ground at the height the last stretch ended at.
      const built: Built = attempt ? BUILDERS[plan](ctx) : flat(ctx);
      const mark = world.mark();
      world.add(built.solids, built.spikes);
      const next = explorer.clone();
      if (next.run(stepAt(stretch.end), x(stretch.end)) && next.anyGrounded) {
        explorer = next;
        accepted = true;
        level.pickups.push(...built.pickups);
        level.chunks.push({
          kind: built.kind,
          planned: plan,
          start: stretch.start,
          end: stretch.end,
          x0: x(stretch.start),
          x1: x(stretch.end),
          section,
          repairs: a,
        });
        h = built.h;
        previous = built.kind;
      } else world.truncate(mark);
    }
    if (!accepted)
      throw new LevelGenerationError(
        `Nobody gets through the bar at ${stretch.start.toFixed(2)} s`,
      );
    i += span;
  }

  // The run-out: plain ground to past the end of the song.
  const end = x(map.duration) + VIEW_WIDTH;
  world.add([ground(x(runOut), end, h)]);
  level.chunks.push({
    kind: 'run-out',
    planned: 'run-out',
    start: runOut,
    end: map.duration,
    x0: x(runOut),
    x1: end,
    section: sectionAt(runOut),
    repairs: 0,
  });
  if (!explorer.run(stepAt(map.duration)))
    throw new LevelGenerationError('Nobody gets through the run-out');

  coins(level, map, settings.coinEvery, 0.5, map.duration - 0.5);
  return level;
}
