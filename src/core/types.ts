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

/**
 * A stretch of the song at one steady tempo. The first starts at 0 and the last ends at
 * the song's end; each later one starts on the first beat played at its tempo.
 */
export interface TempoSegment {
  start: number;
  end: number;
  /** Beats per minute. */
  tempo: number;
  /** Seconds per beat. */
  beatPeriod: number;
}

/**
 * A hit or chord that rings or holds: after a strong hit the loudness stays up while the
 * hits thin out (a held note, a long chord, a crash ringing, feedback). From its hit at
 * `time` until it fades or the next strong hit at `end`.
 */
export interface Sustain {
  time: number;
  end: number;
  /** How strong its hit is, 0 to 1. */
  strength: number;
  /** What holds: one note, a chord (three pitch classes or more), or a cymbal ringing. */
  sound: 'note' | 'chord' | 'ring';
}

/**
 * A stop or break: the band cuts out, or nearly, for a beat or more from `time`, and
 * comes back in at `end`.
 */
export interface Stop {
  time: number;
  end: number;
}

/**
 * An accent: a hit in several bands at once (a crash with a kick, a band stab), clearly
 * stronger than the beats around it.
 */
export interface Accent {
  time: number;
  /** How far it stands out, 0 to 1. */
  strength: number;
}

/**
 * A fill: a dense run of hits (snare, toms) in the last beat or two before a bar line or
 * a section change. `hits` are its hits in time order; `end` the bar line it leads into.
 */
export interface Fill {
  time: number;
  end: number;
  hits: number[];
}

/** A strong hit off the beat: a kick or a snare on an "and" or a sixteenth. */
export interface Syncopation {
  time: number;
  strength: number;
}

/**
 * A bar, and the first bar of the song that sounds like it (its pitch classes, its hits
 * per band on a sixteenth grid, its loudness): bars that repeat a riff or a chorus have
 * the same `repeats`.
 */
export interface BarInfo {
  start: number;
  end: number;
  /** Index (in the same list) of the first bar that sounds like this one; its own when none. */
  repeats: number;
  /** How alike the two are, 0 to 1 (1 for a bar that repeats nothing). */
  similarity: number;
}

/** The musical moments games build their obstacles from. */
export interface MusicFeatures {
  sustains: Sustain[];
  stops: Stop[];
  accents: Accent[];
  fills: Fill[];
  syncopations: Syncopation[];
  bars: BarInfo[];
}

/** What the core learns from a song, once, and caches. */
export interface SongAnalysis {
  duration: number;
  /** Beats per minute: the tempo the song spends most of its time at. */
  tempo: number;
  /** The tempo map: one segment for a steady song, more where the tempo changes. */
  segments: TempoSegment[];
  /** Every beat, following the tempo map. */
  beats: number[];
  /** The first beat of every bar (4/4 assumed, counted afresh in each tempo segment). */
  downbeats: number[];
  /** Hits per band: kick (low), snare (mid) and hi-hat (high), approximately. */
  onsets: Record<Band, Onset[]>;
  /** Overall loudness over time. */
  energy: EnergyCurve;
  /** Loudness per band over time, at the same rate as `energy`. */
  bands: Record<Band, EnergyCurve>;
  sections: Section[];
  drops: Drop[];
  /** Held sounds, stops, accents, fills, syncopations and repeated bars. */
  features: MusicFeatures;
}

/**
 * How the song's beat reads (`beatFit` in `level-map.ts`): one steady tempo, a tempo that
 * changes (several segments, which the games follow), a loose beat that drifts off even
 * its own segment's grid (swing, rubato), or hardly a beat at all.
 */
export type BeatFit = 'steady' | 'changing' | 'loose' | 'none';

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
 * The beat grid games time things by: regular within each tempo segment, covering the
 * whole song. Read it with the helpers in `tempo-map.ts` (`beatAt`, `timeOfBeat`,
 * `periodAt`, `tempoAt`, `barAt`), never with start + k × period arithmetic.
 */
export interface TempoGrid {
  /** The tempo segments, from 0 to the song's end; each later one starts on a grid beat. */
  segments: TempoSegment[];
  /** Every beat from the start of the song to its end, regular within each segment. */
  beats: number[];
  /** The beats that start a bar (4/4), a subset of `beats`. */
  downbeats: number[];
}

/**
 * How a section feels, for the games to shape their world by: a calm part (quiet, sparse),
 * a groove (a verse, steady), a chorus (loud, full), a build toward a drop, the drop
 * itself, or a breakdown (the band thinning out before or after one).
 */
export type SectionFeel = 'calm' | 'groove' | 'chorus' | 'build' | 'drop' | 'breakdown';

/** What a stretch of the song is like, each 0 to 1. */
export interface Mood {
  /** How loud and driven: the energy, over the song's own range. */
  intensity: number;
  /** How bright: the high band's share of the sound (cymbals, a lead, distortion). */
  brightness: number;
  /** How busy: hits per beat, 1 at four a beat (sixteenths) or more. */
  density: number;
  /** How heavy: the low band's share of the sound (kick and bass). */
  heaviness: number;
}

/** A section's mood (its beats' mean) and how it feels. */
export interface SectionMood extends Mood {
  feel: SectionFeel;
}

/**
 * The mood beat by beat (one value per grid beat in each), smoothed over about a bar so
 * it follows the music's contour rather than every hit.
 */
export interface MoodCurves {
  intensity: number[];
  brightness: number[];
  density: number[];
  heaviness: number[];
}

/**
 * The level built from a song: what every game reads, each in its own way. Pure data,
 * the same for the same analysis; the beat grid follows the tempo map and covers the
 * whole song.
 */
export interface LevelMap extends TempoGrid {
  /** Derived from the analysis, so games seed their own randomness from the song. */
  seed: number;
  duration: number;
  /** The main tempo (the one the song spends most of its time at), for display. */
  tempo: number;
  /** Index in `beats` of the first downbeat (0 to 3). */
  barPhase: number;
  /** Bass energy per grid beat, 0 to 1 over the song's own range. */
  bass: number[];
  /** Overall energy per grid beat, 0 to 1 over the song's own range. */
  energy: number[];
  /** Every moment, sorted by time. */
  events: LevelEvent[];
  sections: Section[];
  /** Each section's mood and feel, in the same order as `sections`. */
  moods: SectionMood[];
  /** The mood per grid beat, smoothed: what the games' look and terrain follow. */
  mood: MoodCurves;
  drops: Drop[];
  /**
   * The analysis' musical moments put on the grid: hits snapped as the events are, fills
   * ending on a grid bar line, and `bars` one per grid bar (`downbeats`), each with the
   * first grid bar that sounds like it.
   */
  features: MusicFeatures;
}
