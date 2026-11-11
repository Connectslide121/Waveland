/**
 * The song library: twenty songs the composer writes (`compose.ts`), four in each of its
 * five styles, each three to five minutes long, so a level is always one click away.
 * A song is only its description here; its sound is made when it is picked.
 */

export type LibraryStyle = 'electro' | 'synthwave' | 'rock' | 'dnb' | 'chip';
/** A part of a song's form. A chorus is the loud part of any style (a drop, in electro). */
export type PartKind = 'intro' | 'verse' | 'pre' | 'chorus' | 'break' | 'bridge' | 'outro';

export interface LibrarySong {
  id: string;
  title: string;
  style: LibraryStyle;
  bpm: number;
  /** The key's tonic as a MIDI note in the bass register (33 is A1, 40 is E2). */
  root: number;
  mode: 'minor' | 'major';
  seed: number;
  /** The parts in order: kind, bars, and a tempo of its own when it has one. */
  form: readonly (readonly [PartKind, number, number?])[];
}

export const STYLE_NAMES: Record<LibraryStyle, string> = {
  electro: 'Electro',
  synthwave: 'Synthwave',
  rock: 'Rock',
  dnb: 'Drum and bass',
  chip: 'Chiptune',
};

/** How long a song lasts, in seconds, from its form alone (no rendering). */
export function songSeconds(song: LibrarySong): number {
  let seconds = 1.5;
  for (const [, bars, bpm] of song.form) seconds += (bars * 4 * 60) / (bpm ?? song.bpm);
  return seconds;
}

/** A lead's rhythm for one bar: [beat, beats long]. */
export type Rhythm = readonly (readonly [number, number])[];

type Form = readonly (readonly [PartKind, number, number?])[];

/** Verse and chorus twice, a breakdown and a bridge, a last chorus: 120 bars. */
const SONG_FORM: Form = [
  ['intro', 8],
  ['verse', 16],
  ['pre', 4],
  ['chorus', 16],
  ['verse', 16],
  ['pre', 4],
  ['chorus', 16],
  ['break', 8],
  ['bridge', 8],
  ['pre', 4],
  ['chorus', 16],
  ['outro', 4],
];

/** A club track: long builds into three drops: 128 bars. */
const CLUB_FORM: Form = [
  ['intro', 16],
  ['pre', 8],
  ['chorus', 16],
  ['break', 8],
  ['verse', 16],
  ['pre', 8],
  ['chorus', 16],
  ['bridge', 8],
  ['pre', 8],
  ['chorus', 16],
  ['outro', 8],
];

/** For fast songs: four choruses and a long breakdown: 156 bars. */
const LONG_FORM: Form = [
  ['intro', 8],
  ['verse', 16],
  ['pre', 4],
  ['chorus', 16],
  ['verse', 16],
  ['pre', 4],
  ['chorus', 16],
  ['break', 16],
  ['verse', 8],
  ['pre', 4],
  ['chorus', 16],
  ['bridge', 8],
  ['pre', 4],
  ['chorus', 16],
  ['outro', 4],
];

/** For slow songs: 100 bars. */
const SHORT_FORM: Form = [
  ['intro', 4],
  ['verse', 16],
  ['pre', 4],
  ['chorus', 16],
  ['verse', 8],
  ['pre', 4],
  ['chorus', 16],
  ['break', 8],
  ['pre', 4],
  ['chorus', 16],
  ['outro', 4],
];

/** `form` with its bridge at `bridge` BPM and everything after it at `after`. */
function shifted(form: Form, bridge: number, after: number): Form {
  const at = form.findIndex(([kind]) => kind === 'bridge');
  return form.map(([kind, bars], i) =>
    i < at ? [kind, bars] : i === at ? [kind, bars, bridge] : [kind, bars, after],
  );
}

export const LIBRARY: readonly LibrarySong[] = [
  // Electro: four on the floor, stabs, long builds.
  {
    id: 'neon-overpass',
    title: 'Neon Overpass',
    style: 'electro',
    bpm: 126,
    root: 33,
    mode: 'minor',
    seed: 101,
    form: CLUB_FORM,
  },
  {
    id: 'gridrunner',
    title: 'Gridrunner',
    style: 'electro',
    bpm: 128,
    root: 31,
    mode: 'minor',
    seed: 102,
    form: CLUB_FORM,
  },
  {
    id: 'voltage-bloom',
    title: 'Voltage Bloom',
    style: 'electro',
    bpm: 132,
    root: 36,
    mode: 'major',
    seed: 103,
    form: SONG_FORM,
  },
  {
    id: 'afterglow-circuit',
    title: 'Afterglow Circuit',
    style: 'electro',
    bpm: 124,
    root: 29,
    mode: 'minor',
    seed: 104,
    form: CLUB_FORM,
  },
  // Synthwave: slower, arpeggios and long leads.
  {
    id: 'midnight-chrome',
    title: 'Midnight Chrome',
    style: 'synthwave',
    bpm: 100,
    root: 33,
    mode: 'minor',
    seed: 201,
    form: SHORT_FORM,
  },
  {
    id: 'sunset-vector',
    title: 'Sunset Vector',
    style: 'synthwave',
    bpm: 108,
    root: 35,
    mode: 'minor',
    seed: 202,
    form: SONG_FORM,
  },
  {
    id: 'laser-tide',
    title: 'Laser Tide',
    style: 'synthwave',
    bpm: 116,
    root: 31,
    mode: 'major',
    seed: 203,
    form: SONG_FORM,
  },
  {
    id: 'polaroid-skyline',
    title: 'Polaroid Skyline',
    style: 'synthwave',
    bpm: 96,
    root: 38,
    mode: 'minor',
    seed: 204,
    form: SHORT_FORM,
  },
  // Rock: power chords, fills and stops; two of them change tempo.
  {
    id: 'static-riot',
    title: 'Static Riot',
    style: 'rock',
    bpm: 170,
    root: 28,
    mode: 'minor',
    seed: 301,
    form: LONG_FORM,
  },
  {
    id: 'broken-antenna',
    title: 'Broken Antenna',
    style: 'rock',
    bpm: 156,
    root: 33,
    mode: 'minor',
    seed: 302,
    form: shifted(LONG_FORM, 138, 164),
  },
  {
    id: 'kerosene-hearts',
    title: 'Kerosene Hearts',
    style: 'rock',
    bpm: 180,
    root: 30,
    mode: 'minor',
    seed: 303,
    form: LONG_FORM,
  },
  {
    id: 'last-bus-out',
    title: 'Last Bus Out',
    style: 'rock',
    bpm: 148,
    root: 31,
    mode: 'major',
    seed: 304,
    form: shifted(SONG_FORM, 132, 156),
  },
  // Drum and bass: fast breaks, sixteenth hats.
  {
    id: 'liquid-halogen',
    title: 'Liquid Halogen',
    style: 'dnb',
    bpm: 174,
    root: 29,
    mode: 'minor',
    seed: 401,
    form: LONG_FORM,
  },
  {
    id: 'subway-ghosts',
    title: 'Subway Ghosts',
    style: 'dnb',
    bpm: 170,
    root: 33,
    mode: 'minor',
    seed: 402,
    form: LONG_FORM,
  },
  {
    id: 'razorwire-sky',
    title: 'Razorwire Sky',
    style: 'dnb',
    bpm: 176,
    root: 26,
    mode: 'minor',
    seed: 403,
    form: LONG_FORM,
  },
  {
    id: 'pulse-cascade',
    title: 'Pulse Cascade',
    style: 'dnb',
    bpm: 172,
    root: 31,
    mode: 'major',
    seed: 404,
    form: LONG_FORM,
  },
  // Chiptune: square waves, quick arpeggios.
  {
    id: 'pixel-comet',
    title: 'Pixel Comet',
    style: 'chip',
    bpm: 150,
    root: 36,
    mode: 'major',
    seed: 501,
    form: SONG_FORM,
  },
  {
    id: 'boss-rush',
    title: 'Boss Rush',
    style: 'chip',
    bpm: 160,
    root: 33,
    mode: 'minor',
    seed: 502,
    form: LONG_FORM,
  },
  {
    id: 'coin-heaven',
    title: 'Coin Heaven',
    style: 'chip',
    bpm: 140,
    root: 31,
    mode: 'major',
    seed: 503,
    form: SONG_FORM,
  },
  {
    id: 'game-over-again',
    title: 'Game Over, Again',
    style: 'chip',
    bpm: 168,
    root: 28,
    mode: 'minor',
    seed: 504,
    form: LONG_FORM,
  },
];
