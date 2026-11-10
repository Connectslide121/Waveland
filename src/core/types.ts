/**
 * The shared shapes every game reads. Provisional: the song analysis and level-map tasks
 * fill these in. All times are in seconds on the song's own timeline, played back
 * against the audio clock (`AudioContext.currentTime`).
 */

/** A span of the song with a steady character (intro, verse, chorus, breakdown…). */
export interface Section {
  start: number;
  end: number;
  /** Mean energy over the section, 0 to 1. */
  energy: number;
}

/** A moment where the song drops: energy jumps after a build-up. */
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
  /** The first beat of every bar. */
  downbeats: number[];
  /** Overall loudness over time. */
  energy: EnergyCurve;
  /** Low-frequency energy over time (the kick and bassline). */
  bass: EnergyCurve;
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
