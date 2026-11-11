import {
  beatAt,
  hashOf,
  periodAt,
  Random,
  timeOfBeat,
  type Difficulty,
  type LevelMap,
  type SectionFeel,
  type SectionKind,
} from '../../../core';
import { BLOCK_DEPTH, hits, LANE_HOP_TIME, PHYSICS_DT } from '../physics';
import {
  FEEL_OF_KIND,
  looksFor,
  pathFor,
  pulseFor,
  runFor,
  TrackWorld,
  zAtTime,
  type Booster,
  type BoosterKind,
  type Hold,
  type Hoop,
  type Obstacle,
  type ObstacleKind,
  type Pickup,
  type TunnelTrack,
} from './track';
import { DECISION_STEPS, Explorer, stepAt } from './validate';

/**
 * Builds the tunnel's track from a song's level map. Every obstacle comes from a musical
 * moment the core found, and the music sizes it (the grammar, `momentsOf`): blocks on
 * kicks, a block on the other side on snares, walls with a gap on accents (low walls to
 * jump on the strongest), a wall where the band comes back after a stop, sliding blocks
 * on syncopations (hard), a slalom on a fill's hits. How many of the common ones a bar
 * gets follows how busy the music is; a bar the song repeats gets the same obstacles as
 * before. Difficulty sets the lanes and leaves common moments out or makes obstacles
 * smaller, never moves them; seeded randomness only picks lanes, which the music leaves
 * open.
 *
 * Built a bar (or a few) at a time, each stretch checked with the validator as it goes:
 * a stretch nobody gets through clean is built again easier, every obstacle on its own
 * moment (one lane instead of two, wider gaps, still sliding blocks, no centre in a
 * slalom), then with only its rare moments, then only its most salient one, and as a last
 * resort empty, which is always passable. Seeded by the song and the difficulty, so the
 * same song always gives the same track.
 */

export interface DifficultySettings {
  /** Lanes across the tunnel's lower arc. */
  lanes: number;
  /** Share of the common moments (kicks, snares, syncopations) that become obstacles. */
  hazard: number;
  /** The weakest kick or snare (its intensity, 0 to 1) that is a moment at all. */
  minHit: number;
  /** Kicks at least this strong block two lanes. */
  twoLane: number;
  /** Lanes left open in an accent's wall, and in the wall after a stop. */
  gaps: number;
  /** Accents at least this strong are low walls across every lane, to jump. */
  lowAccent: number;
  /** Syncopations become blocks sliding a lane across. */
  slides: boolean;
  /** A slalom's blocks cover the centre lane too, where its hits leave time to weave. */
  slalomCentre: boolean;
  /** A gem on every n-th hi-hat. */
  gemEvery: number;
  /**
   * Kick and snare blocks, accent walls and sliding blocks on a sixteenth too. Without it
   * every obstacle is on a beat or an "and", the pulse the player can count.
   */
  sixteenths: boolean;
  /**
   * Obstacles a busy bar has at least, and a bar of a chorus or a drop: fractions carry
   * from bar to bar (a half is one every other bar). Calm parts have none.
   */
  busyFloor: number;
  peakFloor: number;
  /**
   * The share of kick blocks that stand in the centre lane, where the racer starts and
   * the gems' line is, so on easy a block is more often in the way.
   */
  lean: number;
  /** The lanes left open in a squeeze's three walls, wide to narrow. */
  squeeze: readonly number[];
}

export const DIFFICULTY: Record<Difficulty, DifficultySettings> = {
  easy: {
    lanes: 3,
    hazard: 0.4,
    minHit: 0.55,
    twoLane: Infinity,
    gaps: 2,
    lowAccent: 0.95,
    slides: false,
    slalomCentre: false,
    gemEvery: 2,
    sixteenths: false,
    busyFloor: 0.5,
    peakFloor: 1,
    lean: 0.4,
    squeeze: [2, 2, 2],
  },
  normal: {
    lanes: 5,
    hazard: 0.65,
    minHit: 0.4,
    twoLane: 0.8,
    gaps: 1,
    lowAccent: 0.85,
    slides: false,
    slalomCentre: false,
    gemEvery: 2,
    sixteenths: false,
    busyFloor: 1,
    peakFloor: 1.75,
    lean: 0.2,
    squeeze: [3, 3, 2],
  },
  hard: {
    lanes: 5,
    hazard: 1,
    minHit: 0.3,
    twoLane: 0.6,
    gaps: 1,
    lowAccent: 0.75,
    slides: true,
    slalomCentre: true,
    gemEvery: 1,
    sixteenths: true,
    busyFloor: 1.75,
    peakFloor: 3,
    lean: 0,
    squeeze: [3, 2, 1],
  },
};

/** Seconds of empty track at the start and the end of every song. */
const RUN_IN_SECONDS = 3;
const RUN_OUT_SECONDS = 3;
/** Bars of a drop's set piece: every lane open, a wave of gems on every beat. */
export const DROP_BARS = 2;
/** Bars the song plays again repeat at this level for loops. */
const PHRASE_BARS = 4;
/** Common obstacles in a bar at full activity and hazard 1. */
const COMMON_PER_BAR = 4;
/** By the end of a build, this many more common obstacles than its music alone gives. */
const BUILD_DENSER = 0.8;
/** Beats of free track before a wall with a gap, to steer to the gap. */
const WALL_APPROACH = 1.5;
/** Beats after an obstacle's last contact that count as passing it (`endOf`). */
const PASS_BEATS = 0.5;
/** A slalom's blocks are at least this many beats apart (dense fills are thinned). */
const SLALOM_MIN = 0.25;
/** A slalom covers the centre too only when its hits are this many seconds apart. */
const WEAVE_TIME = 0.36;
/** A sliding block starts sliding this many beats before the racer meets it. */
const SLIDE_BEATS = 0.5;
/** A beat is "on the pulse" when it is this near a beat or an "and" (in beats). */
const ON_PULSE = 0.08;
/**
 * Off-beat hits are moments while they are rare: more than this many a bar, over the
 * `SYNC_WINDOW` beats either side, and they are the song's texture (a wall of guitars, a
 * busy kick), which nobody hears one hit of.
 */
const SYNC_PER_BAR = 1.5;
const SYNC_WINDOW = 16;
/** A squeeze's three walls are on beats 1, 2 and 3 of a build's last bar. */
const SQUEEZE_BEATS = [1, 2, 3] as const;

// ---------- the grammar: musical moments ----------

/** The obstacle a musical moment becomes (an accent's wall may be a low wall). */
type MomentKind = Exclude<ObstacleKind, 'low'>;

/** A musical moment an obstacle can sit on, in beats on the song's grid. */
interface Moment {
  kind: MomentKind;
  /** Its beat: the hit, the stop's start, a fill's first hit. */
  beat: number;
  /** How long it lasts, in beats: the stop, a fill up to its bar line. */
  length: number;
  /** A fill's hits, in beats. */
  hits?: number[];
  strength: number;
  /** What it is in the music, in words: "kick", "accent", "band stops". */
  what: string;
  /** The beats it takes up: from its approach to the free track after it. */
  from: number;
  to: number;
  /** The beat of its last obstacle (a stop's return, a fill's last hit). */
  last: number;
  /** Seeded 0 to 1: which lanes it takes, the one thing the music leaves open. */
  pick: number;
  /** The song's bar (from 1) it repeats, when it comes from a bar played before. */
  repeats?: number;
}

/**
 * Which moment wins where two would overlap. The common ones are equals: the stronger
 * hit wins, so a bar's loudest kicks and snares get its blocks.
 */
const SALIENCE: Record<MomentKind, number> = {
  stop: 8,
  slalom: 6,
  wall: 5,
  slide: 1,
  snare: 1,
  kick: 1,
  squeeze: 5,
};

/** Moments rare enough that every one becomes an obstacle, however busy the bar. */
const RARE: ReadonlySet<MomentKind> = new Set(['stop', 'slalom', 'wall', 'squeeze']);
/** Common moments a calm section (intro, breakdown, outro) leaves as free track. */
const BUSY_ONLY: ReadonlySet<MomentKind> = new Set(['snare', 'slide']);

/** Beats as a short number: 2, 1.5, 1.75. */
const beatsText = (beats: number) => {
  const text = (Math.round(beats * 4) / 4).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${text} beat${text === '1' ? '' : 's'}`;
};

/**
 * Every musical moment of the song as a candidate obstacle, with the beats it takes up.
 * Kicks and snares come from the level map's events; stops, accents, fills and
 * syncopations from its features. Held sounds become rails and rings to ride, not
 * obstacles (`pickupsFor`).
 */
function momentsOf(map: LevelMap, settings: DifficultySettings, seed: number): Moment[] {
  const b = (t: number) => beatAt(map, t);
  const pick = (kind: string, beat: number) =>
    new Random(hashOf(seed, 'moment', kind, Math.round(beat * 4))).next();
  const moments: Moment[] = [];
  const { stops, accents, fills, syncopations } = map.features;
  /** On a beat or an "and": where a press can be counted in. */
  const onPulse = (beat: number) => Math.abs(beat * 2 - Math.round(beat * 2)) <= ON_PULSE * 2;
  const pressable = (beat: number) => settings.sixteenths || onPulse(beat);
  const single = (kind: MomentKind, beat: number, strength: number, what: string, before = 0.5) =>
    moments.push({
      kind,
      beat,
      length: 0,
      strength,
      what,
      from: beat - before,
      to: beat + 0.25,
      last: beat,
      pick: pick(kind, beat),
    });

  for (const s of stops) {
    const beat = b(s.time);
    const end = b(s.end);
    moments.push({
      kind: 'stop',
      beat,
      length: end - beat,
      strength: 1,
      what: 'band stops',
      from: beat - 0.25,
      to: end + 0.75,
      last: end,
      pick: pick('stop', beat),
    });
  }
  for (const a of accents) {
    const beat = b(a.time);
    if (!pressable(beat)) continue;
    moments.push({
      kind: 'wall',
      beat,
      length: 0,
      strength: a.strength,
      what: 'accent',
      from: beat - WALL_APPROACH,
      to: beat + 0.75,
      last: beat,
      pick: pick('wall', beat),
    });
  }
  for (const f of fills) {
    const all = f.hits.map(b);
    const hitBeats: number[] = [];
    for (const h of all)
      if (hitBeats.length === 0 || h - hitBeats[hitBeats.length - 1]! >= SLALOM_MIN - 1e-6)
        hitBeats.push(h);
    const beat = hitBeats[0]!;
    const last = hitBeats[hitBeats.length - 1]!;
    moments.push({
      kind: 'slalom',
      beat,
      length: b(f.end) - beat,
      hits: hitBeats,
      strength: 1,
      what: 'fill',
      from: beat - 0.75,
      to: last + 0.5,
      last,
      pick: pick('slalom', beat),
    });
  }
  if (settings.slides) {
    const offBeats = syncopations.map((s) => b(s.time));
    let near = 0;
    let far = 0;
    for (const [i, s] of syncopations.entries()) {
      const beat = offBeats[i]!;
      // Rare around here, or it is the texture and not a moment.
      while (offBeats[near]! < beat - SYNC_WINDOW) near++;
      while (far < offBeats.length && offBeats[far]! <= beat + SYNC_WINDOW) far++;
      if (far - near > (SYNC_PER_BAR * 2 * SYNC_WINDOW) / 4 || !pressable(beat)) continue;
      single('slide', beat, s.strength, 'off-beat hit');
    }
  }
  for (const e of map.events) {
    if (e.intensity < settings.minHit) continue;
    const beat = b(e.time);
    if (!pressable(beat)) continue;
    if (e.kind === 'kick') single('kick', beat, e.intensity, 'kick');
    else if (e.kind === 'snare') single('snare', beat, e.intensity, 'snare');
  }
  // The last bar of a build narrows: three walls, each leaving less open.
  map.sections.forEach((s, i) => {
    const feel = map.moods?.[i]?.feel ?? FEEL_OF_KIND[s.kind];
    if (feel !== 'build') return;
    // The last bar that has at least three beats before the section's end.
    const bar = [...map.downbeats]
      .reverse()
      .find((d) => d >= s.start - 1e-6 && b(s.end) - b(d) >= 3 - 1e-6);
    if (bar === undefined || b(s.end) - b(bar) >= 5) return;
    const first = b(bar);
    const hitBeats = SQUEEZE_BEATS.map((k) => first + k);
    moments.push({
      kind: 'squeeze',
      beat: hitBeats[0]!,
      length: hitBeats[2]! - hitBeats[0]!,
      hits: hitBeats,
      strength: 1,
      what: 'build ends',
      from: hitBeats[0]! - 0.75,
      to: hitBeats[2]! + 0.5,
      last: hitBeats[2]!,
      pick: pick('squeeze', first),
    });
  });
  return moments;
}

/** Strongest first: by salience, then strength, then time. */
const byStrength = (a: Moment, b: Moment) =>
  SALIENCE[b.kind] - SALIENCE[a.kind] || b.strength - a.strength || a.beat - b.beat;

const overlaps = (a: Moment, b: Moment) => a.from < b.to - 1e-6 && b.from < a.to - 1e-6;

/** Where the racer is past the moment's last obstacle, in beats: what a stretch must hold. */
const endOf = (m: Moment) => m.last + PASS_BEATS;

/** Moments shifted by whole beats, for a bar the song plays again. */
function shifted(m: Moment, by: number, repeats: number): Moment {
  return {
    ...m,
    beat: m.beat + by,
    from: m.from + by,
    to: m.to + by,
    last: m.last + by,
    hits: m.hits?.map((h) => h + by),
    repeats,
  };
}

/**
 * The obstacles each bar gets, from the moments it owns (by their beat): every rare
 * moment that fits, and as many common ones as the music is busy (its kicks and snares
 * per beat and its energy, times the difficulty's hazard, the fractions carried from bar
 * to bar), strongest first, never overlapping. A bar the song repeats takes the
 * obstacles that bar had a phrase back, or the first time it was played, each on its own
 * moment there; a loop of a bar or two plans its first phrase afresh and repeats that.
 * A drop's set piece is open track: its bars get nothing, and a bar sounding like one is
 * planned afresh.
 */
function planBars(
  map: LevelMap,
  moments: Moment[],
  bars: number[],
  barEnd: (i: number) => number,
  /** Bars of a drop's set piece: no obstacles, and never a repeat's source. */
  open: ReadonlySet<number>,
  calmAt: (t: number) => boolean,
  busyAt: (t: number) => number,
  settings: DifficultySettings,
  /** Obstacles a bar has at least at `t`, from the section's feel. */
  floorAt: (t: number) => number,
): Moment[][] {
  const all = moments.filter((m) => m.from >= beatAt(map, bars[0] ?? 0) - 1e-6);
  const own: Moment[][] = bars.map(() => []);
  for (const m of all) {
    const t = timeOfBeat(map, m.beat);
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid]! <= t + 1e-6) lo = mid;
      else hi = mid - 1;
    }
    if (bars.length > 0 && t >= bars[lo]! - 1e-6 && t < barEnd(lo) - 1e-6) own[lo]!.push(m);
  }

  const events = map.events.filter(
    (e) => (e.kind === 'kick' || e.kind === 'snare') && e.intensity >= 0.3,
  );
  const plans: Moment[][] = [];
  const firstOf = new Map<number, number>();
  const groups: number[] = [];
  let carry = 0;
  let floorCarry = 0;
  bars.forEach((start, i) => {
    if (open.has(i)) {
      plans.push([]);
      groups.push(-1);
      return;
    }
    const end = barEnd(i);
    const calm = calmAt(start);
    const calmMoment = (m: Moment) => calmAt(timeOfBeat(map, m.beat)) && BUSY_ONLY.has(m.kind);
    const first = beatAt(map, start);
    const last = beatAt(map, end);
    // Which of the bar's moments come first: among those of a kind, the ones where the
    // bar a phrase back had its obstacles, so a part keeps its pattern from phrase to
    // phrase even where the song isn't heard to repeat; then the ones on the beat, which
    // the player counts, before the "ands" and sixteenths; then the strongest.
    const phraseBack = plans[i - PHRASE_BARS];
    const backFirst = beatAt(map, bars[i - PHRASE_BARS] ?? 0);
    const kept = (m: Moment) =>
      phraseBack?.some(
        (o) => o.kind === m.kind && Math.abs(o.beat - backFirst - (m.beat - first)) <= 0.15,
      )
        ? 1
        : 0;
    const onBeat = (m: Moment) => (Math.abs(m.beat - Math.round(m.beat)) <= ON_PULSE ? 1 : 0);
    const mine = own[i]!.filter((m) => !calmMoment(m)).sort(
      (x, y) =>
        SALIENCE[y.kind] - SALIENCE[x.kind] ||
        kept(y) - kept(x) ||
        onBeat(y) - onBeat(x) ||
        byStrength(x, y),
    );

    const hitCount = events.filter((e) => e.time >= start - 1e-6 && e.time < end - 1e-6).length;
    let energy = 0;
    let beats = 0;
    for (let k = Math.round(first); k < Math.round(last); k++, beats++)
      energy += map.energy[k] ?? 0;
    const rate = hitCount / Math.max(1, last - first);
    const activity =
      0.6 * Math.max(0, Math.min(1, (rate - 0.5) / 2)) + 0.4 * (beats > 0 ? energy / beats : 0);
    carry += activity * settings.hazard * COMMON_PER_BAR * (calm ? 0.5 : 1) * busyAt(start);
    const common = Math.floor(carry);
    carry -= common;

    // What the bar before runs into this one: nothing common may sit on it, and a rare
    // moment here pushes a common one there out.
    const previous = plans[i - 1] ?? [];
    const blocked = (m: Moment, copy = false) =>
      previous.some((c) => overlaps(c, m) && (RARE.has(c.kind) || (!copy && !RARE.has(m.kind))));
    const take = (into: Moment[], m: Moment) => {
      into.push(m);
      for (let k = previous.length - 1; k >= 0; k--)
        if (overlaps(previous[k]!, m)) previous.splice(k, 1);
    };

    const g = map.downbeats.indexOf(start);
    const group = map.features.bars[g]?.repeats ?? g;
    groups.push(group);
    const back = i - PHRASE_BARS;
    const firstTime = firstOf.get(group);
    const source =
      g < 0
        ? undefined
        : back >= 0 && groups[back] === group
          ? back
          : firstTime !== undefined && i - firstTime >= PHRASE_BARS
            ? firstTime
            : undefined;
    if (source !== undefined) {
      const by = Math.round(first - beatAt(map, bars[source]!));
      const song = map.downbeats.indexOf(bars[source]!) + 1;
      const plan: Moment[] = [];
      for (const m of plans[source]!.map((m) => shifted(m, by, song))) {
        // Its moment is here too.
        const here = all.some((o) => o.kind === m.kind && Math.abs(o.beat - m.beat) <= 0.15);
        if (here && !blocked(m, true) && !calmMoment(m)) take(plan, m);
      }
      plans.push(plan);
      return;
    }
    if (g >= 0 && !firstOf.has(group)) firstOf.set(group, i);

    const plan: Moment[] = [];
    const pick = (from: Moment[], commons: number) => {
      for (const m of from) {
        if (plan.some((c) => overlaps(c, m)) || blocked(m)) continue;
        if (RARE.has(m.kind)) take(plan, m);
        else if (commons > 0) {
          take(plan, m);
          commons--;
        }
      }
    };
    pick(mine, common);
    // The floor: a busy bar always asks for something, from its own moments (so a steady
    // four-on-the-floor beat, which the music's activity rates low, still has obstacles).
    if (!calm) floorCarry += floorAt(start);
    const floor = Math.floor(floorCarry + 1e-9);
    floorCarry -= floor;
    if (plan.length < floor) pick(mine, floor - plan.length);
    plans.push(plan);
  });
  return plans;
}

/** The moments of a stretch's bars that fit together in it, strongest first. */
function fitStretch(plans: Moment[][], first: number, last: number): Moment[] {
  const chosen: Moment[] = [];
  for (const m of plans.flat().sort(byStrength)) {
    if (m.beat < first - 1e-6 || endOf(m) > last + 1e-6) continue;
    if (chosen.some((c) => overlaps(c, m))) continue;
    chosen.push(m);
  }
  return chosen;
}

// ---------- building ----------

/**
 * How easy a stretch is built: 0 as planned; 1 with one lane for every block, sliding
 * blocks still, no centre in a slalom and a gap lane more in every wall; 2 with two more.
 */
type Ease = 0 | 1 | 2;

interface BuildContext {
  map: LevelMap;
  settings: DifficultySettings;
  lanes: number;
  ease: Ease;
  z: (t: number) => number;
  /** The middle of the last kick's block, which a snare answers on the other side. */
  lastKick: number | null;
}

const centreOf = (lanes: number) => (lanes - 1) / 2;

/** A lane from a seeded pick. */
const laneOf = (pick: number, lanes: number) => Math.min(lanes - 1, Math.floor(pick * lanes));

/**
 * A kick's lane from its seeded pick: the centre lane for the first `lean` share of
 * picks (where the racer starts and the gems' line is), any lane for the rest. A pure
 * function of the pick, so a repeated bar keeps its lanes.
 */
export function leanedLane(pick: number, lanes: number, lean: number): number {
  if (pick < lean) return Math.floor(centreOf(lanes));
  return laneOf((pick - lean) / (1 - lean), lanes);
}

/** `width` lanes next to each other that include `lane`, as near as can be centred on it. */
export function laneWindow(lane: number, width: number, lanes: number): number[] {
  const w = Math.max(1, Math.min(lanes, width));
  const lo = Math.max(0, Math.min(lanes - w, lane - Math.floor((w - 1) / 2)));
  return Array.from({ length: w }, (_, i) => lo + i);
}

/**
 * The lanes left open in a wall: `count` of them, from the picked lane, growing on the
 * side nearer the centre each time.
 */
export function gapLanes(pick: number, count: number, lanes: number): number[] {
  const first = laneOf(pick, lanes);
  const gap = [first];
  const centre = centreOf(lanes);
  let lo = first;
  let hi = first;
  while (gap.length < Math.min(count, lanes)) {
    // The side nearer the centre (the right on a tie), while there is one.
    const towardHigh =
      hi + 1 < lanes && (lo - 1 < 0 || Math.abs(hi + 1 - centre) <= Math.abs(lo - 1 - centre));
    if (towardHigh) gap.push(++hi);
    else gap.push(--lo);
  }
  return gap.sort((a, b) => a - b);
}

/** Every lane but those given. */
const allBut = (lanes: number, open: number[]) =>
  Array.from({ length: lanes }, (_, i) => i).filter((i) => !open.includes(i));

/** The obstacles of a stretch's moments, in time order, and the last kick's lane after them. */
function compose(
  ctx: BuildContext,
  moments: Moment[],
): { obstacles: Obstacle[]; lastKick: number | null } {
  const { map, settings, lanes, ease, z } = ctx;
  const centre = centreOf(lanes);
  let lastKick = ctx.lastKick;
  const obstacles: Obstacle[] = [];
  const add = (
    kind: ObstacleKind,
    beat: number,
    blocked: number[],
    m: Moment,
    label: string,
    reason: string,
    more: Partial<Obstacle> = {},
  ) => {
    if (blocked.length === 0) return;
    const time = timeOfBeat(map, beat);
    const z0 = z(time);
    obstacles.push({
      kind,
      time,
      z0,
      z1: z0 + BLOCK_DEPTH,
      lanes: blocked,
      label,
      reason,
      ...(m.repeats !== undefined ? { repeats: m.repeats } : {}),
      ...more,
    });
  };

  for (const m of [...moments].sort((a, b) => a.beat - b.beat)) {
    switch (m.kind) {
      case 'kick': {
        const lane = leanedLane(m.pick, lanes, settings.lean);
        const two = ease === 0 && m.strength >= settings.twoLane;
        const other = lane + 1 < lanes ? lane + 1 : lane - 1;
        const blocked = two ? [lane, other].sort((a, b) => a - b) : [lane];
        add('kick', m.beat, blocked, m, two ? 'Double block' : 'Block', 'kick');
        lastKick = (blocked[0]! + blocked[blocked.length - 1]!) / 2;
        break;
      }
      case 'snare': {
        // On the other side from the last kick's block, so a groove steers left and right:
        // its mirror, or beside the centre when the block was about the centre.
        let lane = lastKick === null ? laneOf(m.pick, lanes) : Math.round(lanes - 1 - lastKick);
        if (lastKick !== null && Math.abs(lastKick - centre) < 0.75)
          lane =
            lastKick > centre || (lastKick === centre && m.pick < 0.5) ? centre - 1 : centre + 1;
        else if (lane === centre) lane = m.pick < 0.5 ? lane - 1 : lane + 1;
        add('snare', m.beat, [lane], m, 'Block', 'snare, across from the kick');
        break;
      }
      case 'wall': {
        if (m.strength >= settings.lowAccent) {
          add('low', m.beat, allBut(lanes, []), m, 'Low wall', 'strong accent: jump it', {
            low: true,
          });
          break;
        }
        const open = gapLanes(m.pick, settings.gaps + ease, lanes);
        add('wall', m.beat, allBut(lanes, open), m, 'Wall', 'accent: through the gap');
        break;
      }
      case 'stop': {
        const open = gapLanes(m.pick, settings.gaps + ease, lanes);
        add(
          'stop',
          m.last,
          allBut(lanes, open),
          m,
          'Wall',
          `band comes back after ${beatsText(m.length)} stopped`,
        );
        break;
      }
      case 'slide': {
        const from = laneOf(m.pick, lanes);
        const step = (m.pick * lanes) % 1 < 0.5 ? -1 : 1;
        const to = from + step >= 0 && from + step < lanes ? from + step : from - step;
        const time = timeOfBeat(map, m.beat);
        add(
          'slide',
          m.beat,
          [to],
          m,
          'Sliding block',
          'off-beat hit',
          ease === 0
            ? {
                slide: { from, start: timeOfBeat(map, m.beat - SLIDE_BEATS), end: time },
              }
            : {},
        );
        break;
      }
      case 'squeeze': {
        // Three walls, each leaving fewer lanes open, all round the picked line.
        const line = laneOf(m.pick, lanes);
        (m.hits ?? []).forEach((h, j) => {
          const open = laneWindow(line, (settings.squeeze[j] ?? 1) + ease, lanes);
          add(
            'squeeze',
            h,
            allBut(lanes, open),
            m,
            'Squeeze',
            `build ends: the way narrows to ${open.length === 1 ? 'one lane' : `${open.length} lanes`}`,
          );
        });
        break;
      }
      case 'slalom': {
        // One block a hit, alternating sides; the centre too where the hits leave time to weave.
        const left = Array.from({ length: Math.floor(centre) }, (_, i) => i);
        const right = left.map((i) => lanes - 1 - i).sort((a, b) => a - b);
        let leftSide = m.pick < 0.5;
        let prev = -Infinity;
        for (const h of m.hits ?? []) {
          const t = timeOfBeat(map, h);
          const weave =
            settings.slalomCentre && ease === 0 && t - prev >= WEAVE_TIME && lanes % 2 === 1;
          const side = leftSide ? left : right;
          add(
            'slalom',
            h,
            weave ? [...side, centre].sort((a, b) => a - b) : side,
            m,
            'Slalom',
            'fill hit',
          );
          prev = t;
          leftSide = !leftSide;
        }
        break;
      }
    }
  }
  return { obstacles, lastKick };
}

/** The ways to build a stretch, from as planned to easiest (null: empty). */
interface Attempt {
  ease: Ease;
  /** Only the rare moments, or only the most salient one. */
  only?: 'rare' | 'main';
}

function attemptsFor(moments: Moment[]): (Attempt | null)[] {
  if (moments.length === 0) return [{ ease: 0 }];
  return [
    { ease: 0 },
    { ease: 1 },
    { ease: 2 },
    ...(moments.some((m) => !RARE.has(m.kind)) ? [{ ease: 2, only: 'rare' } as const] : []),
    ...(moments.length > 1 ? [{ ease: 2, only: 'main' } as const] : []),
    null,
  ];
}

/**
 * The last decision step at or before song time `end`: each stretch's search stops there,
 * so every candidate has only met what is built (the next stretch's obstacles are met on
 * its moments, at or after its start), exactly as in the finished track.
 */
function searchEnd(end: number): number {
  let step = Math.floor(stepAt(end) / DECISION_STEPS) * DECISION_STEPS;
  while (step > 0 && step * PHYSICS_DT > end + 1e-9) step -= DECISION_STEPS;
  return step;
}

/** Thrown when even an empty stretch can't be got through: a bug, never a hard song. */
export class TrackGenerationError extends Error {}

/**
 * The tunnel's track for a song at a difficulty. Every stretch is proven raceable without
 * a crash by the validator before the next is built; see `validate.ts`.
 */
export function generateLevel(map: LevelMap, difficulty: Difficulty): TunnelTrack {
  const settings = DIFFICULTY[difficulty];
  const seed = hashOf(map.seed, 'tunnel', difficulty);
  const run = runFor(map);
  const lanes = settings.lanes;
  const track: TunnelTrack = {
    seed,
    difficulty,
    duration: map.duration,
    tempo: map.tempo,
    grid: { segments: map.segments, beats: map.beats, downbeats: map.downbeats },
    lanes,
    run,
    path: pathFor(map, run),
    looks: looksFor(map),
    pulse: pulseFor(map),
    obstacles: [],
    pickups: [],
    boosters: [],
    hoops: [],
    holds: [],
    dark: map.features.stops.map((s) => ({ time: s.time, end: s.end })),
    chunks: [],
    startLane: Math.floor(lanes / 2),
    finishZ: zAtTime({ run }, map.duration),
  };
  const z = (t: number) => zAtTime(track, t);
  const world = new TrackWorld(track);
  const sectionIndexAt = (t: number) => map.sections.findIndex((s) => t >= s.start && t < s.end);
  const sectionAt = (t: number): SectionKind => map.sections[sectionIndexAt(t)]?.kind ?? 'main';
  const feelAt = (t: number): SectionFeel => {
    const i = sectionIndexAt(t);
    return map.moods?.[i]?.feel ?? FEEL_OF_KIND[map.sections[i]?.kind ?? 'main'];
  };
  const calmAt = (t: number) => {
    const feel = feelAt(t);
    return feel === 'calm' || feel === 'breakdown';
  };
  const busyAt = (t: number) => {
    const s = map.sections[sectionIndexAt(t)];
    if (!s || feelAt(t) !== 'build') return 1;
    return 1 + BUILD_DENSER * Math.max(0, Math.min(1, (t - s.start) / (s.end - s.start)));
  };

  const floorAt = (t: number) => {
    const feel = feelAt(t);
    if (feel === 'calm' || feel === 'breakdown') return 0;
    return feel === 'chorus' || feel === 'drop' ? settings.peakFloor : settings.busyFloor;
  };

  const runIn = map.downbeats.find((d) => d >= RUN_IN_SECONDS) ?? map.duration;
  const lastBar = [...map.downbeats].reverse().find((d) => d <= map.duration - RUN_OUT_SECONDS);
  const runOut = lastBar !== undefined && lastBar > runIn ? lastBar : runIn;
  const bars = map.downbeats.filter((d) => d >= runIn && d < runOut);
  const barEnd = (i: number) => map.downbeats.find((d) => d > bars[i]!) ?? runOut;
  // Each drop's set piece starts on the first bar at or after it.
  const dropBars = new Set<number>();
  for (const e of map.events) {
    if (e.kind !== 'drop') continue;
    const i = bars.findIndex((b) => b >= e.time - 1e-6);
    if (i >= 0) for (let k = 0; k < DROP_BARS && i + k < bars.length; k++) dropBars.add(i + k);
  }
  const plans = planBars(
    map,
    momentsOf(map, settings, seed),
    bars,
    barEnd,
    dropBars,
    calmAt,
    busyAt,
    settings,
    floorAt,
  );
  const drops: { start: number; end: number }[] = [];

  const chunk = (start: number, end: number, planned: number, kept: number, repairs: number) =>
    track.chunks.push({
      start,
      end,
      section: sectionAt(start),
      feel: feelAt(start),
      planned,
      kept,
      repairs,
    });

  chunk(0, runIn, 0, 0, 0);
  let explorer = Explorer.start(world);
  if (!explorer.run(searchEnd(runIn)))
    throw new TrackGenerationError('Nobody gets through the run-in');

  let lastKick: number | null = null;
  for (let i = 0; i < bars.length;) {
    let span = 1;
    if (dropBars.has(i)) {
      // The drop's set piece: every lane open.
      while (dropBars.has(i + span) && span < DROP_BARS) span++;
      const start = bars[i]!;
      const end = barEnd(i + span - 1);
      drops.push({ start, end });
      if (!explorer.run(searchEnd(end)))
        throw new TrackGenerationError('Nobody gets through a drop');
      chunk(start, end, 0, 0, 0);
      i += span;
      continue;
    }
    const beatOf = (k: number) => beatAt(map, barEnd(k));
    // Take the next bar in while an obstacle runs past the last one (a few bars at most).
    while (
      span < 6 &&
      i + span < bars.length &&
      !dropBars.has(i + span) &&
      plans.slice(i, i + span).some((p) => p.some((m) => endOf(m) > beatOf(i + span - 1) + 1e-6))
    )
      span++;
    const start = bars[i]!;
    const end = barEnd(i + span - 1);
    const moments = fitStretch(plans.slice(i, i + span), beatAt(map, start), beatOf(i + span - 1));

    let accepted = false;
    const attempts = attemptsFor(moments);
    for (let a = 0; a < attempts.length && !accepted; a++) {
      const attempt = attempts[a];
      const chosen = !attempt
        ? []
        : attempt.only === 'rare'
          ? moments.filter((m) => RARE.has(m.kind))
          : attempt.only === 'main'
            ? [...moments].sort(byStrength).slice(0, 1)
            : moments;
      const made = compose({ map, settings, lanes, ease: attempt?.ease ?? 2, z, lastKick }, chosen);
      const mark = world.mark();
      world.add(made.obstacles);
      const next = explorer.clone();
      if (next.run(searchEnd(end)) && next.settledLanes().size > 0) {
        explorer = next;
        accepted = true;
        lastKick = made.lastKick;
        chunk(start, end, moments.length, chosen.length, a);
      } else world.truncate(mark);
    }
    if (!accepted)
      throw new TrackGenerationError(`Nobody gets through the bar at ${start.toFixed(2)} s`);
    i += span;
  }

  chunk(runOut, map.duration, 0, 0, 0);
  if (!explorer.run(stepAt(map.duration)))
    throw new TrackGenerationError('Nobody gets through the run-out');
  if (track.chunks.length > 1 && track.chunks[track.chunks.length - 1]!.start >= map.duration)
    track.chunks.pop();

  const made = pickupsFor(track, map, settings, drops, runIn, runOut);
  track.pickups = made.pickups;
  track.holds = made.holds;
  track.boosters = made.boosters;
  track.hoops = made.hoops;
  return track;
}

// ---------- pickups ----------

/** Gems keep this many seconds clear of an obstacle in their lane. */
const GEM_CLEAR = 0.15;
/** A gem is skipped when the obstacles in the next this many seconds… */
const GEM_LOOKAHEAD = 0.8;
/** …would force the racer out of its lane faster than this a lane, plus a reaction. */
const HOP_COST = LANE_HOP_TIME;
const REACTION = 0.15;
/** Gems in a lane are at least this many beats apart. */
const GEM_SPACING = 0.25;
/** A rail lasts at most this many beats. */
const MAX_RAIL_BEATS = 8;
/** A booster is on one of a section's first this many eligible downbeats. */
const BOOSTER_BARS = 4;
/** Boosters are at least this many bars apart. */
const BOOSTER_GAP_BARS = 6;
/** Bars in a hoop phrase, and how many bars after the first phrase a second one starts. */
const HOOP_BARS = 4;
const HOOP_AGAIN_BARS = 8;
/** Boosters and hoops stay this many seconds clear of every obstacle in their lane. */
const EXTRA_CLEAR = 0.3;
/** Boosters and hoops start no sooner after the run-in and end no later before the run-out. */
const EXTRA_EDGE = 2;

/** The first obstacle whose time is at least `t`. */
function firstFrom(obstacles: readonly Obstacle[], t: number): number {
  let lo = 0;
  let hi = obstacles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (obstacles[mid]!.time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The pickups: a wave of gems in every lane on each beat of a drop's set piece, a rail
 * of gems along one lane while a note holds (a ring of light while a chord or a cymbal
 * rings), and gems on hi-hats (and off-beats where there are no hats) in the lanes the
 * obstacles leave free. Never in a lane an obstacle soon after forces the racer out of
 * too late to reach a free one.
 */
function pickupsFor(
  track: TunnelTrack,
  map: LevelMap,
  settings: DifficultySettings,
  drops: { start: number; end: number }[],
  from: number,
  to: number,
): { pickups: Pickup[]; holds: Hold[]; boosters: Booster[]; hoops: Hoop[] } {
  const { obstacles, lanes } = track;
  const z = (t: number) => zAtTime(track, t);
  const pickups: Pickup[] = [];
  const holds: Hold[] = [];
  const blocks = (o: Obstacle, lane: number) => hits(o, lane, 0, o.time);

  /** True when a gem at `t` in `lane` is clear of obstacles and leaves time to steer away. */
  const fits = (t: number, lane: number) => {
    for (let i = firstFrom(obstacles, t - GEM_CLEAR); i < obstacles.length; i++) {
      const o = obstacles[i]!;
      if (o.time > t + GEM_LOOKAHEAD) break;
      if (!blocks(o, lane)) continue;
      if (Math.abs(o.time - t) <= GEM_CLEAR) return false;
      if (o.low) continue;
      // The nearest lane the obstacle leaves free must be reachable in time.
      let nearest = Infinity;
      for (let k = 0; k < lanes; k++)
        if (!blocks(o, k)) nearest = Math.min(nearest, Math.abs(k - lane));
      if (nearest * HOP_COST + REACTION > o.time - t) return false;
    }
    return true;
  };
  const inDark = (t: number) => track.dark.some((d) => t >= d.time && t < d.end);
  const taken = (t: number, lane: number) => {
    const spacing = GEM_SPACING * periodAt(map, t);
    return pickups.some((p) => p.lane === lane && Math.abs(p.time - t) < spacing);
  };
  const add = (kind: Pickup['kind'], t: number, lane: number) => {
    if (taken(t, lane) || !fits(t, lane)) return false;
    pickups.push({ kind, time: t, z: z(t), lane });
    return true;
  };

  // The drops' waves.
  for (const d of drops)
    for (let b = Math.round(beatAt(map, d.start)); timeOfBeat(map, b) < d.end - 1e-6; b++)
      for (let lane = 0; lane < lanes; lane++) add('gem', timeOfBeat(map, b), lane);

  // A squeeze's single open line: gems along it every half beat through the bar.
  const squeezes: { start: number; end: number }[] = [];
  {
    const walls = obstacles.filter((o) => o.kind === 'squeeze');
    for (let i = 0; i < walls.length;) {
      let j = i + 1;
      while (
        j < walls.length &&
        walls[j]!.time - walls[j - 1]!.time < 1.5 * periodAt(map, walls[j]!.time)
      )
        j++;
      const group = walls.slice(i, j);
      i = j;
      const open = Array.from({ length: lanes }, (_, k) => k).filter(
        (k) => !group.some((o) => blocks(o, k)),
      );
      const first = beatAt(map, group[0]!.time);
      const lastBeat = beatAt(map, group[group.length - 1]!.time);
      squeezes.push({ start: timeOfBeat(map, first - 1), end: timeOfBeat(map, lastBeat + 0.5) });
      if (open.length === 0) continue;
      for (let b = first - 1; b <= lastBeat + 0.5 + 1e-6; b += 0.5)
        add('gem', timeOfBeat(map, b), open[0]!);
    }
  }

  // Held sounds: a rail along the freest lane, or a ring.
  for (const s of map.features.sustains) {
    if (s.time < from || s.time >= to) continue;
    const end = Math.min(s.end, to, timeOfBeat(map, beatAt(map, s.time) + MAX_RAIL_BEATS));
    if (s.sound !== 'note') {
      holds.push({
        kind: 'ring',
        sound: s.sound,
        time: s.time,
        end,
        z0: z(s.time),
        z1: z(end),
        lane: null,
      });
      continue;
    }
    let best = Math.floor(lanes / 2);
    let fewest = Infinity;
    for (let lane = 0; lane < lanes; lane++) {
      let count = 0;
      for (
        let i = firstFrom(obstacles, s.time);
        i < obstacles.length && obstacles[i]!.time < end;
        i++
      )
        if (blocks(obstacles[i]!, lane)) count++;
      const score = count + Math.abs(lane - (lanes - 1) / 2) * 0.01;
      if (score < fewest) {
        fewest = score;
        best = lane;
      }
    }
    holds.push({
      kind: 'rail',
      sound: 'note',
      time: s.time,
      end,
      z0: z(s.time),
      z1: z(end),
      lane: best,
    });
    for (let b = beatAt(map, s.time); timeOfBeat(map, b) < end - 1e-6; b += 0.5)
      add('rail', timeOfBeat(map, b), best);
  }

  // Hats, and off-beats where there are none for a while, following a line of gems.
  const hats = map.events.filter((e) => e.kind === 'hat' && e.intensity >= 0.25);
  const times: number[] = hats.filter((_, i) => i % settings.gemEvery === 0).map((e) => e.time);
  const inSqueeze = (t: number) => squeezes.some((q) => t >= q.start - 1e-6 && t <= q.end + 1e-6);
  for (const e of map.events) {
    if (e.kind !== 'offbeat' || e.intensity < 0.4) continue;
    const period = periodAt(map, e.time);
    if (!hats.some((h) => Math.abs(h.time - e.time) < period)) times.push(e.time);
  }
  times.sort((a, b) => a - b);
  let line = track.startLane;
  const linePoints: { time: number; lane: number }[] = [];
  for (const t of times) {
    if (t < from || t >= to || inDark(t) || drops.some((d) => t >= d.start && t < d.end)) continue;
    if (inSqueeze(t)) continue;
    const order = Array.from({ length: lanes }, (_, k) => k).sort(
      (a, b) => Math.abs(a - line) - Math.abs(b - line) || a - b,
    );
    for (const lane of order)
      if (add('gem', t, lane)) {
        line = lane;
        linePoints.push({ time: t, lane });
        break;
      }
  }
  pickups.sort((a, b) => a.time - b.time || a.lane - b.lane);

  // Boosters and hoops: where the gems' line is, so a player chasing gems reaches them.
  const inDrop = (t: number) => drops.some((d) => t >= d.start - 1e-6 && t < d.end);
  /** Where the gems' line is at `t`: its last gem's lane. */
  const lineAt = (t: number) => {
    let lane = track.startLane;
    for (const p of linePoints) {
      if (p.time > t) break;
      lane = p.lane;
    }
    return lane;
  };
  /** Free for an extra: not in a stop, a drop's set piece or the edges, and clear of obstacles. */
  const freeFor = (t: number, lane: number) => {
    if (t < from + EXTRA_EDGE || t >= to - EXTRA_EDGE || inDrop(t)) return false;
    if (track.dark.some((d) => t >= d.time - 0.5 && t < d.end + 0.1)) return false;
    for (let i = firstFrom(obstacles, t - EXTRA_CLEAR); i < obstacles.length; i++) {
      const o = obstacles[i]!;
      if (o.time > t + EXTRA_CLEAR) break;
      if (blocks(o, lane)) return false;
    }
    return fits(t, lane);
  };
  /** The lanes within `reach` of `around`, nearest first (on a tie the one towards `prefer`). */
  const nearby = (around: number, reach: number, prefer = -1) =>
    Array.from({ length: lanes }, (_, k) => k)
      .filter((k) => Math.abs(k - around) <= reach)
      .sort(
        (a, b) =>
          Math.abs(a - around) - Math.abs(b - around) ||
          (b - around) * prefer - (a - around) * prefer ||
          a - b,
      );
  const downs = map.downbeats;

  // At most one booster a section, on its first phrase's downbeats, several bars apart.
  const boosters: Booster[] = [];
  let lastBar = -Infinity;
  for (const look of track.looks) {
    let tried = 0;
    for (let bar = 0; bar < downs.length && tried < BOOSTER_BARS; bar++) {
      const t = downs[bar]!;
      if (t < look.start - 1e-6) continue;
      if (t >= look.end - 1e-6) break;
      if (t < from + EXTRA_EDGE || t >= to - EXTRA_EDGE || inDrop(t) || inDark(t)) continue;
      tried++;
      if (bar - lastBar < BOOSTER_GAP_BARS) break;
      const lane = nearby(lineAt(t), 1).find((k) => freeFor(t, k));
      if (lane === undefined) continue;
      boosters.push({
        kind: boosterFor(look.feel, boosters[boosters.length - 1]?.kind),
        time: t,
        z: z(t),
        lane,
      });
      lastBar = bar;
      break;
    }
  }

  // Boost hoops on the downbeats of a chorus's or a drop's first phrase (and again 8 bars
  // on), each a lane from the last at most; a fill's slalom ends in one on the bar line.
  const hoops: Hoop[] = [];
  let group = 0;
  for (const look of track.looks) {
    if (look.feel !== 'chorus' && look.feel !== 'drop') continue;
    const bars: number[] = [];
    downs.forEach((t, bar) => {
      if (t >= look.start - 1e-6 && t < look.end - 1e-6) bars.push(bar);
    });
    const phrase = (first: number) => {
      const set = bars.slice(first, first + HOOP_BARS);
      if (set.length < HOOP_BARS) return false;
      const made: Hoop[] = [];
      let lane = lineAt(downs[set[0]!]!);
      const dir = new Random(hashOf(track.seed, 'hoops', set[0]!)).next() < 0.5 ? -1 : 1;
      for (const [slot, bar] of set.entries()) {
        const t = downs[bar]!;
        const next = nearby(lane, 1, dir).find((k) => freeFor(t, k));
        if (next === undefined) return false;
        lane = next;
        made.push({ kind: 'phrase', time: t, z: z(t), lane, group, slot, size: HOOP_BARS });
      }
      hoops.push(...made);
      group++;
      return true;
    };
    // The first phrase that fits (a drop's set piece is skipped), then one more later.
    let start = 0;
    while (start + HOOP_BARS <= bars.length && !phrase(start)) start++;
    if (start + HOOP_AGAIN_BARS + HOOP_BARS <= bars.length) phrase(start + HOOP_AGAIN_BARS);
  }
  for (const f of map.features.fills) {
    const slalom = obstacles.filter(
      (o) => o.kind === 'slalom' && o.time >= f.time - 1e-6 && o.time < f.end - 1e-6,
    );
    const last = slalom[slalom.length - 1];
    if (!last || f.end < from || inDark(f.end)) continue;
    // A lane the last block leaves open, the nearest to the centre.
    const lane = nearby((lanes - 1) / 2, lanes).find((k) => !blocks(last, k) && freeFor(f.end, k));
    if (lane === undefined) continue;
    hoops.push({ kind: 'fill', time: f.end, z: z(f.end), lane, group: group++, slot: 0, size: 1 });
  }
  hoops.sort((a, b) => a.time - b.time || a.lane - b.lane);
  return { pickups, holds, boosters, hoops };
}

/** The boosters, in the order a repeated kind gives way to the next. */
const BOOSTER_KINDS: readonly BoosterKind[] = ['magnet', 'surge', 'shield'];

/**
 * Which booster a section gets: a build a shield (for the drop), a chorus or a drop a
 * surge (the gems are thick), the rest a magnet. Never the same as the one before: it
 * takes the next kind instead.
 */
function boosterFor(feel: SectionFeel, before: BoosterKind | undefined): BoosterKind {
  const want: BoosterKind =
    feel === 'build' ? 'shield' : feel === 'chorus' || feel === 'drop' ? 'surge' : 'magnet';
  if (want !== before) return want;
  return BOOSTER_KINDS[(BOOSTER_KINDS.indexOf(want) + 1) % BOOSTER_KINDS.length]!;
}
