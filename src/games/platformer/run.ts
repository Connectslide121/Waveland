import { beatAt, timeOfBeat, type LevelEvent, type Section } from '../../core';
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
  type BeatQuality,
  type Rank,
  type RankRule,
} from '../shared/scoring';
import { stepAt } from './level/validate';
import { LevelWorld, xAtTime, type BoosterKind, type PlatformerLevel } from './level';
import {
  canDash,
  canJump,
  canSlam,
  JUMP_BUFFER,
  PHYSICS_DT,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  startState,
  stepPlayer,
  type DeathCause,
  type PlayerInput,
  type PlayerState,
} from './physics';

/**
 * One play of the platformer's level, without any drawing: the player's fixed physics
 * steps on song time, deaths and checkpoints, pickups, boosters and the score. The scene
 * feeds it the audio clock's time and the controls every frame and draws what it says.
 *
 * Song time is the audio clock's, which already takes off the output latency and the
 * player's latency offset from Settings: an action is judged against the beat as it is
 * heard.
 */

/**
 * Takeoffs, landings, dashes and slam landings are judged against the beat or eighth by
 * the shared scoring (`src/games/shared/scoring.ts`), which also has the multiplier,
 * overdrive and count-ins; re-exported here for the platformer's scene, UI and tests.
 */
export {
  BAR_BEATS,
  COMBO_STEP,
  DOWNBEAT_BONUS,
  GOOD_SHARE,
  GOOD_WINDOW,
  judgeAt,
  MAX_MULTIPLIER,
  multiplierOf,
  offBeat,
  offGrid,
  OVERDRIVE_BEATS,
  OVERDRIVE_FACTOR,
  PERFECT_SHARE,
  PERFECT_WINDOW,
  RESUME_BEATS,
  type BeatQuality,
  type Rank,
} from '../shared/scoring';

/** How long the death effect plays, in song time, before the music rewinds. */
export const DEATH_TIME = 0.7;
/** Points, before the combo multiplier and overdrive. */
export const POINTS = { coin: 100, gem: 500, booster: 250, perfect: 300, good: 100 } as const;
/** A dash on a snare, or a slam landing on a kick or a downbeat, is an accent: doubled. */
export const ACCENT_FACTOR = 2;
/** How much of the overdrive meter a perfect and a gem fill. */
export const METER_PERFECT = 1 / 12;
export const METER_GEM = 1 / 4;
/** This many perfects in a row bursts for a bonus (times the multiplier and overdrive). */
export const STREAK_PERFECTS = 10;
export const STREAK_BONUS = 1000;
/** Getting through a section without a hit. */
export const CLEAN_BONUS = 2000;
/** The magnet lasts this many beats (4 bars) and pulls coins from this far, px. */
export const MAGNET_BEATS = 16;
export const MAGNET_RADIUS = 110;
/**
 * A shield's bounce lands at least this long after the hit and at most this long, on the
 * first surface the player can stand on for `SAFE_TIME` without doing anything.
 */
export const RESCUE_MIN = 0.35;
export const RESCUE_MAX = 3;
export const SAFE_TIME = 0.25;
/** The bounce rises this far above the higher of where it starts and lands, px. */
const RESCUE_RISE = 70;
/** How close to a pickup's centre the player's box has to come, px. */
const PICKUP_RADIUS = { coin: 16, gem: 22, booster: 22 } as const;
/** The physics never runs more steps than this in one frame (a long stall jumps ahead). */
const MAX_STEPS_PER_UPDATE = 240;
/** Kicks and snares at least this strong make accents. */
const ACCENT_INTENSITY = 0.3;

/** What the controls say this frame. */
export interface RunInput {
  /** Jump is held down. */
  jumpHeld: boolean;
  /** Jump was pressed since the last update. */
  jumpPressed: boolean;
  /** Dash was pressed since the last update. */
  dashPressed: boolean;
  /** Slam was pressed since the last update. */
  slamPressed: boolean;
  /** Overdrive was pressed since the last update. */
  overdrivePressed?: boolean;
}

/** What the player did that is judged against the beat. */
export type BeatAction = 'takeoff' | 'land' | 'dash' | 'slam';

/** Something that happened, for the scene's effects. */
export type RunEvent =
  | {
      type: 'beat';
      action: BeatAction;
      quality: BeatQuality;
      /** A dash on a snare, a slam landing on a kick or a downbeat. */
      accent: boolean;
      points: number;
      x: number;
      y: number;
    }
  | { type: 'pickup'; index: number; points: number; pulled: boolean }
  | { type: 'streak'; count: number; points: number; x: number; y: number }
  | { type: 'overdrive'; downbeat: boolean; points: number; x: number; y: number }
  | { type: 'clean'; points: number }
  | { type: 'shield'; x: number; y: number }
  /** A slam broke through a plate, here. */
  | { type: 'plate'; x: number; y: number }
  | { type: 'death'; cause: DeathCause; x: number; y: number };

/**
 * countin: frozen at the checkpoint while the bar before it plays (or a silent bar at the start),
 * or where a pause stopped the player while the two beats before it play.
 * playing: running. dying: the death effect, music still going. finished: the song is over.
 */
export type RunPhase = 'countin' | 'playing' | 'dying' | 'finished';

/** Where a death sends the player back to: the start of the section it happened in. */
export interface Checkpoint {
  time: number;
  x: number;
  y: number;
  surface: number;
}

/** The kicks and snares accents are judged against, from the level map's events. */
export interface RunMusic {
  kicks: number[];
  snares: number[];
}

/** What a checkpoint puts back: the score, the combo, the overdrive meter and the boosters. */
interface Score {
  score: number;
  combo: number;
  bestCombo: number;
  /** Perfects in a row, toward the streak bonus. */
  perfects: number;
  collected: Uint8Array;
  /** The overdrive meter, 0 to 1, and the song time an overdrive runs from and to. */
  meter: number;
  overdriveFrom: number;
  overdriveUntil: number;
  /** Sections got through without a hit. */
  clean: number;
  shield: boolean;
  magnetFrom: number;
  magnetUntil: number;
  extraDash: boolean;
}

/** A shield's bounce: from the hit, up and over to a safe surface. */
export interface Rescue {
  from: number;
  to: number;
  y0: number;
  y1: number;
  surface: number;
}

/**
 * The ranks, best first: the least timing ((perfects + half the goods) / judged actions)
 * and the most deaths (`faults`) each allows. C is finishing.
 */
export const RANKS: readonly RankRule[] = [
  { rank: 'S', timing: 0.85, faults: 0 },
  { rank: 'A', timing: 0.7, faults: 2 },
  { rank: 'B', timing: 0.5, faults: Infinity },
  { rank: 'C', timing: 0, faults: Infinity },
];

export interface RunResults {
  score: number;
  rank: Rank;
  /** (Perfects + half the goods) / judged actions, 0 to 1, or null when none were judged. */
  timing: number | null;
  /** Share of takeoffs, landings, dashes and slams on the beat or eighth, 0 to 1, or null. */
  accuracy: number | null;
  perfect: number;
  good: number;
  miss: number;
  deaths: number;
  /** Hits a shield took. */
  saves: number;
  pickups: number;
  totalPickups: number;
  bestCombo: number;
  overdrives: number;
  clean: number;
  sections: number;
}

export function rankOf(timing: number | null, deaths: number): Rank {
  return rankAgainst(RANKS, timing, deaths);
}

/**
 * The checkpoints for a level: one at the start, and one at the start of the stretch each
 * song section begins in. Stretches start on a bar line on plain ground, so a player put
 * there in time with the music stands safely.
 */
export function checkpointsOf(level: PlatformerLevel, sections: Section[]): Checkpoint[] {
  const world = new LevelWorld(level);
  const first = level.solids.findIndex((s) => s.x0 <= level.start.x && s.x1 > level.start.x);
  const points: Checkpoint[] = [{ time: 0, ...level.start, surface: first }];
  for (const section of sections) {
    const chunk = level.chunks.find((c) => section.start >= c.start && section.start < c.end);
    if (!chunk || chunk.kind === 'run-in') continue;
    const time = chunk.start;
    if (points.some((p) => Math.abs(p.time - time) < 1e-6)) continue;
    const x = xAtTime(level, time);
    let best: { surface: number; top: number } | null = null;
    for (const i of world.solidsBetween(x, x + PLAYER_WIDTH)) {
      const top = world.topAt(i, time);
      if (top !== null && (!best || top > best.top)) best = { surface: i, top };
    }
    if (best) points.push({ time, x, y: best.top, surface: best.surface });
  }
  return points.sort((a, b) => a.time - b.time);
}

/** The kicks and snares strong enough to make accents, from the level map's events. */
export function musicOf(events: readonly LevelEvent[]): RunMusic {
  const of = (kind: LevelEvent['kind']) =>
    events.filter((e) => e.kind === kind && e.intensity >= ACCENT_INTENSITY).map((e) => e.time);
  return { kicks: of('kick'), snares: of('snare') };
}

export class PlatformerRun {
  readonly world: LevelWorld;
  readonly checkpoints: Checkpoint[];

  phase: RunPhase = 'countin';
  player: PlayerState;
  deaths = 0;
  /** The checkpoint the player goes back to on a death. */
  checkpoint: Checkpoint;
  /** Song time the player gets control (end of the count-in). */
  resumeAt: number;
  /** Song time of the last death. */
  diedAt = 0;
  /** Song time of the last landing, for the squash. */
  landedAt = -Infinity;
  /** Song time of the last jump's takeoff, for the flip in the air. */
  jumpedAt = -Infinity;
  /** Song time the last dash started, for its afterimages. */
  dashedAt = -Infinity;
  /** Song time the last slam started, and landed, for its streak and shockwave. */
  slammedAt = -Infinity;
  slamLandedAt = -Infinity;
  /**
   * Presses to play by itself, by physics step (`solveLevel`), instead of the player's:
   * for watching a level and timing its frames in dev.
   */
  autoplay: Map<number, PlayerInput> | null = null;
  /**
   * How far ahead of the heard song the run is moved on (the session draws for when a
   * frame is seen). A press acts on the next frame, that much after the song time the
   * player pressed at, so takeoffs and dashes are judged that much earlier.
   */
  inputLead = 0;
  /** Slam plates the player broke through, by solid index: the song time each broke. */
  readonly brokenAt = new Map<number, number>();
  /** Song time a shield last took a hit. */
  shieldHitAt = -Infinity;
  /** What the last death was. */
  deathCause: DeathCause | null = null;
  /** A shield's bounce in progress, or null. */
  rescue: Rescue | null = null;

  #score: Score;
  /** The score as it was at the checkpoint, put back on a death. */
  #saved: Score;
  #step = 0;
  /** Beats of music before `resumeAt` that the count-in plays, following the tempo map. */
  #countIn: number;
  /** Presses wait this long for the moment they can act (jump and dash buffer, slam this frame). */
  #jumpUntil = -Infinity;
  #dashUntil = -Infinity;
  #slamUntil = -Infinity;
  /** No hit since the section began (or since the checkpoint the player came back to). */
  #sectionClean = true;
  /** Over the whole play, rewinds included. */
  readonly #counts = { perfect: 0, good: 0, miss: 0, overdrives: 0, saves: 0 };

  constructor(
    readonly level: PlatformerLevel,
    sections: Section[],
    readonly music: RunMusic = { kicks: [], snares: [] },
  ) {
    this.world = new LevelWorld(level);
    this.checkpoints = checkpointsOf(level, sections);
    this.checkpoint = this.checkpoints[0]!;
    this.player = this.#spawn(this.checkpoint);
    this.resumeAt = this.checkpoint.time;
    this.#countIn = BAR_BEATS;
    this.#score = {
      score: 0,
      combo: 0,
      bestCombo: 0,
      perfects: 0,
      collected: new Uint8Array(level.pickups.length),
      meter: 0,
      overdriveFrom: -Infinity,
      overdriveUntil: -Infinity,
      clean: 0,
      shield: false,
      magnetFrom: -Infinity,
      magnetUntil: -Infinity,
      extraDash: false,
    };
    this.#saved = copyScore(this.#score);
  }

  get score(): number {
    return this.#score.score;
  }

  get combo(): number {
    return this.#score.combo;
  }

  get multiplier(): number {
    return multiplierOf(this.#score.combo);
  }

  /** The overdrive meter, 0 to 1: full, it can be activated. */
  get meter(): number {
    return this.#score.meter;
  }

  /** The song times the last overdrive ran from and to. */
  get overdrive(): { from: number; until: number } {
    return { from: this.#score.overdriveFrom, until: this.#score.overdriveUntil };
  }

  overdriveAt(t: number): boolean {
    return t >= this.#score.overdriveFrom && t < this.#score.overdriveUntil;
  }

  /** The boosters the player has: a shield, a magnet until a song time, an extra dash. */
  get boosters(): { shield: boolean; magnetFrom: number; magnetUntil: number; extraDash: boolean } {
    const s = this.#score;
    return {
      shield: s.shield,
      magnetFrom: s.magnetFrom,
      magnetUntil: s.magnetUntil,
      extraDash: s.extraDash,
    };
  }

  isCollected(index: number): boolean {
    return this.#score.collected[index] === 1;
  }

  /**
   * The song time to play the music from for the count-in: a bar before the checkpoint,
   * or `RESUME_BEATS` before where a pause stopped the player.
   */
  get countInFrom(): number {
    const grid = this.level.grid;
    return timeOfBeat(grid, beatAt(grid, this.resumeAt) - this.#countIn);
  }

  /** How many beats the count-in has: a bar, or `RESUME_BEATS` after a pause. */
  get countInBeats(): number {
    return this.#countIn;
  }

  /**
   * Going on after a pause: the player stays where they are, frozen through a short
   * count-in, so play never starts again mid-jump without warning. Returns where the music
   * plays from. Only while playing: a count-in or a death plays on as it was.
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
    this.#jumpUntil = this.#dashUntil = this.#slamUntil = -Infinity;
  }

  /**
   * Move the run on to song time `time`. Returns what happened, and whether the death
   * effect is over and the music should rewind (`respawn`).
   */
  update(time: number, input: RunInput): { events: RunEvent[]; respawn: boolean } {
    const events: RunEvent[] = [];
    if (input.jumpPressed) this.#jumpUntil = time + JUMP_BUFFER;
    if (input.dashPressed) this.#dashUntil = time + JUMP_BUFFER;
    // A slam only acts in the frame it is pressed: held over, it would cut the next jump.
    if (input.slamPressed) this.#slamUntil = time;

    if (this.phase === 'countin' && time >= this.resumeAt) {
      this.phase = 'playing';
      this.#step = stepAt(this.resumeAt);
    }
    if (this.phase === 'playing') {
      const target = stepAt(time);
      if (target - this.#step > MAX_STEPS_PER_UPDATE) this.#step = target - MAX_STEPS_PER_UPDATE;
      while (this.#step < target && this.phase === 'playing') {
        this.#step++;
        this.#advance(this.#step * PHYSICS_DT, input, events);
      }
      if (this.phase === 'playing' && input.overdrivePressed) this.#activate(time, events);
      if (this.phase === 'playing' && time >= this.level.duration) this.finish();
    }
    const respawn = this.phase === 'dying' && time - this.diedAt >= DEATH_TIME;
    return { events, respawn };
  }

  /** Back to the checkpoint, frozen through a one-bar count-in. Returns where the music plays from. */
  respawn(): number {
    this.player = this.#spawn(this.checkpoint);
    this.resumeAt = this.checkpoint.time;
    // Plates broken since the checkpoint are whole again.
    for (const [i, at] of this.brokenAt) if (at >= this.checkpoint.time) this.brokenAt.delete(i);
    this.#countIn = BAR_BEATS;
    this.#clearPresses();
    this.landedAt = -Infinity;
    this.jumpedAt = -Infinity;
    this.dashedAt = -Infinity;
    this.slammedAt = -Infinity;
    this.slamLandedAt = -Infinity;
    this.shieldHitAt = -Infinity;
    this.rescue = null;
    this.#sectionClean = true;
    this.phase = 'countin';
    return this.countInFrom;
  }

  finish(): void {
    if (this.phase === 'finished') return;
    // The last section ends with the song.
    if (this.#sectionClean && this.phase === 'playing') this.#cleanBonus([]);
    this.phase = 'finished';
  }

  results(): RunResults {
    let pickups = 0;
    for (const c of this.#score.collected) pickups += c;
    const { perfect, good, miss, overdrives, saves } = this.#counts;
    const judged = perfect + good + miss;
    const timing = timingOf(perfect, good, miss);
    return {
      score: this.#score.score,
      rank: rankOf(timing, this.deaths),
      timing,
      accuracy: judged > 0 ? (perfect + good) / judged : null,
      perfect,
      good,
      miss,
      deaths: this.deaths,
      saves,
      pickups,
      totalPickups: this.level.pickups.length,
      bestCombo: this.#score.bestCombo,
      overdrives,
      clean: this.#score.clean,
      sections: this.checkpoints.length,
    };
  }

  #spawn(c: Checkpoint): PlayerState {
    return { ...startState(c.x, c.y), surface: c.surface };
  }

  #advance(t: number, input: RunInput, events: RunEvent[]): void {
    // Passing a checkpoint ends a section (clean when there was no hit), then saves the
    // score, meter and boosters to go back to.
    const next = this.checkpoints.find((c) => c.time > this.checkpoint.time);
    if (next && t >= next.time) {
      if (this.#sectionClean) this.#cleanBonus(events);
      this.#sectionClean = true;
      this.checkpoint = next;
      this.#saved = copyScore(this.#score);
    }
    if (this.rescue) {
      this.#bounce(t);
      return;
    }

    let prev = this.player;
    const s = this.#score;
    if (this.autoplay) {
      const press = this.autoplay.get(stepAt(t));
      if (press?.jump) this.#jumpUntil = t;
      if (press?.dash) this.#dashUntil = t;
      if (press?.slam) this.#slamUntil = t;
      input = { ...input, jumpHeld: !press?.release };
    }
    const jump = t <= this.#jumpUntil && canJump(prev);
    if (jump) this.#jumpUntil = -Infinity;
    let dash = t <= this.#dashUntil && canDash(prev);
    // The extra dash booster: a second dash in the air, once the first is over.
    const extra =
      !dash &&
      t <= this.#dashUntil &&
      s.extraDash &&
      !prev.grounded &&
      !prev.slamming &&
      prev.dashLeft === 0;
    if (extra) {
      prev = { ...prev, dashReady: true };
      dash = true;
    }
    if (dash) this.#dashUntil = -Infinity;
    const slam = t <= this.#slamUntil && canSlam(prev);
    if (slam) this.#slamUntil = -Infinity;
    const p = stepPlayer(prev, { jump, release: !input.jumpHeld, dash, slam }, this.world, t);
    this.player = p;

    if (!p.alive) {
      if (s.shield && this.#shieldHit(t, p, events)) return;
      this.phase = 'dying';
      this.diedAt = t;
      this.deathCause = p.death ?? 'pit';
      this.deaths++;
      // Everything goes back to the checkpoint's; the best combo reached stays.
      const best = s.bestCombo;
      this.#score = copyScore(this.#saved);
      this.#score.bestCombo = Math.max(best, this.#score.bestCombo);
      events.push({ type: 'death', cause: p.death ?? 'pit', x: p.x, y: p.y });
      return;
    }

    if (jump && p.jumped) {
      this.jumpedAt = t;
      events.push(this.#judge('takeoff', t, p));
    }
    if (dash && p.dashLeft > 0) {
      if (extra) s.extraDash = false;
      this.dashedAt = t;
      events.push(this.#judge('dash', t, p));
    }
    if (slam && p.slamming) this.slammedAt = t;
    // Through a plate in a slam, its first step included (it may start just above one).
    if (prev.slamming || slam) this.#breakPlates(t, prev, p, events);
    if (!prev.grounded && p.grounded) {
      this.landedAt = t;
      // The extra dash lasts until the next landing.
      s.extraDash = false;
      // A jump's landing is where its takeoff and the ground put it: off the grid it isn't
      // judged (a miss there would break a combo the player timed right), on it it scores.
      if (prev.slamming) {
        this.slamLandedAt = t;
        events.push(this.#judge('slam', t, p));
      } else if (prev.jumped && judgeAt(this.level.grid, t) !== 'miss')
        events.push(this.#judge('land', t, p));
    }
    this.#collect(t, p, events);
  }

  /** A slam going through a plate's top breaks it. */
  #breakPlates(t: number, prev: PlayerState, p: PlayerState, events: RunEvent[]): void {
    const solids = this.level.solids;
    for (const i of this.world.solidsBetween(p.x, p.x + PLAYER_WIDTH)) {
      const s = solids[i]!;
      if (s.kind !== 'plate' || this.brokenAt.has(i) || prev.y < s.top || p.y >= s.top) continue;
      this.brokenAt.set(i, t);
      events.push({ type: 'plate', x: p.x + PLAYER_WIDTH / 2, y: s.top });
    }
  }

  /**
   * A hit with a shield: the shield goes, the combo breaks, and the player bounces up and
   * over onto the nearest surface they can stand on safely. False when there is none near
   * enough: the hit is a death after all.
   */
  #shieldHit(t: number, p: PlayerState, events: RunEvent[]): boolean {
    const safe = this.#safeLanding(t);
    if (!safe) return false;
    const s = this.#score;
    s.shield = false;
    this.#breakCombo();
    this.#sectionClean = false;
    this.#counts.saves++;
    this.shieldHitAt = t;
    this.#clearPresses();
    const y0 = p.y;
    this.rescue = { from: t, to: safe.time, y0, y1: safe.y, surface: safe.surface };
    const x = this.world.xAt(t);
    const up: PlayerState = { ...p, alive: true, x, grounded: false, slamming: false, dashLeft: 0 };
    delete up.death;
    this.player = up;
    events.push({ type: 'shield', x: x + PLAYER_WIDTH / 2, y: y0 });
    return true;
  }

  /** The first moment and surface after a hit the player can land on and stand on safely. */
  #safeLanding(t: number): { time: number; y: number; surface: number } | null {
    const world = this.world;
    for (let step = stepAt(t + RESCUE_MIN); step * PHYSICS_DT <= t + RESCUE_MAX; step++) {
      const at = step * PHYSICS_DT;
      if (at >= this.level.duration) return null;
      const x = world.xAt(at);
      let best: { surface: number; top: number } | null = null;
      let ceiling = Infinity;
      for (const i of world.solidsBetween(x, x + PLAYER_WIDTH)) {
        const top = world.topAt(i, at);
        if (top === null) continue;
        const bottom = world.bottomOf(i);
        if (bottom !== -Infinity) ceiling = Math.min(ceiling, bottom);
        else if (!best || top > best.top) best = { surface: i, top };
      }
      if (!best || best.top + PLAYER_HEIGHT > ceiling) continue;
      // Standing there doing nothing for a moment must be safe: no wall, gate or spikes.
      let q: PlayerState = { ...startState(x, best.top), surface: best.surface };
      for (let k = 1; k * PHYSICS_DT <= SAFE_TIME && q.alive; k++)
        q = stepPlayer(q, { jump: false }, world, (step + k) * PHYSICS_DT);
      if (q.alive && q.grounded) return { time: at, y: best.top, surface: best.surface };
    }
    return null;
  }

  /** A step of the shield's bounce: an arc over everything, landing on its safe surface. */
  #bounce(t: number): void {
    const r = this.rescue!;
    const x = this.world.xAt(t);
    if (t >= r.to - 1e-9) {
      this.player = { ...startState(x, r.y1), surface: r.surface };
      this.rescue = null;
      this.landedAt = t;
      return;
    }
    const u = (t - r.from) / (r.to - r.from);
    const rise = Math.max(r.y0, r.y1) + RESCUE_RISE - (r.y0 + r.y1) / 2;
    const y = r.y0 + (r.y1 - r.y0) * u + 4 * rise * u * (1 - u);
    this.player = { ...this.player, x, y, vy: 0, grounded: false, slamming: false, dashLeft: 0 };
  }

  /** Rate something the player did by how close to a beat or an eighth it is, and score it. */
  #judge(action: BeatAction, t: number, p: PlayerState): RunEvent {
    // Takeoffs and dashes come from a press (autoplay's act on their own step); landings
    // happen where they are drawn.
    const pressed = !this.autoplay && (action === 'takeoff' || action === 'dash');
    const at = pressed ? t - this.inputLead : t;
    const quality = judgeAt(this.level.grid, at);
    this.#counts[quality]++;
    const s = this.#score;
    const x = p.x + PLAYER_WIDTH / 2;
    let points = 0;
    let accent = false;
    if (quality === 'miss') this.#breakCombo();
    else {
      accent = this.#isAccent(action, at);
      points = this.#gain(t, POINTS[quality] * (accent ? ACCENT_FACTOR : 1));
      if (quality === 'perfect') {
        this.#fill(t, METER_PERFECT);
        if (++s.perfects % STREAK_PERFECTS === 0)
          this.#streak = {
            type: 'streak',
            count: s.perfects,
            points: this.#bonus(t, STREAK_BONUS),
            x,
            y: p.y,
          };
      } else s.perfects = 0;
    }
    return { type: 'beat', action, quality, accent, points, x, y: p.y };
  }

  /** A streak bonus earned by the last judgement, handed out after its beat event. */
  #streak: RunEvent | null = null;

  /** A dash on a snare, or a slam landing on a kick or a downbeat. */
  #isAccent(action: BeatAction, t: number): boolean {
    if (action === 'dash') return nearest(this.music.snares, t) <= GOOD_WINDOW;
    if (action === 'slam')
      return (
        nearest(this.music.kicks, t) <= GOOD_WINDOW ||
        nearest(this.level.grid.downbeats, t) <= GOOD_WINDOW
      );
    return false;
  }

  /** Overdrive, when the meter is full: 4 bars of double score, a bonus on a downbeat. */
  #activate(t: number, events: RunEvent[]): void {
    const s = this.#score;
    if (s.meter < 1 || this.overdriveAt(t) || this.rescue) return;
    const grid = this.level.grid;
    // The bonus is the combo's, not doubled: overdrive starts with it.
    const downbeat = nearest(grid.downbeats, t) <= GOOD_WINDOW;
    const points = downbeat ? this.#bonus(t, DOWNBEAT_BONUS) : 0;
    s.meter = 0;
    s.overdriveFrom = t;
    s.overdriveUntil = timeOfBeat(grid, beatAt(grid, t) + OVERDRIVE_BEATS);
    this.#counts.overdrives++;
    const p = this.player;
    events.push({ type: 'overdrive', downbeat, points, x: p.x + PLAYER_WIDTH / 2, y: p.y });
  }

  #cleanBonus(events: RunEvent[]): void {
    const s = this.#score;
    s.clean++;
    s.score += CLEAN_BONUS;
    events.push({ type: 'clean', points: CLEAN_BONUS });
  }

  #collect(t: number, p: PlayerState, events: RunEvent[]): void {
    const pickups = this.level.pickups;
    const s = this.#score;
    const collected = s.collected;
    const magnet = t >= s.magnetFrom && t < s.magnetUntil;
    for (let i = 0; i < pickups.length; i++) {
      if (collected[i]) continue;
      const k = pickups[i]!;
      const kind = k.kind === 'coin' || k.kind === 'gem' ? k.kind : 'booster';
      const pull = magnet && kind === 'coin';
      const r = pull ? MAGNET_RADIUS : PICKUP_RADIUS[kind];
      if (k.x < p.x - r || k.x > p.x + PLAYER_WIDTH + r) continue;
      // Nearest point of the box to the pickup's centre.
      const nx = Math.max(p.x, Math.min(k.x, p.x + PLAYER_WIDTH));
      const ny = Math.max(p.y, Math.min(k.y, p.y + PLAYER_HEIGHT));
      const d2 = (nx - k.x) ** 2 + (ny - k.y) ** 2;
      if (d2 > r * r) continue;
      collected[i] = 1;
      const points = this.#gain(t, POINTS[kind]);
      if (k.kind === 'gem') this.#fill(t, METER_GEM);
      else if (kind === 'booster') this.#boost(k.kind as BoosterKind, t);
      const pulled = pull && d2 > PICKUP_RADIUS.coin ** 2;
      events.push({ type: 'pickup', index: i, points, pulled });
    }
    if (this.#streak) {
      events.push(this.#streak);
      this.#streak = null;
    }
  }

  #boost(kind: BoosterKind, t: number): void {
    const s = this.#score;
    if (kind === 'shield') s.shield = true;
    else if (kind === 'dash') s.extraDash = true;
    else {
      const grid = this.level.grid;
      s.magnetFrom = t;
      s.magnetUntil = timeOfBeat(grid, beatAt(grid, t) + MAGNET_BEATS);
    }
  }

  /** The overdrive meter fills, but not while an overdrive runs. */
  #fill(t: number, amount: number): void {
    const s = this.#score;
    // Twelve twelfths make a full meter, whatever the rounding.
    if (!this.overdriveAt(t)) s.meter = s.meter + amount >= 1 - 1e-9 ? 1 : s.meter + amount;
  }

  #breakCombo(): void {
    this.#score.combo = 0;
    this.#score.perfects = 0;
  }

  /** Add to the combo and the score, multiplied; returns the points scored. */
  #gain(t: number, base: number): number {
    const s = this.#score;
    s.combo++;
    s.bestCombo = Math.max(s.bestCombo, s.combo);
    return this.#bonus(t, base);
  }

  /** Points times the multiplier and overdrive, without adding to the combo. */
  #bonus(t: number, base: number): number {
    const points =
      base * multiplierOf(this.#score.combo) * (this.overdriveAt(t) ? OVERDRIVE_FACTOR : 1);
    this.#score.score += points;
    return points;
  }
}

function copyScore(s: Score): Score {
  return { ...s, collected: s.collected.slice() };
}
