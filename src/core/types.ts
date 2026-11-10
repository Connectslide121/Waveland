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

/** What kind of musical event a level moment comes from. */
export type LevelEventKind = 'kick' | 'snare' | 'offbeat' | 'bass' | 'drop' | 'section';

/** One moment in the level that a game turns into something (a platform, a bridge, a gate…). */
export interface LevelEvent {
  time: number;
  kind: LevelEventKind;
  /** How strong the moment is, 0 to 1. */
  intensity: number;
}

/** The level built from a song: what every game reads, each in its own way. */
export interface LevelMap {
  duration: number;
  tempo: number;
  events: LevelEvent[];
  sections: Section[];
  drops: Drop[];
}
