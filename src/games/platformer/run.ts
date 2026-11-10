import type { Section } from '../../core';
import { stepAt } from './level/validate';
import { LevelWorld, xAtTime, type PlatformerLevel } from './level';
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
  type PlayerState,
} from './physics';

/**
 * One play of the platformer's level, without any drawing: the player's fixed physics
 * steps on song time, deaths and checkpoints, pickups and the score. The scene feeds it
 * the audio clock's time and the controls every frame and draws what it says.
 */

/** A takeoff, landing, dash or slam within this many seconds of a beat is perfect, or good. */
export const PERFECT_WINDOW = 0.06;
export const GOOD_WINDOW = 0.12;
/** Beats of count-in after a pause: the music rewinds this far and the player waits. */
export const RESUME_BEATS = 2;
/** How long the death effect plays, in song time, before the music rewinds. */
export const DEATH_TIME = 0.7;
/** Points, before the combo multiplier. A slam landing on the beat is an accent: doubled. */
export const POINTS = { coin: 100, gem: 500, perfect: 300, good: 100 } as const;
export const ACCENT_FACTOR = 2;
/** Every this many in a row raises the multiplier by one, up to `MAX_MULTIPLIER`. */
export const COMBO_STEP = 8;
export const MAX_MULTIPLIER = 4;
/** How close to a pickup's centre the player's box has to come, px. */
const PICKUP_RADIUS = { coin: 16, gem: 22 } as const;
/** The physics never runs more steps than this in one frame (a long stall jumps ahead). */
const MAX_STEPS_PER_UPDATE = 240;

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
}

export type BeatQuality = 'perfect' | 'good' | 'miss';

/** What the player did that is judged against the beat. */
export type BeatAction = 'takeoff' | 'land' | 'dash' | 'slam';

/** Something that happened, for the scene's effects. */
export type RunEvent =
  | {
      type: 'beat';
      action: BeatAction;
      quality: BeatQuality;
      points: number;
      x: number;
      y: number;
    }
  | { type: 'pickup'; index: number; points: number }
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

interface Score {
  score: number;
  combo: number;
  bestCombo: number;
  collected: Uint8Array;
}

export interface RunResults {
  score: number;
  /** Share of takeoffs, landings, dashes and slams on the beat, 0 to 1, or null when none. */
  accuracy: number | null;
  deaths: number;
  pickups: number;
  totalPickups: number;
  bestCombo: number;
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

/** Seconds from `t` to the nearest beat of the level's grid. */
export function offBeat(level: Pick<PlatformerLevel, 'gridStart' | 'beatPeriod'>, t: number) {
  const beats = (t - level.gridStart) / level.beatPeriod;
  return Math.abs(beats - Math.round(beats)) * level.beatPeriod;
}

export function multiplierOf(combo: number): number {
  return Math.min(MAX_MULTIPLIER, 1 + Math.floor(combo / COMBO_STEP));
}

export class PlatformerRun {
  readonly world: LevelWorld;
  readonly checkpoints: Checkpoint[];
  /** Seconds of one bar: the count-in before every (re)start. */
  readonly bar: number;

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
  /** What the last death was. */
  deathCause: DeathCause | null = null;

  #score: Score;
  /** The score as it was at the checkpoint, put back on a death. */
  #saved: Score;
  #step = 0;
  /** Seconds of music before `resumeAt` that the count-in plays. */
  #countIn: number;
  /** Presses wait this long for the moment they can act (jump and dash buffer, slam this frame). */
  #jumpUntil = -Infinity;
  #dashUntil = -Infinity;
  #slamUntil = -Infinity;
  #judged = 0;
  #onBeat = 0;

  constructor(
    readonly level: PlatformerLevel,
    sections: Section[],
  ) {
    this.world = new LevelWorld(level);
    this.checkpoints = checkpointsOf(level, sections);
    this.bar = 4 * level.beatPeriod;
    this.checkpoint = this.checkpoints[0]!;
    this.player = this.#spawn(this.checkpoint);
    this.resumeAt = this.checkpoint.time;
    this.#countIn = this.bar;
    this.#score = {
      score: 0,
      combo: 0,
      bestCombo: 0,
      collected: new Uint8Array(level.pickups.length),
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

  isCollected(index: number): boolean {
    return this.#score.collected[index] === 1;
  }

  /**
   * The song time to play the music from for the count-in: a bar before the checkpoint,
   * or `RESUME_BEATS` before where a pause stopped the player.
   */
  get countInFrom(): number {
    return this.resumeAt - this.#countIn;
  }

  /**
   * Going on after a pause: the player stays where they are, frozen through a short
   * count-in, so play never starts again mid-jump without warning. Returns where the music
   * plays from. Only while playing: a count-in or a death plays on as it was.
   */
  holdForResume(): number {
    if (this.phase !== 'playing') return this.countInFrom;
    this.resumeAt = this.#step * PHYSICS_DT;
    this.#countIn = RESUME_BEATS * this.level.beatPeriod;
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
      if (this.phase === 'playing' && time >= this.level.duration) this.finish();
    }
    const respawn = this.phase === 'dying' && time - this.diedAt >= DEATH_TIME;
    return { events, respawn };
  }

  /** Back to the checkpoint, frozen through a one-bar count-in. Returns where the music plays from. */
  respawn(): number {
    this.player = this.#spawn(this.checkpoint);
    this.resumeAt = this.checkpoint.time;
    this.#countIn = this.bar;
    this.#clearPresses();
    this.landedAt = -Infinity;
    this.jumpedAt = -Infinity;
    this.dashedAt = -Infinity;
    this.slammedAt = -Infinity;
    this.slamLandedAt = -Infinity;
    this.phase = 'countin';
    return this.countInFrom;
  }

  finish(): void {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
  }

  results(): RunResults {
    let pickups = 0;
    for (const c of this.#score.collected) pickups += c;
    return {
      score: this.#score.score,
      accuracy: this.#judged > 0 ? this.#onBeat / this.#judged : null,
      deaths: this.deaths,
      pickups,
      totalPickups: this.level.pickups.length,
      bestCombo: this.#score.bestCombo,
    };
  }

  #spawn(c: Checkpoint): PlayerState {
    return { ...startState(c.x, c.y), surface: c.surface };
  }

  #advance(t: number, input: RunInput, events: RunEvent[]): void {
    // Passing a checkpoint saves the score to go back to.
    const next = this.checkpoints.find((c) => c.time > this.checkpoint.time);
    if (next && t >= next.time) {
      this.checkpoint = next;
      this.#saved = copyScore(this.#score);
    }

    const prev = this.player;
    const jump = t <= this.#jumpUntil && canJump(prev);
    if (jump) this.#jumpUntil = -Infinity;
    const dash = t <= this.#dashUntil && canDash(prev);
    if (dash) this.#dashUntil = -Infinity;
    const slam = t <= this.#slamUntil && canSlam(prev);
    if (slam) this.#slamUntil = -Infinity;
    const p = stepPlayer(prev, { jump, release: !input.jumpHeld, dash, slam }, this.world, t);
    this.player = p;

    if (!p.alive) {
      this.phase = 'dying';
      this.diedAt = t;
      this.deathCause = p.death ?? 'pit';
      this.deaths++;
      // The score goes back to the checkpoint's; the best combo reached stays.
      const best = this.#score.bestCombo;
      this.#score = copyScore(this.#saved);
      this.#score.combo = 0;
      this.#score.bestCombo = best;
      events.push({ type: 'death', cause: p.death ?? 'pit', x: p.x, y: p.y });
      return;
    }

    if (jump && p.jumped) {
      this.jumpedAt = t;
      events.push(this.#judge('takeoff', t, p));
    }
    if (dash && p.dashLeft > 0) {
      this.dashedAt = t;
      events.push(this.#judge('dash', t, p));
    }
    if (slam && p.slamming) this.slammedAt = t;
    if (!prev.grounded && p.grounded) {
      this.landedAt = t;
      if (prev.slamming) {
        this.slamLandedAt = t;
        events.push(this.#judge('slam', t, p));
      } else if (prev.jumped) events.push(this.#judge('land', t, p));
    }
    this.#collect(p, events);
  }

  /** Rate something the player did by how close to a beat it is, and score it. */
  #judge(action: BeatAction, t: number, p: PlayerState): RunEvent {
    const off = offBeat(this.level, t);
    const quality: BeatQuality =
      off <= PERFECT_WINDOW ? 'perfect' : off <= GOOD_WINDOW ? 'good' : 'miss';
    this.#judged++;
    let points = 0;
    if (quality === 'miss') this.#score.combo = 0;
    else {
      this.#onBeat++;
      points = this.#gain(POINTS[quality] * (action === 'slam' ? ACCENT_FACTOR : 1));
    }
    return { type: 'beat', action, quality, points, x: p.x + PLAYER_WIDTH / 2, y: p.y };
  }

  #collect(p: PlayerState, events: RunEvent[]): void {
    const pickups = this.level.pickups;
    const collected = this.#score.collected;
    for (let i = 0; i < pickups.length; i++) {
      if (collected[i]) continue;
      const k = pickups[i]!;
      const r = PICKUP_RADIUS[k.kind];
      if (k.x < p.x - r || k.x > p.x + PLAYER_WIDTH + r) continue;
      // Nearest point of the box to the pickup's centre.
      const nx = Math.max(p.x, Math.min(k.x, p.x + PLAYER_WIDTH));
      const ny = Math.max(p.y, Math.min(k.y, p.y + PLAYER_HEIGHT));
      if ((nx - k.x) ** 2 + (ny - k.y) ** 2 > r * r) continue;
      collected[i] = 1;
      events.push({ type: 'pickup', index: i, points: this.#gain(POINTS[k.kind]) });
    }
  }

  /** Add to the combo and the score, multiplied; returns the points scored. */
  #gain(base: number): number {
    const s = this.#score;
    s.combo++;
    s.bestCombo = Math.max(s.bestCombo, s.combo);
    const points = base * multiplierOf(s.combo);
    s.score += points;
    return points;
  }
}

function copyScore(s: Score): Score {
  return { ...s, collected: s.collected.slice() };
}
