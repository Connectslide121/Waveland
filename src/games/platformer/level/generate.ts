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
  COYOTE_TIME,
  DASH_TIME,
  JUMP_AIR,
  PHYSICS_DT,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  scrollSpeed,
  SPIKE_MERCY,
  VIEW_WIDTH,
} from '../physics';
import {
  CHUNK_NEEDS,
  GATE_GRACE,
  LevelWorld,
  LOWEST_TOP,
  solidTop,
  xAtTime,
  type Ability,
  type ChunkKind,
  type Gate,
  type Pickup,
  type PlatformerLevel,
  type Solid,
  type SpikeStrip,
} from './level';
import { DECISION_STEPS, Explorer, stepAt } from './validate';

/**
 * Builds the platformer's level from a song's level map, a bar or two at a time, and checks
 * each stretch with the validator as it goes: a stretch nobody can get through is built
 * again easier (narrower gaps, lower steps, longer bridges, a ledge in a gap) and, as a
 * last resort, as flat ground, which is always passable. Seeded by the song and the
 * difficulty, so the same song always gives the same level.
 *
 * The player is locked to song time, so obstacles are sized in time: a pit by how long
 * the player is in the air over it, a gate or an overhang by when the player meets it.
 * The builders take those times from outside (`pitAt`, `gateAt`, `overhangAt`), so the
 * music can size them.
 */

export interface DifficultySettings {
  /** Chance a bar in a busy section gets an obstacle rather than plain ground. */
  hazard: number;
  /** Air time over a jump pit, as a share of a full jump's (`JUMP_AIR`). */
  gap: number;
  /** Chance a gap bar has a second gap. */
  doubleGap: number;
  /** Where a dash pit's air time is between a jump's reach (0) and a jump and dash's (1). */
  dashGap: number;
  /** Most dash gates in a stretch. */
  gates: number;
  /** How long an overhang is, in beats. */
  overhang: number;
  /** Room between the player's head and an overhang, px. */
  clearance: number;
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
    dashGap: 0.15,
    gates: 1,
    overhang: 1,
    clearance: 30,
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
    dashGap: 0.45,
    gates: 2,
    overhang: 1.5,
    clearance: 22,
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
    dashGap: 0.75,
    gates: 3,
    overhang: 2,
    clearance: 16,
    rise: 80,
    spike: 0.65,
    bridgeHold: 1.25,
    eqRange: 110,
    eqGap: 0.25,
    stepRise: 64,
    coinEvery: 1,
  },
};

/** Most air a jump alone gives over a pit at the same height: a jump at the last moment. */
export const JUMP_REACH = JUMP_AIR + COYOTE_TIME;
/** Most air a jump and a dash at its peak give. */
export const DASH_REACH = JUMP_REACH + DASH_TIME;
/** A dash pit needs at least this much more air than a jump gives, so it takes a dash. */
const DASH_MARGIN = 0.04;
/**
 * The hurdle before an overhang: a thin low wall the front of the player meets this long
 * after the beat it is on, this long to pass and this high, so it takes a jump (a dash
 * along the ground runs into it).
 */
const HURDLE_LEAD = 0.12;
const HURDLE_TIME = 0.06;
const HURDLE_RISE = 50;
/** The overhang comes no later than this after the hurdle's beat: a full jump is still high. */
const OVERHANG_LATEST = JUMP_AIR - 0.13;
/** Heights the ground stays between, and where it starts. */
export const MIN_TOP = LOWEST_TOP;
export const MAX_TOP = 320;
/** Overhangs reach up out of the view, so there is no going over them. */
const SKY = MAX_TOP + 800;
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
/** Kicks this strong count as accents, for dash gates where there are no snares. */
const ACCENT = 0.75;

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
  gates: Gate[];
  pickups: Pickup[];
  /** Height the stretch ends at: it always ends on plain ground at this height. */
  h: number;
  /** When the player meets its first obstacle, and is past it, for a lesson. */
  focus?: { time: number; end: number };
}

const clampTop = (h: number) => Math.max(MIN_TOP, Math.min(MAX_TOP, h));
const ground = (x0: number, x1: number, top: number): Solid => ({ kind: 'ground', x0, x1, top });
const built = (kind: ChunkKind, solids: Solid[], h: number, more: Partial<Built> = {}): Built => ({
  kind,
  solids,
  spikes: [],
  gates: [],
  pickups: [],
  h,
  ...more,
});

function flat({ stretch, x, h }: BuildContext, kind: ChunkKind = 'flat'): Built {
  return built(kind, [ground(x(stretch.start), x(stretch.end), h)], h);
}

/** Plain ground for breakdowns and intros, now and then a low step. */
function calm(ctx: BuildContext): Built {
  const { stretch, x, h, rng } = ctx;
  if (stretch.steps.length < 3 || !rng.chance(0.5)) return flat(ctx, 'calm');
  const mid = x(stretch.steps[Math.floor(stretch.steps.length / 2)]!);
  const next = clampTop(h + (rng.chance(0.5) ? 24 : -24));
  return built('calm', [ground(x(stretch.start), mid, h), ground(mid, x(stretch.end), next)], next);
}

/**
 * A pit the player takes off over at song time `takeoff` and needs `air` seconds in the
 * air to cross: the ground ends where the player's back leaves it then, and the far side
 * starts where their front is `air` later. Returns where the near ground ends and the far
 * one starts.
 */
export function pitAt(x: (t: number) => number, takeoff: number, air: number) {
  return { x0: x(takeoff), x1: x(takeoff + air) + PLAYER_WIDTH };
}

/** Ground with pits taking off on the beats: `airs` seconds each, landing at `landings`. */
function pits(
  ctx: BuildContext,
  kind: ChunkKind,
  takeoffs: number[],
  airs: number[],
  landings: number[],
): Built {
  const { stretch, x } = ctx;
  const solids: Solid[] = [];
  let from = x(stretch.start);
  let h = ctx.h;
  takeoffs.forEach((takeoff, i) => {
    const { x0, x1 } = pitAt(x, takeoff, airs[i]!);
    solids.push(ground(from, x0, h));
    const landing = landings[i]!;
    if (ctx.support) {
      const ledge = Math.min(64, (x1 - x0) * 0.4);
      const mid = (x0 + x1) / 2;
      solids.push({
        kind: 'ledge',
        x0: mid - ledge / 2,
        x1: mid + ledge / 2,
        top: Math.min(h, landing),
      });
    }
    from = x1;
    h = landing;
  });
  solids.push(ground(from, x(stretch.end), h));
  const first = takeoffs[0]!;
  return built(kind, solids, h, { focus: { time: first, end: first + airs[0]! } });
}

/** Ground with one or two pits to jump, taking off on a beat, landing higher or lower. */
function gap(ctx: BuildContext): Built {
  const { stretch, x, rng, settings, ease } = ctx;
  const end = x(stretch.end);
  const air = Math.max(0.12, settings.gap * ease * JUMP_AIR * rng.range(0.85, 1.1));
  // Take off on a beat after the first, with room to land before the stretch ends.
  const takeoffs = stretch.steps.slice(1).filter((t) => pitAt(x, t, air).x1 + 48 <= end);
  if (takeoffs.length === 0) return flat(ctx);
  const picked = [takeoffs[rng.int(0, takeoffs.length - 1)]!];
  if (rng.chance(settings.doubleGap)) {
    const later = takeoffs.filter((t) => t >= picked[0]! + air + 0.4);
    if (later.length > 0) picked.push(later[rng.int(0, later.length - 1)]!);
  }
  let h = ctx.h;
  const landings = picked.map(() => (h = clampTop(h + rng.range(-1, 1) * settings.rise * ease)));
  return pits(
    ctx,
    'gap',
    picked,
    picked.map(() => air),
    landings,
  );
}

/**
 * The air time of a pit too wide to jump: jump, then dash at the top. `share` places it
 * between a jump's reach and a jump and dash's.
 */
export function dashPitAir(share: number): number {
  // Up to what a jump right on the edge and a dash at its top give, without coyote time.
  const low = JUMP_REACH + DASH_MARGIN;
  const high = JUMP_AIR + DASH_TIME - DASH_MARGIN;
  return low + Math.max(0, Math.min(1, share)) * (high - low);
}

/** A pit too wide for a jump alone, taking off on a beat: jump, then dash over the rest. */
function dashGap(ctx: BuildContext): Built {
  const { stretch, x, rng, settings, ease } = ctx;
  const end = x(stretch.end);
  const air = dashPitAir(settings.dashGap * ease * rng.range(0.85, 1.1));
  const takeoffs = stretch.steps.slice(1).filter((t) => pitAt(x, t, air).x1 + 48 <= end);
  if (takeoffs.length === 0) return gap(ctx);
  const takeoff = takeoffs[rng.int(0, Math.min(1, takeoffs.length - 1))]!;
  return pits(ctx, 'dash-gap', [takeoff], [air], [ctx.h]);
}

/**
 * A dash gate for the beat at song time `time`, on ground at `top`: the front of the
 * player meets it a grace after, so a dash pressed on the beat is in time.
 */
export function gateAt(x: (t: number) => number, time: number, top: number): Gate {
  const at = time + GATE_GRACE;
  return { x: x(at) + PLAYER_WIDTH, time, at, top };
}

/** Dash gates on the snares (or accents, or the beats), on plain ground. */
function gates(ctx: BuildContext): Built {
  const { stretch, x, settings, map, h, rng } = ctx;
  const period = map.beatPeriod;
  // Not in the stretch's first beat, nor its last half: it starts and ends on plain ground.
  const inside = (t: number) => t >= stretch.start + period - 1e-6 && t <= stretch.end - period / 2;
  const snares = map.events.filter((e) => e.kind === 'snare' && inside(e.time));
  const accents = map.events.filter(
    (e) => e.kind === 'kick' && e.intensity >= ACCENT && inside(e.time),
  );
  const moments = (snares.length > 0 ? snares : accents).map((e) => e.time);
  if (moments.length === 0) moments.push(...stretch.steps.filter(inside));
  const most = Math.max(1, Math.round(settings.gates * Math.max(0.5, ctx.ease)));
  // One beat at least between gates, so each is its own hit.
  const times: number[] = [];
  const offset = rng.int(0, Math.min(1, moments.length - 1));
  for (const t of moments.slice(offset)) {
    if (times.length >= most) break;
    if (times.length === 0 || t >= times[times.length - 1]! + period - 1e-6) times.push(t);
  }
  if (times.length === 0) return flat(ctx);
  return built('gate', [ground(x(stretch.start), x(stretch.end), h)], h, {
    gates: times.map((t) => gateAt(x, t, h)),
    focus: { time: times[0]!, end: times[0]! + period / 2 },
  });
}

/**
 * An overhang the front of the player meets at `from` and is out from under at `to`,
 * hanging down to `clearance` above a player standing at `h`.
 */
export function overhangAt(
  x: (t: number) => number,
  from: number,
  to: number,
  h: number,
  clearance: number,
): Solid {
  const bottom = h + PLAYER_HEIGHT + clearance;
  return { kind: 'overhang', x0: x(from) + PLAYER_WIDTH, x1: x(to), top: SKY, bottom };
}

/**
 * A low hurdle to jump on a beat, and right after it an overhang to get under: a full
 * jump is still too high when it comes, so slam down after the hurdle (landing about on
 * the next beat at most tempos).
 */
function overhang(ctx: BuildContext): Built {
  const { stretch, x, settings, ease, map, h } = ctx;
  const period = map.beatPeriod;
  const half = period / 2;
  const takeoff = stretch.steps[1];
  if (takeoff === undefined || h + HURDLE_RISE > MAX_TOP) return flat(ctx);
  // Made easier, it comes a little later (more time to slam) and hangs a little higher,
  // but never so late that a full jump has come down by itself.
  const meet = takeoff + Math.min(OVERHANG_LATEST, 0.5 + (1 - ease) * 0.15);
  // As long as asked, as far as the stretch has room for (ending on plain ground).
  const leave = Math.min(
    meet + Math.max(0.5, settings.overhang * ease) * period,
    stretch.end - half,
  );
  if (leave - meet < half) return gap(ctx);
  const hurdle0 = x(takeoff + HURDLE_LEAD) + PLAYER_WIDTH;
  const hurdle1 = x(takeoff + HURDLE_LEAD + HURDLE_TIME) + PLAYER_WIDTH;
  const clearance = Math.min(30, settings.clearance / ease);
  return built(
    'overhang',
    [
      ground(x(stretch.start), hurdle0, h),
      ground(hurdle0, hurdle1, h + HURDLE_RISE),
      ground(hurdle1, x(stretch.end), h),
      overhangAt(x, meet, leave, h, clearance),
    ],
    h,
    { focus: { time: takeoff, end: leave } },
  );
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
  return built('eq', solids, base);
}

/**
 * When a bridge is there: from its own snare for `hold`, and from other snares near it, so
 * a player off the beat gets another go. Each comes out on a snare and is gone for at
 * least `BRIDGE_GAP` beats before the next, so a backbeat's snares every two beats never
 * merge its windows into a bridge that is always there.
 */
export function bridgeWindows(
  snares: number[],
  own: number,
  hold: number,
  period: number,
): [number, number][] {
  const gap = BRIDGE_GAP * period;
  const near = snares.filter((t) => t >= own - 8 * period && t <= own + 8 * period);
  const starts = [own];
  // Later snares, each a full gap after the window before ends.
  for (const t of near) if (t >= starts[starts.length - 1]! + hold + gap) starts.push(t);
  // Earlier ones, nearest first, each ending a full gap before the window after starts.
  for (let i = near.length - 1; i >= 0; i--)
    if (near[i]! + hold + gap <= starts[0]!) starts.unshift(near[i]!);
  return starts.map((t): [number, number] => [t, t + hold]);
}

/** Beats a bridge is gone, at least, between two times it is there. */
export const BRIDGE_GAP = 1;

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
    solids.push({
      kind: 'bridge',
      x0,
      x1,
      top: h,
      windows: bridgeWindows(snares, snare, hold, period),
    });
    from = x1;
    free = snare + hold + 0.5 * period;
  }
  if (solids.length === 0) return gap(ctx);
  solids.push(ground(from, end, h));
  return built('bridge', solids, h);
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
  return built('spikes', [ground(x(stretch.start), end, h)], h, { spikes: strips });
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
  return built('drop', solids, top, { pickups });
}

const BUILDERS: Record<ChunkKind, (ctx: BuildContext) => Built> = {
  'run-in': flat,
  'run-out': flat,
  flat,
  calm,
  gap,
  'dash-gap': dashGap,
  gate: gates,
  overhang,
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
    ['gate', 1],
    ['overhang', 1],
  ],
  drop: [
    ['eq', 2],
    ['bridge', 3],
    ['spikes', 2],
    ['gap', 1],
    ['dash-gap', 1],
    ['gate', 2],
    ['overhang', 1],
  ],
  main: [
    ['eq', 2],
    ['bridge', 2],
    ['spikes', 2],
    ['gap', 2],
    ['dash-gap', 1],
    ['gate', 1],
    ['overhang', 1],
  ],
};

/**
 * The abilities taught in calm spots before any obstacle needing them comes up, in order,
 * each by the easiest obstacle that needs it.
 */
const LESSONS: readonly ChunkKind[] = ['gate', 'overhang'];
/** Easy spots a lesson is tried in before the song is left without it. */
const LESSON_TRIES = 3;

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
      // Overhangs are walls in the sky, not something to stand on.
      if (s.kind === 'overhang') continue;
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

/**
 * Where the search through a stretch ending at `end` stops: the last decision step at
 * which the player's box is still wholly inside the stretch, so every candidate so far
 * has only met what is built, exactly as in the finished level. Stopping on a decision
 * step keeps the search in step with `validateLevel`, which then finds the same.
 */
function searchEnd(x: (t: number) => number, end: number): number {
  let step = Math.floor(stepAt(end) / DECISION_STEPS) * DECISION_STEPS;
  while (step > 0 && x(step * PHYSICS_DT) + PLAYER_WIDTH > x(end) + 1e-9) step -= DECISION_STEPS;
  return step;
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
    gates: [],
    pickups: [],
    chunks: [],
    lessons: [],
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
  if (!explorer.run(searchEnd(x, runIn)))
    throw new LevelGenerationError('Nobody gets through the run-in');

  let h = START_TOP;
  let previous: ChunkKind = 'run-in';
  // Abilities taught so far; obstacles needing the others wait for their lesson.
  const taught = new Set<Ability>();
  const lessons = [...LESSONS];
  let lessonTries = 0;
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
    // Bridges only where there are snares to bring them out, and nothing needing an
    // ability before it is taught.
    const hasSnares = snares.some((t) => t >= stretch.start && t < stretch.end);
    const options = PLANS[section].filter(([kind]) => {
      const need = CHUNK_NEEDS[kind];
      return (kind !== 'bridge' || hasSnares) && (need === undefined || taught.has(need));
    });
    let plan: ChunkKind;
    if (isDrop) plan = 'drop';
    else if (calmSection || planRng.chance(settings.hazard)) {
      plan = planRng.weighted(options);
      // Not the same obstacle twice running, as a rule.
      if (plan === previous && plan !== 'flat' && plan !== 'calm' && planRng.chance(0.5))
        plan = planRng.weighted(options);
    } else plan = 'flat';
    // An easy spot (a calm section, or a bar of plain ground) teaches the next ability.
    const lesson = !isDrop && lessons.length > 0 && (calmSection || plan === 'flat');
    if (lesson) plan = lessons[0]!;

    const attempts: (Attempt | null)[] = [...attemptsFor(plan, calmSection || lesson), null];
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
      const made: Built = attempt ? BUILDERS[plan](ctx) : flat(ctx);
      const mark = world.mark();
      world.add(made.solids, made.spikes, made.gates);
      const next = explorer.clone();
      if (next.run(searchEnd(x, stretch.end)) && next.anyGrounded) {
        explorer = next;
        accepted = true;
        level.pickups.push(...made.pickups);
        level.chunks.push({
          kind: made.kind,
          planned: plan,
          start: stretch.start,
          end: stretch.end,
          x0: x(stretch.start),
          x1: x(stretch.end),
          section,
          repairs: a,
        });
        const need = CHUNK_NEEDS[made.kind];
        if (lesson && made.kind === plan && need && made.focus) {
          taught.add(need);
          lessons.shift();
          lessonTries = 0;
          level.lessons.push({ action: need, ...made.focus });
        } else if (lesson && ++lessonTries >= LESSON_TRIES) {
          // A song with no room for it: the ability isn't taught, and nothing needs it.
          lessons.shift();
          lessonTries = 0;
        }
        h = made.h;
        previous = made.kind;
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
