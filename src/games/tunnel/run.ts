import { beatAt, timeOfBeat } from '../../core';
import type { ResultsSummary } from '../shared/menus';
import {
  BAR_BEATS,
  DOWNBEAT_BONUS,
  GOOD_WINDOW,
  judgeAt,
  multiplierOf,
  nearest,
  OVERDRIVE_BEATS,
  OVERDRIVE_FACTOR,
  rankAgainst,
  RESUME_BEATS,
  timingOf,
  describeRanks,
  type BeatQuality,
  type Rank,
  type RankRule,
} from '../shared/scoring';
import { formatAccuracy } from '../shared/format';
import { stepAt, TrackWorld, type Obstacle, type TunnelTrack } from './level';
import {
  LANE_REPEAT,
  PHYSICS_DT,
  RACER_DEPTH,
  startRacer,
  stepRacer,
  type RacerInput,
  type RacerState,
} from './physics';

/**
 * One race down the tunnel, without any drawing: the racer's fixed physics steps on song
 * time, crashes, pickups, the combo, overdrive, clean sections and the results. The scene
 * feeds it the audio clock's time and the controls every frame and draws what it says.
 *
 * There are no deaths: the music never stops. A crash breaks the combo, costs points (or
 * the shield, when the racer has one) and is counted against the rank.
 *
 * Song time is the audio clock's, which already takes off the output latency and the
 * player's latency offset from Settings: a hop or jump is judged against the beat as it
 * is heard.
 */

/** Points, before the combo multiplier and overdrive. */
export const POINTS = { gem: 100, rail: 50, perfect: 300, good: 100 } as const;
/** How much of the overdrive meter a perfect and a pickup fill. */
export const METER_PERFECT = 1 / 12;
export const METER_PICKUP = { gem: 1 / 40, rail: 1 / 80 } as const;
/** A crash costs this many points (never below zero), unless a shield takes it. */
export const CRASH_PENALTY = 500;
/** Getting through a section without a crash: the bonus, and a shield if the racer has none. */
export const CLEAN_BONUS = 2000;
/** A jump pressed this long before the racer is back on the floor still happens on landing. */
export const JUMP_BUFFER = 0.1;
/** How near across (lanes) the racer's middle must pass a pickup's lane to take it. */
export const PICKUP_REACH = 0.5;
/** The physics never runs more steps than this in one frame (a long stall jumps ahead). */
const MAX_STEPS_PER_UPDATE = 240;

/**
 * The ranks, best first: the least timing ((perfects + half the goods) / judged hops and
 * jumps), the least share of pickups taken, and the most crashes (`faults`). C is finishing.
 */
export const RANKS: readonly RankRule[] = [
  { rank: 'S', timing: 0.8, pickups: 0.9, faults: 0 },
  { rank: 'A', timing: 0.65, pickups: 0.75, faults: 3 },
  { rank: 'B', timing: 0.5, pickups: 0.5, faults: Infinity },
  { rank: 'C', timing: 0, faults: Infinity },
];

export function rankOf(timing: number | null, crashes: number, pickups: number): Rank {
  return rankAgainst(RANKS, timing, crashes, pickups);
}

/** The ranks' thresholds in words, for the results screen. */
export function rankRules(): string {
  return describeRanks(RANKS, 'crashes');
}

/** What the controls say this frame. */
export interface RunInput {
  /** Left and right are held down (held, a steer hops again every `LANE_REPEAT` beats). */
  leftHeld: boolean;
  rightHeld: boolean;
  /** Left, right and jump were pressed since the last update. */
  leftPressed: boolean;
  rightPressed: boolean;
  jumpPressed: boolean;
  /** Overdrive was pressed since the last update. */
  overdrivePressed?: boolean;
}

/** What the player did that is judged against the beat: a hop pressed, a jump's takeoff. */
export type BeatAction = 'hop' | 'jump';

/** Something that happened, for the scene's effects. `pos` is across, in lanes; `y` up. */
export type RunEvent =
  | {
      type: 'beat';
      action: BeatAction;
      quality: BeatQuality;
      points: number;
      pos: number;
      y: number;
    }
  | { type: 'pickup'; index: number; points: number }
  | { type: 'overdrive'; downbeat: boolean; points: number }
  | { type: 'clean'; points: number; shield: boolean }
  /**
   * The racer hit obstacle `index`: the scene flashes orange and shakes (both off with
   * reduced effects). `lost` is the points it cost; `shield` whether a shield took it instead.
   */
  | {
      type: 'crash';
      index: number;
      obstacle: Obstacle;
      lost: number;
      shield: boolean;
      pos: number;
    };

/**
 * countin: the racer waits at the start while a bar plays (a silent one before the song),
 * or where a pause stopped it while the two beats before it play. playing: racing.
 * finished: the song is over.
 */
export type RunPhase = 'countin' | 'playing' | 'finished';

export interface RunResults {
  score: number;
  rank: Rank;
  /** (Perfects + half the goods) / judged hops and jumps, 0 to 1, or null when none were. */
  timing: number | null;
  perfect: number;
  good: number;
  miss: number;
  crashes: number;
  /** Crashes a shield took. */
  saves: number;
  pickups: number;
  totalPickups: number;
  bestCombo: number;
  overdrives: number;
  clean: number;
  sections: number;
}

/** The results screen's summary: score, rank and its two columns of rows. */
export function summaryOf(r: RunResults): ResultsSummary {
  return {
    score: r.score,
    rank: r.rank,
    columns: [
      [
        { name: 'Perfect', value: String(r.perfect), highlight: true },
        { name: 'Good', value: String(r.good) },
        { name: 'Miss', value: String(r.miss) },
        { name: 'Timing', value: formatAccuracy(r.timing) },
        { name: 'Crashes', value: String(r.crashes) },
      ],
      [
        { name: 'Best combo', value: String(r.bestCombo) },
        { name: 'Overdrives', value: String(r.overdrives) },
        { name: 'Clean sections', value: `${r.clean} / ${r.sections}` },
        { name: 'Pickups', value: r.totalPickups > 0 ? `${r.pickups} / ${r.totalPickups}` : '—' },
        { name: 'Shield saves', value: String(r.saves) },
      ],
    ],
  };
}

/** One steer direction: a press waiting for the next step, and when holding hops again. */
interface Steer {
  pressed: boolean;
  held: boolean;
  /** Song time held steering hops again; Infinity when not held. */
  repeatAt: number;
}

export class TunnelRun {
  readonly world: TrackWorld;
  /** Song times the sections end at (the last is the song's end). */
  readonly sectionEnds: number[];

  phase: RunPhase = 'countin';
  racer: RacerState;
  /** Song time the racer gets control (end of the count-in). */
  resumeAt = 0;
  /** Song time of the last crash, the last jump's takeoff and the last hop, for effects. */
  crashedAt = -Infinity;
  jumpedAt = -Infinity;
  hoppedAt = -Infinity;
  /**
   * Presses to play by itself, by physics step (`solveLevel`), instead of the player's:
   * for watching a track and timing its frames in dev.
   */
  autoplay: Map<number, RacerInput> | null = null;
  /**
   * How far ahead of the heard song the run is moved on (the session draws for when a
   * frame is seen). A press acts on the next frame, that much after the song time the
   * player pressed at, so hops and jumps are judged that much earlier.
   */
  inputLead = 0;

  score = 0;
  combo = 0;
  bestCombo = 0;
  crashes = 0;
  /** The overdrive meter, 0 to 1: full, it can be activated. */
  meter = 0;
  /** A shield: the next crash costs it instead of points. */
  shield = false;
  /** Song time a shield last took a crash. */
  shieldHitAt = -Infinity;
  /** The song times the last overdrive runs from and to. */
  overdrive = { from: -Infinity, until: -Infinity };

  readonly #collected: Uint8Array;
  /** The first pickup the racer hasn't passed yet. */
  #nextPickup = 0;
  #step = 0;
  /** Beats of music before `resumeAt` that the count-in plays, following the tempo map. */
  #countIn = BAR_BEATS;
  #left: Steer = { pressed: false, held: false, repeatAt: Infinity };
  #right: Steer = { pressed: false, held: false, repeatAt: Infinity };
  #jumpUntil = -Infinity;
  /** The section the racer is in, and whether it has crashed in it. */
  #section = 0;
  #sectionClean = true;
  readonly #counts = { perfect: 0, good: 0, miss: 0, overdrives: 0, saves: 0, clean: 0 };

  constructor(readonly track: TunnelTrack) {
    this.world = new TrackWorld(track);
    this.racer = startRacer(track.startLane, this.world.zAt(0));
    this.#collected = new Uint8Array(track.pickups.length);
    const ends = track.looks.map((l) => l.end).filter((e) => e < track.duration - 1e-6);
    this.sectionEnds = [...ends, track.duration];
  }

  get multiplier(): number {
    return multiplierOf(this.combo);
  }

  overdriveAt(t: number): boolean {
    return t >= this.overdrive.from && t < this.overdrive.until;
  }

  isCollected(index: number): boolean {
    return this.#collected[index] === 1;
  }

  /**
   * The song time to play the music from for the count-in: a bar before the start, or
   * `RESUME_BEATS` before where a pause stopped the racer.
   */
  get countInFrom(): number {
    const grid = this.track.grid;
    return timeOfBeat(grid, beatAt(grid, this.resumeAt) - this.#countIn);
  }

  /** How many beats the count-in has: a bar, or `RESUME_BEATS` after a pause. */
  get countInBeats(): number {
    return this.#countIn;
  }

  /**
   * Going on after a pause: the racer stays where it is through a short count-in, so the
   * race never starts again mid-hop without warning. Returns where the music plays from.
   * Only while playing: a count-in plays on as it was.
   */
  holdForResume(): number {
    if (this.phase !== 'playing') return this.countInFrom;
    this.resumeAt = this.#step * PHYSICS_DT;
    this.#countIn = RESUME_BEATS;
    this.#clearPresses();
    this.phase = 'countin';
    return this.countInFrom;
  }

  #clearPresses(): void {
    this.#left = { pressed: false, held: false, repeatAt: Infinity };
    this.#right = { pressed: false, held: false, repeatAt: Infinity };
    this.#jumpUntil = -Infinity;
  }

  /** Move the run on to song time `time`. Returns what happened. */
  update(time: number, input: RunInput): RunEvent[] {
    const events: RunEvent[] = [];
    this.#steerInput(this.#left, input.leftPressed, input.leftHeld);
    this.#steerInput(this.#right, input.rightPressed, input.rightHeld);
    if (input.jumpPressed) this.#jumpUntil = time + JUMP_BUFFER;

    if (this.phase === 'countin' && time >= this.resumeAt) {
      this.phase = 'playing';
      this.#step = stepAt(this.resumeAt);
    }
    if (this.phase === 'playing') {
      const target = stepAt(time);
      if (target - this.#step > MAX_STEPS_PER_UPDATE) this.#step = target - MAX_STEPS_PER_UPDATE;
      while (this.#step < target) {
        this.#step++;
        this.#advance(this.#step * PHYSICS_DT, events);
      }
      if (input.overdrivePressed) this.#activate(time, events);
      if (time >= this.track.duration) this.finish(events);
    }
    return events;
  }

  /** A press waits for the next step; letting go stops the repeats. */
  #steerInput(s: Steer, pressed: boolean, held: boolean): void {
    if (pressed) s.pressed = true;
    s.held = held || pressed;
    if (!s.held) s.repeatAt = Infinity;
  }

  /** The song is over: the last section ends with it. */
  finish(events: RunEvent[] = []): void {
    if (this.phase === 'finished') return;
    if (this.phase === 'playing') this.#endSection(events);
    this.phase = 'finished';
  }

  results(): RunResults {
    let pickups = 0;
    for (const c of this.#collected) pickups += c;
    const { perfect, good, miss, overdrives, saves, clean } = this.#counts;
    const timing = timingOf(perfect, good, miss);
    const total = this.track.pickups.length;
    return {
      score: this.score,
      rank: rankOf(timing, this.crashes, total > 0 ? pickups / total : 1),
      timing,
      perfect,
      good,
      miss,
      crashes: this.crashes,
      saves,
      pickups,
      totalPickups: total,
      bestCombo: this.bestCombo,
      overdrives,
      clean,
      sections: this.sectionEnds.length,
    };
  }

  #advance(t: number, events: RunEvent[]): void {
    while (this.#section < this.sectionEnds.length - 1 && t >= this.sectionEnds[this.#section]!)
      this.#endSection(events);

    const prev = this.racer;
    let input: RacerInput;
    let pressedHop: boolean;
    if (this.autoplay) {
      input = this.autoplay.get(stepAt(t)) ?? {};
      pressedHop = !!(input.left || input.right);
    } else {
      const left = this.#steer(this.#left, t);
      const right = this.#steer(this.#right, t);
      pressedHop = (left === 'press' && !right) || (right === 'press' && !left);
      const jump = t <= this.#jumpUntil && prev.grounded;
      if (jump) this.#jumpUntil = -Infinity;
      input = { left: !!left, right: !!right, jump };
    }
    const p = stepRacer(prev, input, this.world, t);
    this.racer = p;

    // A hop toward the tunnel's side wall does nothing, and isn't judged.
    if (p.lane !== prev.lane) {
      this.hoppedAt = t;
      // Only a press is judged: holding repeats on the half beat by itself.
      if (pressedHop) events.push(this.#judge('hop', t, p));
    }
    if (prev.grounded && !p.grounded) {
      this.jumpedAt = t;
      events.push(this.#judge('jump', t, p));
    }
    if (p.crash >= 0) this.#crash(t, p, events);
    this.#collect(p, events);
  }

  /**
   * Which way a steer acts on this step: a press, a repeat while held (every `LANE_REPEAT`
   * beats after the press), or not at all.
   */
  #steer(s: Steer, t: number): 'press' | 'repeat' | null {
    const grid = this.track.grid;
    const next = () => timeOfBeat(grid, beatAt(grid, t) + LANE_REPEAT);
    if (s.pressed) {
      s.pressed = false;
      s.repeatAt = s.held ? next() : Infinity;
      return 'press';
    }
    if (s.held && t >= s.repeatAt - 1e-9) {
      s.repeatAt = next();
      return 'repeat';
    }
    return null;
  }

  /** Rate a hop or a jump by how close to a beat or an eighth it was pressed, and score it. */
  #judge(action: BeatAction, t: number, p: RacerState): RunEvent {
    // A press acts on the next frame; autoplay's act on their own step.
    const at = this.autoplay ? t : t - this.inputLead;
    const quality = judgeAt(this.track.grid, at);
    this.#counts[quality]++;
    let points = 0;
    // A miss only counts against timing: steering to dodge isn't always on the beat, and
    // only a crash breaks the combo.
    if (quality !== 'miss') {
      points = this.#gain(t, POINTS[quality]);
      if (quality === 'perfect') this.#fill(t, METER_PERFECT);
    }
    return { type: 'beat', action, quality, points, pos: p.pos, y: p.y };
  }

  /** A crash: the combo breaks, and it costs points, or the shield when there is one. */
  #crash(t: number, p: RacerState, events: RunEvent[]): void {
    this.crashes++;
    this.crashedAt = t;
    this.combo = 0;
    this.#sectionClean = false;
    const shield = this.shield;
    let lost = 0;
    if (shield) {
      this.shield = false;
      this.shieldHitAt = t;
      this.#counts.saves++;
    } else {
      lost = Math.min(this.score, CRASH_PENALTY);
      this.score -= lost;
    }
    const obstacle = this.track.obstacles[p.crash]!;
    events.push({ type: 'crash', index: p.crash, obstacle, lost, shield, pos: p.pos });
  }

  /** Take every pickup the racer's length passes over in its lane. */
  #collect(p: RacerState, events: RunEvent[]): void {
    const pickups = this.track.pickups;
    const back = p.z - RACER_DEPTH;
    while (this.#nextPickup < pickups.length && pickups[this.#nextPickup]!.z < back)
      this.#nextPickup++;
    for (let i = this.#nextPickup; i < pickups.length; i++) {
      const k = pickups[i]!;
      if (k.z > p.z) break;
      if (this.#collected[i] || Math.abs(p.pos - k.lane) >= PICKUP_REACH) continue;
      this.#collected[i] = 1;
      this.#fill(k.time, METER_PICKUP[k.kind]);
      events.push({ type: 'pickup', index: i, points: this.#gain(k.time, POINTS[k.kind]) });
    }
  }

  /** The section the racer is in ends: a bonus and a shield when it had no crash. */
  #endSection(events: RunEvent[]): void {
    if (this.#sectionClean) {
      this.#counts.clean++;
      this.score += CLEAN_BONUS;
      const shield = !this.shield;
      this.shield = true;
      events.push({ type: 'clean', points: CLEAN_BONUS, shield });
    }
    this.#sectionClean = true;
    this.#section++;
  }

  /** Overdrive, when the meter is full: 4 bars of double score, a bonus on a downbeat. */
  #activate(t: number, events: RunEvent[]): void {
    if (this.meter < 1 || this.overdriveAt(t)) return;
    const grid = this.track.grid;
    // The bonus is the combo's, not doubled: overdrive starts with it.
    const downbeat = nearest(grid.downbeats, t) <= GOOD_WINDOW;
    const points = downbeat ? this.#bonus(t, DOWNBEAT_BONUS) : 0;
    this.meter = 0;
    this.overdrive = { from: t, until: timeOfBeat(grid, beatAt(grid, t) + OVERDRIVE_BEATS) };
    this.#counts.overdrives++;
    events.push({ type: 'overdrive', downbeat, points });
  }

  /** The overdrive meter fills, but not while an overdrive runs. */
  #fill(t: number, amount: number): void {
    // A full meter is full, whatever the rounding of its fractions.
    if (!this.overdriveAt(t))
      this.meter = this.meter + amount >= 1 - 1e-9 ? 1 : this.meter + amount;
  }

  /** Add to the combo and the score, multiplied; returns the points scored. */
  #gain(t: number, base: number): number {
    this.combo++;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    return this.#bonus(t, base);
  }

  /** Points times the multiplier and overdrive, without adding to the combo. */
  #bonus(t: number, base: number): number {
    const points = base * multiplierOf(this.combo) * (this.overdriveAt(t) ? OVERDRIVE_FACTOR : 1);
    this.score += points;
    return points;
  }
}
