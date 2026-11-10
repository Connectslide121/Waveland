/**
 * The shared shapes every game reads. All times are in seconds on the song's own
 * timeline, played back against the audio clock (`AudioClock.time`).
 */

/** The three bands the core listens to, roughly kick (low), snare (mid) and hi-hat (high). */
export type Band = 'low' | 'mid' | 'high';

export const BANDS: readonly Band[] = ['low', 'mid', 'high'];

/** A hit in one band: a kick, a snare or a hi-hat, approximately. */
export interface Onset {
  time: number;
  /** How hard it hits compared with the band's loud hits, 0 to 1. */
  strength: number;
}

/** What a section is like, from its energy and the sections around it. */
export type SectionKind = 'intro' | 'build' | 'drop' | 'breakdown' | 'main' | 'outro';

/** A span of the song with a steady character, starting and ending on a bar line. */
export interface Section {
  start: number;
  end: number;
  kind: SectionKind;
  /** Mean energy over the section, 0 to 1. */
  energy: number;
}

/** A moment where the song drops: energy jumps after a build-up or a breakdown. */
export interface Drop {
  time: number;
  /** How hard it hits, 0 to 1. */
  strength: number;
}

/** Energy sampled at a fixed rate, each value 0 to 1. */
export interface EnergyCurve {
  /** Seconds between samples. */
  step: number;
  values: Float32Array;
}

/** What the core learns from a song, once, and caches. */
export interface SongAnalysis {
  duration: number;
  /** Beats per minute. */
  tempo: number;
  /** Every beat. */
  beats: number[];
  /** The first beat of every bar (4/4 assumed). */
  downbeats: number[];
  /** Hits per band: kick (low), snare (mid) and hi-hat (high), approximately. */
  onsets: Record<Band, Onset[]>;
  /** Overall loudness over time. */
  energy: EnergyCurve;
  /** Loudness per band over time, at the same rate as `energy`. */
  bands: Record<Band, EnergyCurve>;
  sections: Section[];
  drops: Drop[];
}

/** How hard a game builds its level: density of obstacles, gap sizes and so on. */
export type Difficulty = 'easy' | 'normal' | 'hard';

export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];

/**
 * What kind of musical moment a level event is: a kick (low band), a snare (mid band), an
 * off-beat (halfway between two beats), a hi-hat (high band), a drop, or a section start.
 */
export type LevelEventKind = 'kick' | 'snare' | 'offbeat' | 'hat' | 'drop' | 'section';

/** One moment in the level that a game turns into something (a bridge, a coin, a gate…). */
export interface LevelEvent {
  time: number;
  kind: LevelEventKind;
  /** How strong the moment is, 0 to 1. */
  intensity: number;
  /** Index of the grid beat at or just before the moment (`LevelMap.beats`). */
  beat: number;
  /** What the section starting here is like (only on `section` events). */
  section?: SectionKind;
}

/**
 * The level built from a song: what every game reads, each in its own way. Pure data,
 * the same for the same analysis; the beat grid is regular and covers the whole song.
 */
export interface LevelMap {
  /** Derived from the analysis, so games seed their own randomness from the song. */
  seed: number;
  duration: number;
  tempo: number;
  /** Seconds per beat on the grid. */
  beatPeriod: number;
  /** A regular beat grid from the start of the song to its end. */
  beats: number[];
  /** The beats that start a bar (4/4), a subset of `beats`. */
  downbeats: number[];
  /** Index in `beats` of the first downbeat (0 to 3). */
  barPhase: number;
  /** Bass energy per grid beat, 0 to 1 over the song's own range. */
  bass: number[];
  /** Overall energy per grid beat, 0 to 1 over the song's own range. */
  energy: number[];
  /** Every moment, sorted by time. */
  events: LevelEvent[];
  sections: Section[];
  drops: Drop[];
}
