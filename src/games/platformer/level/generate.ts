import {
  beatAt,
  beatIndexAt,
  curveAt,
  hashOf,
  periodAt,
  Random,
  segmentAt,
  timeOfBeat,
  type Difficulty,
  type LevelMap,
  type SectionFeel,
  type SectionKind,
} from '../../../core';
import {
  ANCHOR_X,
  COYOTE_TIME,
  DASH_TIME,
  GRAVITY,
  JUMP_AIR,
  JUMP_VELOCITY,
  PHYSICS_DT,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  SPIKE_HEIGHT,
  SPIKE_MERCY,
  STEP_UP,
  startState,
  stepPlayer,
  VIEW_AHEAD,
  VIEW_BEHIND,
  type PlayerState,
} from '../physics';
import {
  BOOSTER_KINDS,
  GATE_GRACE,
  LevelWorld,
  LOWEST_TOP,
  scrollFor,
  solidTop,
  timeAtX,
  xAtTime,
  type Ability,
  type ChunkKind,
  type Gate,
  type Obstacle,
  type ObstacleKind,
  type Pickup,
  type PlatformerLevel,
  type Solid,
  type SpikeStrip,
  type TerrainStyle,
} from './level';
import { endsHeaving, HEAVE_MAX, shapeTerrain } from './terrain';
import { DECISION_STEPS, Explorer, stepAt } from './validate';

/**
 * Builds the platformer's level from a song's level map. Every obstacle comes from a
 * musical moment the core found, and the music sizes it (the grammar, `momentsOf`): a
 * pit over a held sound as long as it holds, a pit over a stop landing as the band comes
 * back, gaps on kicks, bridges on snares, dash gates on accents, spikes on syncopations,
 * slam plates on heavy kicks, steps on a fill's hits. How many of the
 * common ones a bar gets follows how busy the music is; a bar the song repeats gets the
 * same obstacles as the first time. Difficulty scales the sizes, never the moments.
 *
 * Built a bar or two at a time, each stretch checked with the validator as it goes: a
 * stretch nobody can get through is built again with its obstacles shrunk on the same
 * moments (narrower pits, lower steps, longer bridges, a ledge in a pit, then only its
 * main obstacle) and, as a last resort, as flat ground, which is always passable. Seeded
 * by the song and the difficulty, so the same song always gives the same level.
 */

export interface DifficultySettings {
  /** Share of the common moments (kicks, snares, syncopations) that become obstacles. */
  hazard: number;
  /** Air time over a gap on a kick, as a share of a full jump's (`JUMP_AIR`). */
  gap: number;
  /**
   * The longest pit over a held sound or a stop: where its air time may reach between a
   * jump's reach (0) and a jump and dash's (1).
   */
  held: number;
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
  /** Height of each step of a drop's staircase, px (a fill's steps are half that). */
  stepRise: number;
  /** A coin on every n-th hi-hat. */
  coinEvery: number;
  /** Bars the song plays a third time or more get one obstacle of their own as well. */
  variation: boolean;
  /** Fills end in a slam through plates onto the bar line, once slam is taught. */
  slamFills: boolean;
  /** The downbeat opening each phrase of a chorus or a drop gets a slam plate too. */
  phraseSlams: boolean;
}

export const DIFFICULTY: Record<Difficulty, DifficultySettings> = {
  easy: {
    hazard: 0.3,
    gap: 0.35,
    held: 0.4,
    overhang: 1,
    clearance: 30,
    rise: 36,
    spike: 0.3,
    bridgeHold: 1.75,
    eqRange: 50,
    eqGap: 0,
    stepRise: 40,
    coinEvery: 2,
    variation: false,
    slamFills: false,
    phraseSlams: false,
  },
  normal: {
    hazard: 0.7,
    gap: 0.55,
    held: 0.85,
    overhang: 1.5,
    clearance: 22,
    rise: 60,
    spike: 0.45,
    bridgeHold: 1.5,
    eqRange: 80,
    eqGap: 0.15,
    stepRise: 52,
    coinEvery: 1,
    variation: false,
    slamFills: true,
    phraseSlams: false,
  },
  hard: {
    hazard: 0.9,
    gap: 0.75,
    held: 1,
    overhang: 2,
    clearance: 16,
    rise: 80,
    spike: 0.65,
    bridgeHold: 1.25,
    eqRange: 110,
    eqGap: 0.25,
    stepRise: 64,
    coinEvery: 1,
    variation: true,
    slamFills: true,
    phraseSlams: true,
  },
};

/** Most air a jump alone gives over a pit at the same height: a jump at the last moment. */
export const JUMP_REACH = JUMP_AIR + COYOTE_TIME;
/** Most air a jump and a dash at its peak give. */
export const DASH_REACH = JUMP_REACH + DASH_TIME;
/** A dash pit needs at least this much more air than a jump gives, so it takes a dash. */
const DASH_MARGIN = 0.04;
/** The longest pit before the dash is taught: a jump comfortably clears it. */
const JUMP_ONLY_AIR = JUMP_AIR * 0.95;
/** Shorter pits than this aren't worth a jump: the moment gets none. */
const MIN_AIR = 0.15;
/** A slam plate's drop is at least this much more than the ceiling's clearance, px. */
const PLATE_MARGIN = 12;
/** The latest the ceiling may come after the jump before it: a full jump is still high. */
const OVERHANG_LATEST = JUMP_AIR - 0.13;
/** Heights the ground stays between, and where it starts. */
export const MIN_TOP = LOWEST_TOP;
export const MAX_TOP = 320;
/** Overhangs reach up out of the view, so there is no going over them. */
const SKY = MAX_TOP + 800;
const START_TOP = 40;
/** How far the ground climbs with the song's energy, from its start height, px. */
const CONTOUR_RANGE = 140;
/** The small step a calm stretch takes toward the energy's height, on a kick, px. */
const CALM_STEP = 24;
/** A groove's (and a chorus's) steps toward the energy's height, as a share of `rise`. */
const CONTOUR_STEP = 0.6;
/** A build climbs a step each stretch, this share of `rise` (at least `CALM_STEP`)… */
const CLIMB_STEP = 0.5;
/** …up to this high, leaving room above for what comes. */
const CLIMB_TOP = MAX_TOP - 80;
/** By the end of a build, this many more common obstacles than its music alone gives. */
const BUILD_DENSER = 0.8;
/** Seconds of plain ground at the start and the end of every level. */
const RUN_IN_SECONDS = 3;
const RUN_OUT_SECONDS = 3;
/** Steps narrower than this count two beats each, for fast songs. */
const MIN_STEP_WIDTH = 70;
/** Bars narrower than this are built two at a time, px. */
const MIN_BAR_WIDTH = 340;
/** Coins are at least this far apart, and from gems and boosters, px. */
const COIN_SPACING = 26;
/** At most one booster in this many bars, the first in the song's second section. */
const BOOSTER_BARS = 8;
/** A booster sits this far above the head at the top of a full jump, px. */
const BOOSTER_ABOVE = 6;
/** The drop staircase's steps. */
const STAIR_STEPS = 7;
/** Gems in the arc over the drop's plateau. */
const PLATEAU_GEMS = 5;
/** A fill's steps: at most this many, its hits at least this far apart (s). */
const FILL_STEPS = 8;
const FILL_STEP_GAP = 0.1;
/** The top of a fill's first step is at most this high above the ground before it, px. */
const RISER_MAX = 120;
/** The player meets a fill's first step this long before its first hit, s. */
const RISER_LEAD = 0.25;
/** A gap's kick is at most this far (beats) from a beat or an "and". */
const KICK_ON_GRID = 0.08;
/**
 * A slam plate stands this high over the ground it breaks through to: a fill's last steps
 * over the ground, a heavy kick's floor over ground this much lower.
 */
const SLAM_DROP = 56;
/** A fill ending in a slam: its last steps are plates, the ceiling straight after them. */
const PLATE_STEPS = 2;
/** That ceiling lasts this many beats, so the bar after the fill starts free. */
const SLAM_CEILING = 0.75;
/**
 * A slam plate on a heavy kick starts this long before the kick, where the ceiling starts,
 * about a beat at 120 BPM: time to jump and slam through it.
 */
const SLAM_APPROACH = Math.min(OVERHANG_LATEST, 0.5);
/** Kicks this much stronger than every kick in the two bars before are heavy. */
const HEAVY_KICK = 1.15;
/** Bars in a phrase: a loop of a bar or two repeats its obstacles a phrase at a time. */
const PHRASE_BARS = 4;
/** Common obstacles in a bar at full activity and hazard 1. */
const COMMON_PER_BAR = 3.5;

/** A stretch to build: one bar, or more for a drop, a fast song or what overruns a bar. */
interface Stretch {
  start: number;
  end: number;
  /** Seconds per beat where it starts: the tempo segment's period. */
  period: number;
  /** The beats it is laid out on (every beat, or every other one for fast songs). */
  steps: number[];
}

// ---------- the grammar: musical moments ----------

/** The obstacle a musical moment becomes. */
type MomentKind = Exclude<ObstacleKind, 'drop'>;

/** A musical moment an obstacle can sit on, in beats on the song's grid. */
interface Moment {
  kind: MomentKind;
  /** Its beat: the hit, the held sound's start, the stop's start, a fill's first hit. */
  beat: number;
  /** How long it lasts, in beats: the held sound, the stop, a fill up to its bar line. */
  length: number;
  /** A fill's hits, in beats. */
  hits?: number[];
  strength: number;
  /** What it is in the music, in words: "held chord", "band stops", "kick". */
  what: string;
  /** The beats it takes up: from its approach to the plain ground after it. */
  from: number;
  to: number;
  /** The song's bar (from 1) it repeats, when it comes from a bar played before. */
  repeats?: number;
}

/** Which moment wins where two would overlap, and gives a stretch its name. */
const SALIENCE: Record<ObstacleKind, number> = {
  drop: 10,
  stop: 8,
  held: 7,
  stairs: 6,
  gate: 5,
  slam: 4,
  eq: 3.5,
  spikes: 3,
  bridge: 2,
  kick: 1,
};

/** Moments rare enough that every one becomes an obstacle, however busy the bar. */
const RARE: ReadonlySet<MomentKind> = new Set(['stop', 'held', 'stairs', 'gate', 'slam']);
/** Common moments a calm section (intro, breakdown, outro) leaves as plain ground. */
const BUSY_ONLY: ReadonlySet<MomentKind> = new Set(['spikes', 'bridge', 'eq']);

/** The air time of a pit too wide to jump, `share` of the way from a jump's reach to a dash's. */
export function dashPitAir(share: number): number {
  // Up to what a jump right on the edge and a dash at its top give, without coyote time.
  const low = JUMP_REACH + DASH_MARGIN;
  const high = JUMP_AIR + DASH_TIME - DASH_MARGIN;
  return low + Math.max(0, Math.min(1, share)) * (high - low);
}

/** Beats as a short number: 2, 1.5, 1.75. */
const beatsText = (beats: number) => {
  const text = (Math.round(beats * 4) / 4).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${text} beat${text === '1' ? '' : 's'}`;
};

/**
 * Every musical moment of the song as a candidate obstacle, with the beats it takes up at
 * full size. Kicks and snares come from the level map's events; held sounds, stops,
 * accents, fills and syncopations from its features; heavy kicks are kicks clearly
 * stronger than every kick in the two bars before.
 */
function momentsOf(map: LevelMap, settings: DifficultySettings): Moment[] {
  const b = (t: number) => beatAt(map, t);
  const beatsOf = (t: number, seconds: number) => seconds / periodAt(map, t);
  const moments: Moment[] = [];
  const { sustains, stops, accents, fills, syncopations } = map.features;
  const longest = dashPitAir(settings.held);

  for (const s of sustains) {
    const beat = b(s.time);
    const length = b(s.end) - beat;
    const air = beatsOf(s.time, Math.min(s.end - s.time, longest));
    const what = s.sound === 'ring' ? 'ringing cymbal' : `held ${s.sound}`;
    moments.push({
      kind: 'held',
      beat,
      length,
      strength: s.strength,
      what,
      from: beat - 0.25,
      to: beat + air + 0.75,
    });
  }
  for (const s of stops) {
    const beat = b(s.time);
    const length = b(s.end) - beat;
    moments.push({
      kind: 'stop',
      beat,
      length,
      strength: 1,
      what: 'band stops',
      from: beat - 0.25,
      to: beat + length + 0.75,
    });
  }
  for (const a of accents) {
    const beat = b(a.time);
    moments.push({
      kind: 'gate',
      beat,
      length: 0,
      strength: a.strength,
      what: 'accent',
      from: beat - 0.5,
      to: beat + 0.75,
    });
  }
  for (const f of fills) {
    const hits = f.hits.map(b);
    const beat = hits[0]!;
    const line = b(f.end);
    moments.push({
      kind: 'stairs',
      beat,
      length: line - beat,
      hits,
      strength: 1,
      what: 'fill',
      from: b(f.time - RISER_LEAD) - 0.75,
      to: line + SLAM_CEILING + 0.25,
    });
  }
  for (const s of syncopations) {
    const beat = b(s.time);
    moments.push({
      kind: 'spikes',
      beat,
      length: 0,
      strength: s.strength,
      what: 'off-beat hit',
      from: beat - 0.5,
      to: beat + settings.spike + 0.75,
    });
  }

  const kicks = map.events.filter((e) => e.kind === 'kick' && e.intensity >= 0.35);
  kicks.forEach((k, i) => {
    const beat = b(k.time);
    const period = periodAt(map, k.time);
    const air = settings.gap * JUMP_AIR;
    // A gap only on a kick on the beat or the "and": one on a sixteenth is a chug or a
    // pickup, and a jump there feels random (a strong one is a syncopation: spikes).
    const eighths = beat * 2;
    if (Math.abs(eighths - Math.round(eighths)) <= KICK_ON_GRID * 2)
      moments.push({
        kind: 'kick',
        beat,
        length: 0,
        strength: k.intensity,
        what: 'kick',
        from: beat - 0.25,
        to: beat + air / period + 0.75,
      });
    // Heavy: clearly stronger than every kick in the two bars before it.
    if (k.intensity < 0.8) return;
    let loudest = -1;
    for (let j = i - 1; j >= 0 && kicks[j]!.time >= k.time - 8 * period; j--)
      if (kicks[j]!.time < k.time - 0.1 * period) loudest = Math.max(loudest, kicks[j]!.intensity);
    if (loudest <= 0 || k.intensity < HEAVY_KICK * loudest) return;
    moments.push(slamMoment(beat, period, k.intensity, 'heavy kick'));
  });
  // On hard, the downbeat opening each phrase of a chorus or a drop too, unless it has
  // an accent: a crash there is a dash gate.
  if (settings.phraseSlams)
    for (const d of map.downbeats) {
      const period = periodAt(map, d);
      const accented = accents.some((a) => Math.abs(a.time - d) <= period / 4);
      if (!accented && opensPhrase(map, d)) moments.push(slamMoment(b(d), period, 0.5, 'phrase'));
    }
  function slamMoment(beat: number, period: number, strength: number, what: string): Moment {
    return {
      kind: 'slam',
      beat,
      length: 0,
      strength,
      what,
      from: beat - SLAM_APPROACH / period - 0.25,
      to: beat + settings.overhang + 0.5,
    };
  }
  for (const e of map.events) {
    if (e.kind !== 'snare' || e.intensity < 0.3) continue;
    const beat = b(e.time);
    moments.push({
      kind: 'bridge',
      beat,
      length: 0,
      strength: e.intensity,
      what: 'snare',
      from: beat - 0.1,
      to: beat + Math.min(3, settings.bridgeHold) + 0.5,
    });
  }
  return moments;
}

/** True when `t` is on the downbeat opening a phrase of a chorus or a drop. */
function opensPhrase(map: LevelMap, t: number): boolean {
  const i = map.sections.findIndex((s) => t >= s.start - 1e-6 && t < s.end);
  const feel = map.moods?.[i]?.feel;
  if (feel !== 'chorus' && feel !== 'drop') return false;
  const period = periodAt(map, t);
  const bar = map.downbeats.findIndex((d) => Math.abs(d - t) <= 0.1 * period);
  if (bar < 0) return false;
  const first = map.downbeats.findIndex((d) => d >= map.sections[i]!.start - 0.1 * period);
  return (bar - first) % PHRASE_BARS === 0;
}

/** Strongest first: by salience, then strength, then time. */
const byStrength = (a: Moment, b: Moment) =>
  SALIENCE[b.kind] - SALIENCE[a.kind] || b.strength - a.strength || a.beat - b.beat;

const overlaps = (a: Moment, b: Moment) => a.from < b.to - 1e-6 && b.from < a.to - 1e-6;

/** Beats of plain ground after an obstacle that may lie in the next stretch. */
const RECOVERY = 0.5;
/** Where the obstacle itself is over, in beats: what a stretch must hold. */
const endOf = (m: Moment) => m.to - RECOVERY;
/**
 * The beat a moment belongs to its bar by: its own, or where its approach starts for a
 * slam plate (its plate before the kick) or a fill's steps (the riser before).
 */
const ownBeat = (m: Moment) => (m.kind === 'slam' || m.kind === 'stairs' ? m.from : m.beat);

/** Moments shifted by whole beats, for a bar the song plays again. */
function shifted(m: Moment, by: number, repeats: number): Moment {
  return {
    ...m,
    beat: m.beat + by,
    from: m.from + by,
    to: m.to + by,
    hits: m.hits?.map((h) => h + by),
    repeats,
  };
}

/**
 * The obstacles each bar gets, from the moments it owns: every rare moment that fits,
 * and as many common ones as the music is busy (its kicks and snares per beat and its
 * energy, times the difficulty's hazard), strongest first, never overlapping. A moment
 * belongs to the bar its beat is in; a low ceiling or a fill's steps to the bar its
 * approach starts in. A bar the song repeats takes the first bar's obstacles again, each
 * on its own moment there (a moment the repeat doesn't have is left out); on hard, from
 * the third time on, with one more of its own. A build gets denser as it goes: `busyAt`
 * scales how many common ones a bar gets.
 */
function planBars(
  map: LevelMap,
  settings: DifficultySettings,
  bars: number[],
  barEnd: (i: number) => number,
  calmAt: (t: number) => boolean,
  busyAt: (t: number) => number,
  seed: number,
): Moment[][] {
  const all = momentsOf(map, settings).filter((m) => m.from >= beatAt(map, bars[0] ?? 0) - 1e-6);
  const own: Moment[][] = bars.map(() => []);
  for (const m of all) {
    const t = timeOfBeat(map, ownBeat(m));
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
  /** Each bar's repeat group, by index. */
  const groups: number[] = [];
  const times = new Map<number, number>();
  let carry = 0;
  bars.forEach((start, i) => {
    const end = barEnd(i);
    const calm = calmAt(start);
    // Calm sections leave out the busy music's obstacles, each by its own moment's section.
    const calmMoment = (m: Moment) => calmAt(timeOfBeat(map, m.beat)) && BUSY_ONLY.has(m.kind);
    const mine = own[i]!.filter((m) => !calmMoment(m)).sort(byStrength);
    const first = beatAt(map, start);
    const last = beatAt(map, end);

    // How busy the music is: kicks and snares per beat, and the energy.
    const hits = events.filter((e) => e.time >= start - 1e-6 && e.time < end - 1e-6).length;
    let energy = 0;
    let beats = 0;
    for (let k = Math.round(first); k < Math.round(last); k++, beats++)
      energy += map.energy[k] ?? 0;
    const rate = hits / Math.max(1, last - first);
    const activity =
      0.6 * Math.max(0, Math.min(1, (rate - 0.5) / 2)) + 0.4 * (beats > 0 ? energy / beats : 0);
    // Whole obstacles, the fractions carried on to the next bar, so a hazard of 0.45
    // gives about half as many as 0.9 however busy each bar is.
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
    const pick = (into: Moment[], from: Moment[], commons: number) => {
      for (const m of from) {
        if (into.some((c) => overlaps(c, m)) || blocked(m)) continue;
        if (RARE.has(m.kind)) take(into, m);
        else if (commons > 0) {
          take(into, m);
          commons--;
        }
      }
    };

    // A bar the song played before: the same obstacles on the same moments, as that bar
    // had a phrase back when the song played it there, else the first time, unless that
    // is under a phrase ago (a loop of a bar or two): then the loop's first phrase is
    // planned afresh, and repeats as a phrase.
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
        // Its moment is here too (a low ceiling's kick may read a touch less heavy).
        const like = (o: Moment) => o.kind === m.kind || (m.kind === 'slam' && o.kind === 'kick');
        const here =
          m.kind === 'eq'
            ? mine.filter((o) => o.kind === 'kick').length >= 3
            : all.some((o) => like(o) && Math.abs(o.beat - m.beat) <= 0.15);
        // A bar played again wins over a common obstacle of the bar before: the repeat
        // stays as the player learned it.
        if (here && !blocked(m, true) && !calmMoment(m)) take(plan, m);
      }
      const seen = (times.get(group) ?? 1) + 1;
      times.set(group, seen);
      if (settings.variation && seen >= 3)
        pick(
          plan,
          mine.filter((m) => !RARE.has(m.kind)),
          1,
        );
      plans.push(plan);
      return;
    }
    if (g >= 0 && !firstOf.has(group)) firstOf.set(group, i);
    if (!times.has(group)) times.set(group, 1);

    const plan: Moment[] = [];
    pick(plan, mine, common);
    // Kicks alone, with the bass pumping under them: a gap on the strongest, or the
    // equalisers that move with the bass. The one tie the music leaves open.
    const kicks = mine.filter((m) => m.kind === 'kick').length;
    const rng = new Random(hashOf(seed, 'bar', i));
    if (!calm && kicks >= 3 && plan.length > 0 && plan.every((m) => m.kind === 'kick')) {
      if (rng.chance(0.5))
        plan.splice(0, plan.length, {
          kind: 'eq',
          beat: first,
          length: last - first,
          strength: 1,
          what: 'bass',
          from: first,
          to: last,
        });
    }
    plans.push(plan);
  });
  return plans;
}

// ---------- building ----------

interface BuildContext {
  map: LevelMap;
  settings: DifficultySettings;
  /** 1 as planned, smaller to make it easier. */
  ease: number;
  /**
   * The same for the common obstacles (gaps, bridges, spikes, equalisers), which calm
   * sections also make easier. Held sounds, stops, fills and accents keep their size.
   */
  common: (t: number) => number;
  /** Add ledges in pits. */
  support: boolean;
  /** Height the stretch starts at. */
  h: number;
  stretch: Stretch;
  x: (t: number) => number;
  /** The song time the player is at `x`. */
  timeAt: (x: number) => number;
  /** Abilities the player has been taught by now (and the one this stretch teaches). */
  abilities: ReadonlySet<Ability>;
  /** Every snare's time, for the bridges' windows. */
  snares: number[];
  calm: boolean;
  /** How the stretch's ground looks and moves: it sets the steps plain ground takes. */
  style: TerrainStyle;
}

interface Built {
  kind: ChunkKind;
  solids: Solid[];
  spikes: SpikeStrip[];
  gates: Gate[];
  pickups: Pickup[];
  obstacles: Obstacle[];
  /** Height the stretch ends at: it always ends on plain ground at this height. */
  h: number;
  /** When the player meets the obstacle needing an ability, and is past it, for a lesson. */
  focus: Partial<Record<Ability, { time: number; end: number }>>;
  /** Ground whose height an obstacle needs (slam plates, a fill's steps): the terrain keeps it. */
  fixed: Set<Solid>;
}

const clampTop = (h: number) => Math.max(MIN_TOP, Math.min(MAX_TOP, h));
const ground = (x0: number, x1: number, top: number): Solid => ({ kind: 'ground', x0, x1, top });
const built = (kind: ChunkKind, solids: Solid[], h: number, more: Partial<Built> = {}): Built => ({
  kind,
  solids,
  spikes: [],
  gates: [],
  pickups: [],
  obstacles: [],
  focus: {},
  fixed: new Set(),
  h,
  ...more,
});

function flat({ stretch, x, h }: BuildContext, kind: ChunkKind = 'flat'): Built {
  return built(kind, [ground(x(stretch.start), x(stretch.end), h)], h);
}

/**
 * The ground's height for the song's intensity at `t` (the mood curve, smoothed over
 * about a bar): higher where it is louder.
 */
function contourTop(map: LevelMap, t: number): number {
  const level = map.mood?.intensity.length
    ? curveAt(map.mood.intensity, beatAt(map, t))
    : (map.energy[beatIndexAt(map, t)] ?? 0);
  return clampTop(START_TOP + level * CONTOUR_RANGE);
}

/**
 * Where the stretch's plain ground steps to, by its style: a build climbs a step every
 * stretch; elsewhere the ground steps toward the intensity's height when the music has
 * got clearly louder or quieter: up a low step in a calm part, up to `CONTOUR_STEP` of
 * the difficulty's `rise` in a groove or a chorus, and down (no jump needed) up to a
 * whole `rise`, so the ground comes back down soon after a drop's high plateau.
 */
function stepTarget(ctx: BuildContext): { to: number; reason: string } | null {
  const { stretch, h, map, settings } = ctx;
  const size = (share: number) =>
    Math.max(CALM_STEP, settings.rise * share * ctx.common(stretch.start));
  if (ctx.style === 'climb') {
    const to = Math.min(CLIMB_TOP, h + size(CLIMB_STEP));
    return to - h >= CALM_STEP * 0.75 ? { to, reason: 'kick, the build climbing' } : null;
  }
  const target = contourTop(map, stretch.end);
  if (Math.abs(target - h) < CALM_STEP) return null;
  const up = target > h;
  const most = !up ? size(1) : ctx.style === 'float' ? CALM_STEP : size(CONTOUR_STEP);
  return {
    to: clampTop(h + Math.sign(target - h) * Math.min(most, Math.abs(target - h))),
    reason: up ? 'kick, the music getting louder' : 'kick, the music getting quieter',
  };
}

/**
 * The stretch's last stretch of plain ground takes its step (`stepTarget`) on the first
 * kick past the stretch's middle and a beat into the plain ground, with a beat to spare
 * before its end, clear of spikes, gates and ceilings.
 */
function tailStep(ctx: BuildContext, made: Built): Built {
  const { stretch, x, map } = ctx;
  const tail = made.solids[made.solids.length - 1];
  const end = x(stretch.end);
  if (!tail || tail.kind !== 'ground' || made.fixed.has(tail) || Math.abs(tail.x1 - end) > 0.5)
    return made;
  const target = stepTarget({ ...ctx, h: made.h });
  if (!target) return made;
  const earliest = Math.max(
    (stretch.start + stretch.end) / 2,
    ctx.timeAt(tail.x0) + stretch.period,
  );
  const kick = map.events.find(
    (e) => e.kind === 'kick' && e.time >= earliest && e.time <= stretch.end - stretch.period,
  );
  if (!kick) return made;
  const at = x(kick.time) + PLAYER_WIDTH;
  const clear =
    made.spikes.every((s) => s.x1 < at - 40) &&
    made.gates.every((g) => g.x < at - 60) &&
    made.solids.every((s) => s.kind !== 'overhang' || s.x1 < at - 20);
  if (!clear) return made;
  const up = target.to > made.h;
  return {
    ...made,
    solids: [...made.solids.slice(0, -1), { ...tail, x1: at }, ground(at, end, target.to)],
    h: target.to,
    obstacles: [
      ...made.obstacles,
      {
        kind: 'kick',
        time: kick.time,
        end: kick.time + 0.3,
        x0: at,
        x1: at + 1,
        label: up ? 'Step up' : 'Step down',
        reason: target.reason,
      },
    ],
  };
}

/** Plain ground, taking its style's step on a kick (`tailStep`). */
function plain(ctx: BuildContext): Built {
  return tailStep(ctx, flat(ctx, ctx.calm ? 'calm' : 'flat'));
}

/**
 * A pit the player takes off over at song time `takeoff` (its kick) and needs `air` seconds
 * in the air to cross: the ground ends under the player's middle then, so a jump on the
 * kick looks like a jump at the edge and one a little late (half the player, then coyote
 * time) still makes it; the far side starts where their front is `air` after the kick.
 * Returns where the near ground ends and the far one starts.
 */
export function pitAt(x: (t: number) => number, takeoff: number, air: number) {
  return { x0: x(takeoff) + PLAYER_WIDTH / 2, x1: x(takeoff + air) + PLAYER_WIDTH };
}

/**
 * How late after its moment a press may come and still clear what the moment built, s:
 * a gate's grace, so jumps, like dashes, are in time when pressed on the hit.
 */
export const PRESS_GRACE = GATE_GRACE;

/** Seconds from a jump's takeoff until the feet are `height` up. */
export function riseTime(height: number): number {
  const v = JUMP_VELOCITY;
  return (v - Math.sqrt(Math.max(0, v * v - 2 * GRAVITY * height))) / GRAVITY;
}

/**
 * Where something `height` above the ground may start so that a jump pressed on `time`,
 * or up to `PRESS_GRACE` after it, is already that high when the player's front gets
 * there (a physics step for the press to act).
 */
export function clearFrom(x: (t: number) => number, time: number, height: number): number {
  return x(time + PRESS_GRACE + PHYSICS_DT + riseTime(height)) + PLAYER_WIDTH;
}

/**
 * A spike strip `length` long for the hit at song time `time`, on ground at `top`: a jump
 * on the hit (or up to `PRESS_GRACE` after it) is over the spikes when the player reaches them.
 */
export function spikesAt(
  x: (t: number) => number,
  time: number,
  length: number,
  top: number,
): SpikeStrip {
  const x0 = clearFrom(x, time, SPIKE_HEIGHT - SPIKE_MERCY) - SPIKE_MERCY;
  return { x0, x1: x0 + length, top };
}

/**
 * A dash gate for the beat at song time `time`, on ground at `top`: the front of the
 * player meets it a grace after, so a dash pressed on the beat is in time.
 */
export function gateAt(x: (t: number) => number, time: number, top: number): Gate {
  const at = time + GATE_GRACE;
  return { x: x(at) + PLAYER_WIDTH, time, at, top };
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

/** Equaliser columns, one per beat, their heights following the bass. */
function equaliser(ctx: BuildContext, moment: Moment): Built | null {
  const { stretch, x, settings, map } = ctx;
  const steps = stretch.steps;
  if (steps.length < 3) return null;
  const range = settings.eqRange * ctx.common(stretch.start);
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
    // Each column's reach: the kick on its beat (louder kick, taller column).
    const beat = beatIndexAt(map, steps[k]!);
    const kick = map.events.find((e) => e.kind === 'kick' && e.beat === beat);
    const shape = 0.55 + 0.45 * (kick?.intensity ?? 0.5);
    const times: number[] = [];
    const tops: number[] = [];
    for (let i = first; i <= last; i++) {
      times.push(map.beats[i]!);
      tops.push(base + range * shape * (map.bass[i] ?? 0));
    }
    solids.push({ kind: 'eq', x0, x1, top: tops[0] ?? base, keys: { times, tops } });
  }
  solids.push(ground(end - exit, end, base));
  return built('eq', solids, base, {
    obstacles: [
      {
        kind: 'eq',
        time: stretch.start,
        end: stretch.end,
        x0: x(steps[1]!),
        x1: end - exit,
        label: 'Equaliser',
        reason: `kicks and bass, ${moment.repeats ? 'as before' : 'columns on the beats'}`,
        ...(moment.repeats ? { repeats: moment.repeats } : {}),
      },
    ],
  });
}

/** The drop's set piece: a staircase of bars to climb on the beat, and gems on top. */
function drop(ctx: BuildContext): Built {
  const { stretch, x, settings, ease } = ctx;
  const steps = stretch.steps;
  const rise = settings.stepRise * ease;
  const count = Math.min(STAIR_STEPS, steps.length - 3, Math.floor((MAX_TOP - MIN_TOP) / rise));
  if (count < 2) return flat(ctx);
  const base = clampTop(Math.min(ctx.h, MAX_TOP - count * rise));
  const end = x(stretch.end);
  // Each step's riser where a jump on its beat is already over it: climbed on the beat.
  const riser = (k: number) => clearFrom(x, steps[k]!, rise - STEP_UP);
  const solids: Solid[] = [ground(x(stretch.start), riser(1), ctx.h)];
  const pickups: Pickup[] = [];
  const stepTime = steps[1]! - steps[0]!;
  let top = base;
  for (let k = 1; k <= count; k++) {
    top = base + k * rise;
    const x0 = riser(k);
    const x1 = riser(k + 1);
    solids.push({ kind: 'step', x0, x1, top });
    pickups.push({ kind: 'gem', x: (x0 + x1) / 2, y: top + 56, time: steps[k]! + stepTime / 2 });
  }
  // The plateau, with an arc of gems to jump for.
  const plateau = riser(count + 1);
  solids.push({ kind: 'step', x0: plateau, x1: end, top });
  const room = stretch.end - steps[count + 1]!;
  for (let i = 0; i < PLATEAU_GEMS; i++) {
    const t = steps[count + 1]! + ((i + 0.5) / PLATEAU_GEMS) * Math.min(room, 2 * stretch.period);
    const arc = Math.sin(((i + 0.5) / PLATEAU_GEMS) * Math.PI);
    pickups.push({ kind: 'gem', x: x(t), y: top + 56 + 50 * arc, time: t });
  }
  return built('drop', solids, top, {
    pickups,
    obstacles: [
      {
        kind: 'drop',
        time: stretch.start,
        end: stretch.end,
        x0: riser(1),
        x1: end,
        label: 'Drop staircase',
        reason: `the drop, a step on each of ${count} beats`,
      },
    ],
  });
}

/** The stretch kind an obstacle names, when it is the stretch's main one. */
function chunkKindOf(o: Obstacle): ChunkKind {
  switch (o.kind) {
    case 'held':
      return o.needs === 'dash' ? 'dash-gap' : 'gap';
    case 'stop':
      return 'stop';
    case 'kick':
      return o.air === undefined ? 'calm' : 'gap';
    case 'slam':
      return 'overhang';
    default:
      return o.kind;
  }
}

/**
 * The stretch with its moments made into obstacles, one after another on the ground,
 * each sized by its moment and the difficulty, `ease` times smaller when made easier:
 *
 * - held sound: a pit taking off on its hit, as long in the air as it holds (a jump, then
 *   a dash when it is longer than a jump; never longer than the difficulty allows);
 * - stop: a pit landing as the band comes back in, taking off on its start when a jump
 *   (and a dash) reaches that far, else on the latest eighth that does;
 * - kick: a gap taking off on it, landing toward the height of the song's energy;
 * - snare: a bridge that comes out on it and stays a beat or two;
 * - accent: a dash gate the player meets a grace after it;
 * - syncopation: spikes the player is over on the hit (spikes are out off the beat);
 * - heavy kick (and on hard the downbeat opening a phrase of a chorus or a drop): a slam
 *   plate from a beat before, over lower ground, and a low ceiling over that from the
 *   kick: jump and slam through the plate;
 * - fill: a raised run of steps going down one per hit, and once slam is taught (but on
 *   easy) its last steps plates over the ground, a low ceiling from the bar line.
 */
function compose(ctx: BuildContext, moments: Moment[]): Built {
  const { stretch, x, map, settings, ease, abilities } = ctx;
  const one = moments.length === 1 ? moments[0]! : undefined;
  if (one?.kind === 'eq') return equaliser(ctx, one) ?? plain(ctx);
  const ordered = moments.filter((m) => m.kind !== 'eq').sort((a, b) => a.from - b.from);
  if (ordered.length === 0) return plain(ctx);

  const period = stretch.period;
  const end = x(stretch.end);
  const beatWidth = x(stretch.start + period) - x(stretch.start);
  const solids: Solid[] = [];
  const spikes: SpikeStrip[] = [];
  const gates: Gate[] = [];
  const obstacles: Obstacle[] = [];
  const focus: Built['focus'] = {};
  const fixed = new Set<Solid>();
  let from = x(stretch.start);
  let h = ctx.h;
  const add = (o: Omit<Obstacle, 'repeats'>, m: Moment) =>
    obstacles.push(m.repeats ? { ...o, repeats: m.repeats } : o);

  ordered.forEach((m, i) => {
    const t = timeOfBeat(map, m.beat);
    const next = ordered[i + 1];
    // Where the next obstacle's ground begins, or room for plain ground at the end.
    const limitTime = next ? timeOfBeat(map, next.from) : stretch.end - period / 4;
    const limit = Math.min(x(limitTime), end - 24);

    if (m.kind === 'held' || m.kind === 'stop' || m.kind === 'kick') {
      const length = timeOfBeat(map, m.beat + m.length) - t;
      let air: number;
      let takeoff = t;
      if (m.kind === 'kick')
        air = settings.gap * ctx.common(t) * JUMP_AIR * (0.85 + 0.25 * m.strength);
      else {
        const longest = abilities.has('dash') ? dashPitAir(settings.held) : JUMP_ONLY_AIR;
        air = Math.min(length, longest) * ease;
        if (m.kind === 'stop' && length > air) {
          // Land as the band comes back: take off on the latest sixteenth that reaches it.
          const back = t + length;
          takeoff = timeOfBeat(map, Math.ceil(beatAt(map, back - air) * 4 - 1e-6) / 4);
          air = back - takeoff;
        }
      }
      if (air < MIN_AIR && m.kind !== 'kick') return;
      air = Math.max(0.12, air);
      const pit = pitAt(x, takeoff, air);
      if (pit.x0 < from - 1e-6 || pit.x1 + 48 > limit) return;
      const landing =
        m.kind === 'kick'
          ? clampTop(
              h +
                Math.max(
                  -settings.rise * ctx.common(t),
                  Math.min(settings.rise * ctx.common(t), contourTop(map, takeoff + air) - h),
                ),
            )
          : h;
      if (pit.x0 > from) solids.push(ground(from, pit.x0, h));
      if (ctx.support) {
        const ledge = Math.min(64, (pit.x1 - pit.x0) * 0.4);
        const mid = (pit.x0 + pit.x1) / 2;
        solids.push({
          kind: 'ledge',
          x0: mid - ledge / 2,
          x1: mid + ledge / 2,
          top: Math.min(h, landing),
        });
      }
      from = pit.x1;
      h = landing;
      const needs = air > JUMP_REACH ? ('dash' as const) : undefined;
      add(
        {
          kind: m.kind,
          time: t,
          end: takeoff + air,
          x0: pit.x0,
          x1: pit.x1,
          label: m.kind === 'kick' ? 'Gap' : needs ? 'Dash pit' : 'Pit',
          reason: m.kind === 'kick' ? m.what : `${m.what}, ${beatsText(m.length)}`,
          air,
          ...(needs ? { needs } : {}),
        },
        m,
      );
      if (needs) focus[needs] ??= { time: takeoff, end: takeoff + air };
    } else if (m.kind === 'bridge') {
      const hold = Math.min(3, settings.bridgeHold / ctx.common(t)) * period;
      const x0 = x(t) + 0.1 * beatWidth;
      const x1 = Math.min(x(t + hold) - 0.1 * beatWidth, limit - 0.4 * beatWidth);
      if (x0 < from - 1e-6 || x1 - x0 < 40) return;
      solids.push(ground(from, x0, h), {
        kind: 'bridge',
        x0,
        x1,
        top: h,
        windows: bridgeWindows(ctx.snares, t, hold, period),
      });
      from = x1;
      add(
        {
          kind: 'bridge',
          time: t,
          end: t + hold,
          x0,
          x1,
          label: 'Bridge',
          reason: `snare, there ${beatsText(hold / period)}`,
        },
        m,
      );
    } else if (m.kind === 'gate') {
      if (!abilities.has('dash')) return;
      const gate = gateAt(x, t, h);
      // The gate stands at the player's front: their back must be through it before the
      // next obstacle's ground (on a fast song a beat is narrower than the player).
      if (gate.x - PLAYER_WIDTH < from - 1e-6 || gate.x - PLAYER_WIDTH > limit) return;
      gates.push(gate);
      add(
        {
          kind: 'gate',
          time: t,
          end: gate.at,
          x0: gate.x,
          x1: gate.x + 1,
          label: 'Dash gate',
          reason: m.what,
          needs: 'dash',
        },
        m,
      );
      focus.dash ??= { time: t, end: t + period / 2 };
    } else if (m.kind === 'spikes') {
      const length = Math.max(16, settings.spike * ctx.common(t) * beatWidth);
      const strip = spikesAt(x, t, length, h);
      const { x0, x1 } = strip;
      if (x0 < from - 1e-6 || x1 > limit) return;
      spikes.push(strip);
      add(
        {
          kind: 'spikes',
          time: t,
          end: t + (length / beatWidth) * period,
          x0,
          x1,
          label: 'Spikes',
          reason: m.what,
        },
        m,
      );
    } else if (m.kind === 'slam') {
      // A slam plate: the floor turns to a cracked plate over ground `drop` lower, and a
      // low ceiling over that ground starts where the plate ends, from the kick. Running
      // on along the plate hits the ceiling; a jump and a slam anywhere on it breaks
      // through, landing on the kick when timed to it.
      if (!abilities.has('slam')) return;
      const clearance = Math.min(30, settings.clearance / ease);
      const drop = Math.min(SLAM_DROP, h - MIN_TOP);
      if (drop < clearance + PLATE_MARGIN) return;
      const takeoff = t - SLAM_APPROACH;
      // Made easier, the ceiling comes a little later (more time to slam).
      const meet = t + (1 - ease) * 0.1;
      const leave = Math.min(meet + Math.max(0.5, settings.overhang * ease) * period, limitTime);
      const plate0 = x(takeoff);
      const ceiling = overhangAt(x, meet, leave, h - drop, clearance);
      if (leave - meet < period / 2 || plate0 < from - 1e-6 || x(leave) > limit) return;
      const plate: Solid = { kind: 'plate', x0: plate0, x1: ceiling.x0, top: h };
      const below = ground(plate0, x(leave), h - drop);
      fixed.add(plate).add(below);
      solids.push(ground(from, plate0, h), plate, below, ceiling);
      from = x(leave);
      h -= drop;
      add(
        {
          kind: 'slam',
          time: t,
          end: leave,
          x0: plate0,
          x1: x(leave),
          label: 'Slam plate',
          reason: `${m.what}: jump and slam through the floor, under the ceiling`,
          needs: 'slam',
        },
        m,
      );
      focus.slam ??= { time: takeoff, end: leave };
    } else if (m.kind === 'stairs') {
      const line = timeOfBeat(map, m.beat + m.length);
      const leave = Math.min(line + SLAM_CEILING * period, limitTime);
      const clearance = Math.min(30, settings.clearance / ease);
      // The steps, ending in a slam when it can be had (the ceiling before the next
      // obstacle), else plain. Near the top they rise from lower ground: the ground steps
      // down to `base` first, and the level goes on from there.
      const layout = (slam: boolean) => {
        const lift = slam ? SLAM_DROP : 0;
        const most = Math.min(FILL_STEPS, (m.hits ?? []).length);
        const full = Math.min(
          (settings.stepRise * ease) / 2,
          (RISER_MAX - lift) / Math.max(1, most),
        );
        const base = Math.min(h, MAX_TOP - lift - most * full);
        const ceiling = slam ? overhangAt(x, line, leave, base, clearance) : null;
        // A step on each hit, far enough apart to see, each a few px wide at least before
        // the drop-off (the ceiling, when it ends in a slam).
        const edge = ceiling ? ceiling.x0 : x(line);
        const hits: number[] = [];
        for (const b of m.hits ?? []) {
          const ht = timeOfBeat(map, b);
          const room = x(ht) + PLAYER_WIDTH / 2 < edge - 4;
          if (room && (hits.length === 0 || ht - hits[hits.length - 1]! >= FILL_STEP_GAP))
            hits.push(ht);
        }
        const steps = hits.slice(-FILL_STEPS);
        const n = steps.length;
        const rise = Math.min((settings.stepRise * ease) / 2, (RISER_MAX - lift) / n);
        const riser = n > 0 ? x(steps[0]! - RISER_LEAD) + PLAYER_WIDTH : 0;
        const fits =
          n >= 2 && base >= MIN_TOP && riser >= from - 1e-6 && (slam ? x(leave) : edge) <= limit;
        return fits ? { slam, ceiling, edge, steps, n, lift, rise, riser, base } : null;
      };
      const want = settings.slamFills && abilities.has('slam') && leave - line >= period / 2;
      const fill = (want ? layout(true) : null) ?? layout(false);
      if (!fill) return;
      const { slam, ceiling, edge, steps, n, lift, rise, riser, base } = fill;
      solids.push(ground(from, riser, h));
      // Ending in a slam, the last steps are plates over the ground: a slam onto either
      // breaks through, landing under the ceiling on the bar line.
      const plates = slam ? Math.min(PLATE_STEPS, n) : 0;
      steps.forEach((_, k) => {
        const x0 = k === 0 ? riser : x(steps[k]!) + PLAYER_WIDTH / 2;
        const x1 = k === n - 1 ? edge : x(steps[k + 1]!) + PLAYER_WIDTH / 2;
        const step: Solid = {
          ...ground(x0, x1, base + lift + (n - k) * rise),
          ...(k >= n - plates ? { kind: 'plate' as const } : {}),
        };
        if (k === n - plates) solids.push(ground(x0, edge, base));
        fixed.add(step);
        solids.push(step);
      });
      if (ceiling) solids.push(ceiling);
      from = edge;
      h = base;
      add(
        {
          kind: 'stairs',
          time: steps[0]!,
          end: slam ? leave : line,
          x0: riser,
          x1: slam ? x(leave) : edge,
          label: slam ? 'Steps, then slam' : 'Steps',
          reason: `fill, a step on each of ${n} hits${slam ? ', a low ceiling on the bar line' : ''}`,
          ...(slam ? { needs: 'slam' as const } : {}),
        },
        m,
      );
      if (slam) focus.slam ??= { time: line - 0.4, end: leave };
    }
  });

  solids.push(ground(from, end, h));
  if (obstacles.length === 0) return plain(ctx);
  const main = [...obstacles].sort((a, b) => SALIENCE[b.kind] - SALIENCE[a.kind])[0]!;
  const made: Built = {
    kind: chunkKindOf(main),
    solids,
    spikes,
    gates,
    pickups: [],
    obstacles,
    h,
    focus,
    fixed,
  };
  // A build climbs after its obstacles too, but a bar the song plays again stays as the
  // player learned it.
  return ctx.style === 'climb' && !moments.some((m) => m.repeats) ? tailStep(ctx, made) : made;
}

/**
 * The abilities taught in the first spots that need them, in order: dash on the first
 * accent, held sound or stop it takes, slam on the first heavy kick or (but on easy)
 * fill: both end in slam plates, which nothing but a slam gets through.
 */
const LESSONS: readonly Ability[] = ['dash', 'slam'];
/** Spots a lesson is tried in before the song is left without it. */
const LESSON_TRIES = 3;

/** True when the moment, at full size, needs the ability. */
function wouldNeed(m: Moment, ability: Ability, map: LevelMap, settings: DifficultySettings) {
  if (ability === 'slam') return m.kind === 'slam' || (m.kind === 'stairs' && settings.slamFills);
  if (m.kind === 'gate') return true;
  if (m.kind !== 'held' && m.kind !== 'stop') return false;
  const length = timeOfBeat(map, m.beat + m.length) - timeOfBeat(map, m.beat);
  return Math.min(length, dashPitAir(settings.held)) > JUMP_REACH;
}

/** The feel of a section by its kind, for a map without moods. */
const FEEL_OF_KIND: Record<SectionKind, SectionFeel> = {
  intro: 'calm',
  outro: 'calm',
  breakdown: 'breakdown',
  build: 'build',
  drop: 'drop',
  main: 'groove',
};

/**
 * The terrain style for each feel: floating slabs in calm parts and breakdowns, the
 * energy's contour in a groove, heaving equaliser ground in a chorus and in a drop after
 * its set piece, and a climb in a build.
 */
export const STYLE_OF_FEEL: Record<SectionFeel, TerrainStyle> = {
  calm: 'float',
  breakdown: 'float',
  groove: 'contour',
  chorus: 'heave',
  drop: 'heave',
  build: 'climb',
};

/** Heaving ground rises this share of the difficulty's equaliser range (up to `HEAVE_MAX`). */
const HEAVE_SHARE = 0.45;

/** Calm sections are built this much easier, with wider ground and narrower gaps. */
const CALM_EASE = 0.6;
const isCalm = (kind: SectionKind) => kind === 'intro' || kind === 'breakdown' || kind === 'outro';

/** The ways to build a stretch, from as planned to easiest. */
interface Attempt {
  ease: number;
  support: boolean;
  /** Only the stretch's most salient obstacle. */
  main?: boolean;
}

function attemptsFor(count: number, isDrop: boolean): Attempt[] {
  if (isDrop) return [1, 0.75, 0.55, 0.4].map((ease) => ({ ease, support: false }));
  if (count === 0) return [{ ease: 1, support: false }];
  return [
    { ease: 1, support: false },
    { ease: 0.7, support: false },
    { ease: 0.45, support: false },
    { ease: 0.45, support: true },
    ...(count > 1 ? [{ ease: 0.45, support: true, main: true }] : []),
  ];
}

/**
 * Where a full jump taken on the ground at `t` peaks, simulated with the game's own step:
 * null when there is no ground to take off from, or the jump (or a moment standing after
 * it) dies. Risky when the peak is over a pit.
 */
function fullJump(
  level: PlatformerLevel,
  world: LevelWorld,
  t: number,
): { time: number; x: number; y: number; risky: boolean } | null {
  const standing = (x: number, at: number) => {
    let best: { surface: number; top: number } | null = null;
    for (const i of world.solidsBetween(x, x + PLAYER_WIDTH)) {
      if (level.solids[i]!.kind === 'overhang') continue;
      const top = world.topAt(i, at);
      if (top !== null && (!best || top > best.top)) best = { surface: i, top };
    }
    return best;
  };
  const ground = standing(xAtTime(level, t), t);
  if (!ground) return null;
  let p: PlayerState = { ...startState(xAtTime(level, t), ground.top), surface: ground.surface };
  let peak = { time: t, x: p.x, y: p.y };
  let k = 1;
  for (; k * PHYSICS_DT <= 2 * JUMP_AIR; k++) {
    const at = t + k * PHYSICS_DT;
    p = stepPlayer(p, { jump: k === 1 }, world, at);
    if (!p.alive) return null;
    if (p.y > peak.y) peak = { time: at, x: p.x, y: p.y };
    if (k > 1 && p.grounded) break;
  }
  if (!p.grounded) return null;
  // Not landing somewhere that kills a moment later without a press.
  for (let j = 1; j <= 15 && p.alive; j++)
    p = stepPlayer(p, { jump: false }, world, t + (k + j) * PHYSICS_DT);
  if (!p.alive) return null;
  return {
    time: peak.time,
    x: peak.x + PLAYER_WIDTH / 2,
    y: peak.y + PLAYER_HEIGHT + BOOSTER_ABOVE,
    risky: standing(peak.x, peak.time) === null,
  };
}

/**
 * Boosters (shield, magnet, extra dash, in turn) in optional or risky spots: just over
 * the head at the top of a full jump taken on a beat, over a pit when a section has one
 * in its first bars, else over plain ground. A short hop or no jump passes under it. One
 * a section at most, at least `BOOSTER_BARS` apart, from the second section on, never in
 * a drop's set piece or around a lesson. The validator never sees pickups, so the level
 * stays completable without them.
 */
function boosters(level: PlatformerLevel, map: LevelMap, seed: number): void {
  const world = new LevelWorld(level);
  const rng = new Random(hashOf(seed, 'boosters'));
  let turn = rng.int(0, BOOSTER_KINDS.length - 1);
  let after = -Infinity;
  const busy = (t: number) =>
    level.chunks.some(
      (c) => (c.kind === 'drop' || c.kind === 'run-out') && t >= c.start - 1 && t < c.end,
    ) || level.lessons.some((l) => t >= l.time - 4 * periodAt(map, l.time) && t <= l.end + 0.5);
  for (const section of map.sections.slice(1)) {
    const from = Math.max(section.start + 4 * periodAt(map, section.start), after);
    const to = Math.min(section.end, timeOfBeat(map, beatAt(map, from) + BOOSTER_BARS * 4));
    let best: ReturnType<typeof fullJump> = null;
    for (const t of map.beats) {
      if (t < from || t >= to || busy(t)) continue;
      const spot = fullJump(level, world, t);
      if (!spot || busy(spot.time)) continue;
      if (spot.risky) {
        best = spot;
        break;
      }
      best ??= spot;
    }
    if (!best) continue;
    const kind = BOOSTER_KINDS[turn++ % BOOSTER_KINDS.length]!;
    level.pickups.push({ kind, x: best.x, y: best.y, time: best.time });
    after = timeOfBeat(map, beatAt(map, best.time) + BOOSTER_BARS * 4);
  }
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
  const taken = level.pickups.filter((p) => p.kind !== 'coin').map((p) => p.x);
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
    const period = periodAt(map, time);
    while (h < hats.length && hats[h]! < time - period) h++;
    if (h < hats.length && hats[h]! <= time + period) continue;
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

/** The moments of a stretch's bars that fit together in it, strongest first. */
function fitStretch(plans: Moment[][], first: number, last: number): Moment[] {
  const chosen: Moment[] = [];
  for (const m of plans.flat().sort(byStrength)) {
    if (ownBeat(m) < first - 1e-6 || endOf(m) > last + 1e-6) continue;
    if (chosen.some((c) => overlaps(c, m))) continue;
    chosen.push(m);
  }
  return chosen;
}

/**
 * The platformer's level for a song at a difficulty. Every stretch is proven passable by
 * the validator before the next is built; see `validate.ts`.
 */
export function generateLevel(map: LevelMap, difficulty: Difficulty): PlatformerLevel {
  const settings = DIFFICULTY[difficulty];
  const seed = hashOf(map.seed, difficulty);
  const level: PlatformerLevel = {
    seed,
    difficulty,
    duration: map.duration,
    tempo: map.tempo,
    grid: { segments: map.segments, beats: map.beats, downbeats: map.downbeats },
    scroll: scrollFor(map),
    solids: [],
    spikes: [],
    gates: [],
    pickups: [],
    chunks: [],
    obstacles: [],
    lessons: [],
    start: { x: ANCHOR_X, y: START_TOP },
    finishX: 0,
  };
  level.finishX = xAtTime(level, map.duration);
  const x = (t: number) => xAtTime(level, t);
  const world = new LevelWorld(level);
  const sectionIndexAt = (t: number) => map.sections.findIndex((s) => t >= s.start && t < s.end);
  const sectionAt = (t: number): SectionKind => map.sections[sectionIndexAt(t)]?.kind ?? 'main';
  const feelAt = (t: number): SectionFeel => {
    const i = sectionIndexAt(t);
    return map.moods?.[i]?.feel ?? FEEL_OF_KIND[map.sections[i]?.kind ?? 'main'];
  };
  const styleAt = (t: number) => STYLE_OF_FEEL[feelAt(t)];
  // A build gets denser as it goes, up to BUILD_DENSER more by its end.
  const busyAt = (t: number) => {
    const s = map.sections[sectionIndexAt(t)];
    if (!s || feelAt(t) !== 'build') return 1;
    return 1 + BUILD_DENSER * Math.max(0, Math.min(1, (t - s.start) / (s.end - s.start)));
  };

  // Bars between the run-in and the run-out, each as a stretch.
  const runIn = map.downbeats.find((d) => d >= RUN_IN_SECONDS) ?? map.duration;
  const lastBar = [...map.downbeats].reverse().find((d) => d <= map.duration - RUN_OUT_SECONDS);
  const runOut = lastBar !== undefined && lastBar > runIn ? lastBar : runIn;
  const bars = map.downbeats.filter((d) => d >= runIn && d < runOut);
  const barEnd = (i: number) => map.downbeats.find((d) => d > bars[i]!) ?? runOut;
  // Each bar is laid out with the period of the tempo segment it starts in: wide enough
  // beats one step each, narrow ones (fast songs) every other beat.
  const width = (t: number, dt: number) => x(t + dt) - x(t);
  const narrowAt = (t: number) => width(t, 4 * periodAt(map, t)) < MIN_BAR_WIDTH;
  const stretchOf = (start: number, end: number): Stretch => {
    const period = periodAt(map, start);
    const stride = width(start, period) >= MIN_STEP_WIDTH ? 1 : 2;
    const steps: number[] = [];
    if (segmentAt(map, start) === segmentAt(map, end - 1e-6)) {
      for (let t = start; t < end - 1e-6; t += stride * period) steps.push(t);
    } else {
      // Across a tempo change, on the grid's own beats.
      const first = Math.round(beatAt(map, start));
      for (let b = first; timeOfBeat(map, b) < end - 1e-6; b += stride)
        steps.push(timeOfBeat(map, b));
    }
    return { start, end, period, steps };
  };

  const snares = map.events.filter((e) => e.kind === 'snare').map((e) => e.time);
  const plans = planBars(map, settings, bars, barEnd, (t) => isCalm(sectionAt(t)), busyAt, seed);

  // Each drop's set piece starts on the first bar at or after it.
  const dropBars = new Set<number>();
  for (const e of map.events) {
    if (e.kind !== 'drop') continue;
    const i = bars.findIndex((b) => b >= e.time - 1e-6);
    const at = i < 0 && e.time < runIn && bars.length > 0 ? 0 : i;
    if (at >= 0) dropBars.add(at);
  }

  // The run-in: plain ground under the player from before the widest screen's left edge,
  // all through the bar of count-in before the song.
  const runInFrom = x(timeOfBeat(map, beatAt(map, 0) - 4)) - VIEW_BEHIND - 40;
  level.chunks.push({
    kind: 'run-in',
    planned: 'run-in',
    start: 0,
    end: runIn,
    x0: runInFrom,
    x1: x(runIn),
    section: sectionAt(0),
    style: 'contour',
    repairs: 0,
  });
  world.add([ground(runInFrom, x(runIn), START_TOP)]);
  let explorer = Explorer.start(world);
  if (!explorer.run(searchEnd(x, runIn)))
    throw new LevelGenerationError('Nobody gets through the run-in');

  let h = START_TOP;
  // Abilities taught so far; obstacles needing the others wait for their lesson.
  const taught = new Set<Ability>();
  const lessons = [...LESSONS];
  let lessonTries = 0;
  // The terrain style of the stretch before, since when it has been that, and how much
  // its moving ground moved (a repair moves it less).
  let lastStyle: TerrainStyle = 'contour';
  let since = 0;
  let lastAmount = 1;
  for (let i = 0; i < bars.length;) {
    const isDrop = dropBars.has(i);
    // Every stretch of a song whose bars are too short for an obstacle takes two bars, and
    // drops three (four on such a song, for room to climb the staircase), never into a drop.
    const narrow = narrowAt(bars[i]!);
    const want = isDrop ? (narrow ? 4 : 3) : narrow ? 2 : 1;
    let span = 1;
    while (span < want && i + span < bars.length && !dropBars.has(i + span)) span++;
    const beatOf = (k: number) => beatAt(map, barEnd(k));
    const first = beatAt(map, bars[i]!);
    // Take the next bar in while an obstacle runs past the last one (a few bars at most).
    const grow = (overruns: () => boolean) => {
      while (span < want + 5 && i + span < bars.length && !dropBars.has(i + span) && overruns())
        span++;
    };
    let moments: Moment[] = [];
    let teaching: Moment | undefined;
    const lesson = lessons[0];
    if (!isDrop) {
      grow(() =>
        plans.slice(i, i + span).some((p) => p.some((m) => endOf(m) > beatOf(i + span - 1) + 1e-6)),
      );
      moments = fitStretch(plans.slice(i, i + span), first, beatOf(i + span - 1));
      // The first moment needing the next ability teaches it. Around it goes everything
      // that needs nothing new (so a lesson never changes the song's repeats), and what
      // needs the ability too once the lesson is a bar behind.
      teaching = lesson
        ? [...moments]
            .sort((a, b) => a.beat - b.beat)
            .find((m) => wouldNeed(m, lesson, map, settings))
        : undefined;
      const lone = teaching;
      if (lone && lesson)
        moments = moments.filter(
          (m) =>
            m === lone ||
            (!overlaps(m, lone) &&
              (m.from >= endOf(lone) + 4 || !wouldNeed(m, lesson, map, settings))),
        );
    }
    const stretch = stretchOf(bars[i]!, barEnd(i + span - 1));
    const section = sectionAt(stretch.start);
    const calmSection = isCalm(section);
    const abilities = new Set(taught);
    if (teaching && lesson) abilities.add(lesson);
    // The ground's style, by the section's feel; a new one starts on this downbeat. Read
    // half a beat in: the analysis' section lines sit a hair off the grid's bar lines.
    const style: TerrainStyle = isDrop ? 'drop' : styleAt(stretch.start + stretch.period / 2);
    const fresh = style !== lastStyle;
    const styleSince = fresh ? stretch.start : since;

    const attempts: (Attempt | null)[] = [...attemptsFor(moments.length, isDrop), null];
    let accepted = false;
    let planned: ChunkKind | null = null;
    for (let a = 0; a < attempts.length && !accepted; a++) {
      const attempt = attempts[a];
      const ctx: BuildContext = {
        map,
        settings,
        ease: attempt?.ease ?? 1,
        common: (t) => (attempt?.ease ?? 1) * (isCalm(sectionAt(t)) ? CALM_EASE : 1),
        support: attempt?.support ?? false,
        h,
        stretch,
        x,
        abilities,
        snares,
        calm: calmSection,
        style,
        timeAt: (px) => timeAtX(level, px),
      };
      const main = attempt?.main ? [...moments].sort(byStrength).slice(0, 1) : moments;
      // The last resort is flat ground at the height the last stretch ended at.
      const made: Built = !attempt ? flat(ctx) : isDrop ? drop(ctx) : compose(ctx, main);
      planned ??= made.kind;
      const amount = attempt?.ease ?? 1;
      const shaped = attempt !== null && !isDrop;
      if (shaped)
        made.solids = shapeTerrain(
          {
            map,
            style,
            x,
            timeAt: ctx.timeAt,
            start: stretch.start,
            end: stretch.end,
            since: styleSince,
            ...(fresh ? { morphFrom: h } : {}),
            amount,
            heave: settings.eqRange * HEAVE_SHARE,
            heavingIn:
              !fresh && amount === lastAmount && endsHeaving(level.solids, x(stretch.start), h),
            bounds: { min: MIN_TOP, max: MAX_TOP + HEAVE_MAX },
          },
          made.solids,
          made.spikes,
          made.gates,
          made.fixed,
        );
      const mark = world.mark();
      world.add(made.solids, made.spikes, made.gates);
      const next = explorer.clone();
      if (next.run(searchEnd(x, stretch.end)) && next.anyGrounded) {
        explorer = next;
        accepted = true;
        level.pickups.push(...made.pickups);
        level.obstacles.push(...made.obstacles);
        level.chunks.push({
          kind: made.kind,
          planned: planned ?? made.kind,
          start: stretch.start,
          end: stretch.end,
          x0: x(stretch.start),
          x1: x(stretch.end),
          section,
          style: shaped || isDrop ? style : 'contour',
          repairs: a,
        });
        const kept = shaped || isDrop ? style : 'contour';
        if (kept !== lastStyle) since = stretch.start;
        lastStyle = kept;
        lastAmount = amount;
        const met = lesson && made.focus[lesson];
        if (teaching && lesson && met) {
          taught.add(lesson);
          lessons.shift();
          lessonTries = 0;
          level.lessons.push({ action: lesson, time: met.time, end: met.end });
        } else if (teaching && ++lessonTries >= LESSON_TRIES) {
          // A song with no room for it: the ability isn't taught, and nothing needs it.
          lessons.shift();
          lessonTries = 0;
        }
        h = made.h;
      } else world.truncate(mark);
    }
    if (!accepted)
      throw new LevelGenerationError(
        `Nobody gets through the bar at ${stretch.start.toFixed(2)} s`,
      );
    i += span;
  }

  // The run-out: plain ground to past the end of the song.
  const end = x(map.duration) + VIEW_AHEAD;
  world.add([ground(x(runOut), end, h)]);
  level.chunks.push({
    kind: 'run-out',
    planned: 'run-out',
    start: runOut,
    end: map.duration,
    x0: x(runOut),
    x1: end,
    section: sectionAt(runOut),
    style: 'contour',
    repairs: 0,
  });
  if (!explorer.run(stepAt(map.duration)))
    throw new LevelGenerationError('Nobody gets through the run-out');

  level.obstacles.sort((a, b) => a.time - b.time);
  boosters(level, map, seed);
  coins(level, map, settings.coinEvery, 0.5, map.duration - 0.5);
  return level;
}
