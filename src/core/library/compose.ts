/**
 * The composer behind the song library: it writes a whole song from a short description
 * (`LibrarySong`: a style, a tempo, a key, a seed and a form) with the synthetic sounds of
 * `analysis/test-audio.ts` and `analysis/test-songs.ts`, so the library ships no audio
 * files. The same description always gives the same samples, so a song's analysis is
 * cached like any dropped file's.
 *
 * A song is written for the games to read: steady drums with a pattern of their own per
 * part, a fill into every eighth bar, crashes opening the loud phrases, a build before
 * each chorus, band stops, held chords in the quiet parts and a lead whose phrases repeat,
 * so the analysis finds kicks, snares, fills, accents, stops, held sounds, repeats and a
 * melody in it.
 */
import { hashOf, Random } from '../random';
import { chord, crash, drumKit } from '../analysis/test-audio';
import {
  bassNote,
  lead,
  pluck,
  powerChord,
  render,
  riser,
  stab,
  tone,
  type Bar,
  type Part,
  type TestSong,
} from '../analysis/test-songs';
import type { LibrarySong, LibraryStyle, Rhythm } from './songs';

const STEPS = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11] } as const;
/** Four-chord loops by scale degree (0 is the tonic). */
const PROGRESSIONS: Record<'minor' | 'major', readonly (readonly number[])[]> = {
  minor: [
    [0, 5, 2, 6],
    [0, 3, 5, 4],
    [0, 6, 5, 6],
    [0, 2, 6, 3],
    [0, 5, 3, 4],
  ],
  major: [
    [0, 4, 5, 3],
    [0, 5, 3, 4],
    [0, 3, 5, 4],
    [5, 3, 0, 4],
  ],
};

/** Kick patterns, as beats of the bar. */
const KICKS: Record<LibraryStyle, { verse: number[][]; chorus: number[][] }> = {
  electro: {
    verse: [[0, 1, 2, 3]],
    chorus: [
      [0, 1, 2, 3],
      [0, 1, 2, 2.5, 3],
    ],
  },
  synthwave: {
    verse: [
      [0, 2],
      [0, 2, 2.5],
      [0, 1.5, 2],
    ],
    chorus: [
      [0, 1, 2, 3],
      [0, 1.5, 2, 3.5],
      [0, 2, 2.5],
    ],
  },
  rock: {
    verse: [
      [0, 1.5, 2],
      [0, 2, 2.5],
      [0, 0.5, 2],
    ],
    chorus: [
      [0, 2, 2.5],
      [0, 1.5, 2, 2.5],
      [0, 0.5, 2, 3.5],
    ],
  },
  // Three kicks a bar at least: with two, every kick stands out as an accent.
  dnb: {
    verse: [
      [0, 1.5, 2.5],
      [0, 2.5, 3.5],
    ],
    chorus: [
      [0, 1.5, 2.5],
      [0, 2.5, 3.5],
      [0, 1.5, 2.5, 3.5],
    ],
  },
  chip: {
    verse: [
      [0, 2],
      [0, 1.5, 2],
    ],
    chorus: [
      [0, 1, 2, 3],
      [0, 1.5, 2, 3],
    ],
  },
};

/** A lead's rhythms for one bar: [beat, beats long]. */
const RHYTHMS: readonly Rhythm[] = [
  [
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
  ],
  [
    [0, 1.5],
    [1.5, 0.5],
    [2, 1],
    [3, 1],
  ],
  [
    [0, 0.5],
    [0.5, 0.5],
    [1, 1],
    [2, 2],
  ],
  [
    [0, 2],
    [2, 1],
    [3, 0.5],
    [3.5, 0.5],
  ],
  [
    [0, 1],
    [1, 0.5],
    [1.5, 1.5],
    [3, 1],
  ],
  [
    [0, 0.5],
    [0.5, 0.5],
    [1, 0.5],
    [1.5, 0.5],
    [2, 1],
    [3, 1],
  ],
];

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** A square wave (odd harmonics up to the ninth), plucked when `decay` is given. */
function square(freq: number, seconds: number, rate: number, decay = 0): Float32Array {
  const w = 2 * Math.PI * freq;
  return tone(seconds, rate, (t) => {
    let v = 0;
    for (let h = 1; h <= 9; h += 2) v += Math.sin(h * w * t) / h;
    return v * 0.45 * (decay > 0 ? Math.exp(-t / decay) : 1);
  });
}

/** The song as samples, with its true beats and parts. */
export function composeSong(song: LibrarySong, rate = 44100): TestSong {
  const { style, mode } = song;
  const rng = new Random(hashOf(song.seed, 'song'));
  const pick = <T>(list: readonly T[]): T => list[rng.int(0, list.length - 1)]!;
  const steps = STEPS[mode];
  /** The MIDI note `n` scale steps above the tonic. */
  const degree = (n: number) => song.root + 12 * Math.floor(n / 7) + steps[((n % 7) + 7) % 7]!;

  const verseChords = pick(PROGRESSIONS[mode]);
  const chorusChords = pick(PROGRESSIONS[mode]);
  const verseKick = pick(KICKS[style].verse);
  const chorusKick = pick(KICKS[style].chorus);
  /** A snare pushed onto the "and" of 4 every other bar of a chorus. */
  const pushed = rng.chance(0.6);
  /** The band stops in the seventh bar of every chorus from the second on. */
  const stops = rng.chance(0.7);
  const verseRhythms = [pick(RHYTHMS), pick(RHYTHMS)];
  const chorusRhythms = [pick(RHYTHMS), pick(RHYTHMS)];

  const kit = drumKit(rate);
  const cymbal = crash(rate);
  const sounds = new Map<string, Float32Array>();
  const cached = (key: string, make: () => Float32Array) => {
    let sound = sounds.get(key);
    if (!sound) sounds.set(key, (sound = make()));
    return sound;
  };
  const len = (seconds: number) => Math.round(seconds * 1000);

  // ---------- voices ----------
  const bass = (midi: number, seconds: number) =>
    cached(`bass${midi}:${len(seconds)}`, () =>
      style === 'chip'
        ? square(hz(midi + 12), seconds, rate)
        : style === 'synthwave'
          ? lead(hz(midi), seconds, rate)
          : bassNote(hz(midi), seconds, rate),
    );
  const triad = (d: number, octave = 1) => [0, 2, 4].map((k) => hz(degree(d + k) + 12 * octave));
  /** The part's chord, held for `seconds`. */
  const held = (d: number, seconds: number) =>
    cached(`held${d}:${len(seconds)}`, () =>
      style === 'rock'
        ? powerChord(hz(degree(d) + 12), seconds, rate)
        : chord(triad(d, 2), seconds, 0.12, rate),
    );
  /** The part's chord, short. */
  const hit = (d: number, seconds: number) =>
    cached(`hit${d}:${len(seconds)}`, () =>
      style === 'rock'
        ? powerChord(hz(degree(d) + 12), seconds, rate, true)
        : style === 'chip'
          ? square(hz(degree(d) + 24), seconds, rate, 0.12)
          : stab(triad(d, 2), seconds, rate),
    );
  const arp = (midi: number, seconds: number) =>
    cached(`arp${midi}:${len(seconds)}`, () =>
      style === 'chip' ? square(hz(midi), seconds, rate, 0.2) : pluck(hz(midi), seconds, rate),
    );
  const melody = (midi: number, seconds: number) =>
    cached(`lead${midi}:${len(seconds)}`, () =>
      style === 'chip' ? square(hz(midi), seconds, rate) : lead(hz(midi), seconds, rate),
    );

  // ---------- what a bar is made of ----------
  /** The chord arpeggiated in eighths (sixteenths when `quick`). */
  const arpeggio = (bar: Bar, d: number, gain: number, quick = false) => {
    const step = quick ? 0.25 : 0.5;
    for (let k = 0; k < 4 / step; k++) {
      const midi = degree(d + [0, 2, 4, 2][k % 4]!) + 36;
      bar.hit(arp(midi, bar.period * (quick ? 0.5 : 1.5)), k * step, gain);
    }
  };
  const hats = (bar: Bar, step: number, gain: number, from = 0, to = 4) => {
    for (let k = from; k < to - 1e-6; k += step)
      bar.hit(kit.hat, k, gain * (Number.isInteger(k) ? 1 : 0.8));
  };
  /** The bass under a bar, up to beat `to`: its style's line on the chord's root. */
  const bassLine = (bar: Bar, d: number, gain: number, to = 4) => {
    const low = degree(d);
    if (style === 'electro')
      for (let k = 0.5; k < to; k++) bar.hit(bass(low, bar.period / 2), k, gain);
    else if (style === 'synthwave' || style === 'chip')
      for (let k = 0; k < to * 2; k++)
        bar.hit(bass(low + (k % 2 ? 12 : 0), bar.period * 0.45), k / 2, gain * 0.85);
    // Short notes with air between them: a bass that never lets go reads as one held note.
    else for (let k = 0; k < to * 2; k++) bar.hit(bass(low, bar.period * 0.38), k / 2, gain);
  };
  /** A snare run into the bar line from beat `from`: eighths, then sixteenths. */
  const fill = (bar: Bar, from: number) => {
    for (let k = from; k < 4 - 1e-6; k += k < 3 ? 0.5 : 0.25)
      bar.hit(kit.snare, k, 0.6 + 0.1 * (k - from));
  };
  /**
   * The lead's bar of an eight-bar phrase over chord `d`: two rhythms taking turns, pitches
   * a seeded walk from a chord tone, the third bar the first again, the eighth one held
   * note. The same in every phrase of the part, so the song repeats itself.
   */
  const leadBar = (
    bar: Bar,
    which: string,
    rhythms: Rhythm[],
    d: number,
    gain: number,
    octave: number,
  ) => {
    const index = bar.index % 8;
    const walk = new Random(hashOf(song.seed, which, index === 2 ? 0 : index));
    let n = d + [0, 2, 4][walk.int(0, 2)]! + 7 * octave;
    if (index === 7) {
      bar.hit(melody(degree(n), 3.6 * bar.period), 0, gain);
      return;
    }
    for (const [beat, beats] of rhythms[index % 2]!) {
      bar.hit(melody(degree(n), beats * bar.period * 0.92), beat, gain);
      n += [-2, -1, -1, 1, 1, 2][walk.int(0, 5)]!;
      n = Math.max(7 * octave - 2, Math.min(7 * octave + 9, n));
    }
  };

  const quick = style === 'dnb' || style === 'electro';
  const leadOctave = style === 'rock' ? 3 : 4;

  const verse = (bar: Bar) => {
    const d = verseChords[bar.index % 4]!;
    const last = bar.index === bar.of - 1 || bar.index % 8 === 7;
    if (bar.index === 0) bar.hit(cymbal, 0, 0.55);
    for (const k of verseKick) if (!last || k < 3) bar.hit(kit.kick, k, k === 0 ? 0.95 : 0.8);
    for (const k of [1, 3]) if (!last || k < 3) bar.hit(kit.snare, k, 0.7);
    if (last) fill(bar, 3);
    hats(bar, 0.5, 0.22, 0, last ? 3 : 4);
    bassLine(bar, d, 0.3);
    if (style === 'rock') for (let k = 0; k < 8; k++) bar.hit(hit(d, bar.period / 2), k / 2, 0.11);
    else if (style === 'electro')
      for (const k of [0, 2.5]) bar.hit(hit(d, bar.period * 0.4), k, 0.14);
    else arpeggio(bar, d, style === 'chip' ? 0.07 : 0.09);
    // The second half of a verse brings the lead in, quietly.
    if (bar.index >= bar.of / 2) leadBar(bar, 'verse', verseRhythms, d, 0.16, leadOctave);
  };

  const chorus = (bar: Bar, stopHere: boolean) => {
    const d = chorusChords[bar.index % 4]!;
    if (stopHere && bar.index === 6) {
      // The band hits the downbeat together, stops, and comes back in on beat 4.
      bar.hit(kit.kick, 0, 1);
      bar.hit(kit.snare, 0, 0.6);
      bar.hit(cymbal, 0, 0.5);
      bar.hit(hit(d, bar.period * 0.4), 0, 0.2);
      bar.hit(kit.kick, 3, 1);
      bar.hit(kit.snare, 3, 0.6);
      bar.hit(kit.hat, 3.5, 0.3);
      bar.hit(held(d, bar.period), 3, 0.2);
      return;
    }
    const last = bar.index === bar.of - 1 || bar.index % 8 === 7;
    if (bar.index % 4 === 0) bar.hit(cymbal, 0, bar.index % 8 === 0 ? 0.85 : 0.6);
    for (const k of chorusKick) if (!last || k < 2) bar.hit(kit.kick, k, k === 0 ? 1 : 0.85);
    const snares = pushed && bar.index % 2 ? [1, 3, 3.5] : [1, 3];
    for (const k of snares) if (!last || k < 2) bar.hit(kit.snare, k, 0.75);
    if (last) fill(bar, 2);
    hats(bar, quick ? 0.25 : 0.5, quick ? 0.24 : 0.32, 0, last ? 2 : 4);
    bassLine(bar, d, 0.38, last ? 2 : 4);
    // Rock strums the chord in eighths; the synths hold it under the drums.
    if (style === 'rock')
      for (let k = 0; k < (last ? 4 : 8); k++)
        bar.hit(held(d, bar.period * 0.36), k / 2, k % 2 ? 0.13 : 0.17);
    if (style === 'synthwave' || style === 'dnb') bar.hit(held(d, 4 * bar.period), 0, 0.4);
    if (style === 'electro')
      for (const k of [0, 1.5, 3]) bar.hit(hit(d, bar.period * 0.45), k, 0.24);
    if (style === 'chip' || style === 'synthwave') arpeggio(bar, d, 0.08, true);
    leadBar(bar, 'chorus', chorusRhythms, d, 0.3, leadOctave);
  };

  /** The build before a chorus: kicks on every beat, a snare roll speeding up, a riser. */
  const pre = (bar: Bar) => {
    const d = verseChords[bar.index % 4]!;
    const gain = 0.6 + (0.4 * (bar.index + 1)) / bar.of;
    const last = bar.index === bar.of - 1;
    if (bar.index === 0 && style !== 'rock')
      bar.hit(
        cached(`riser${bar.of}:${len(bar.period)}`, () => riser(bar.of * 4 * bar.period, rate)),
        0,
        0.8,
      );
    const left = bar.of - 1 - bar.index;
    const step = left >= 2 ? 2 : left === 1 ? 0.5 : 0.25;
    // The roll, and a breath before the chorus: the build's last beat is silent.
    for (let k = left >= 2 ? 1 : 0; k < (last ? 3 : 4) - 1e-6; k += step)
      bar.hit(kit.snare, k, (0.38 + 0.04 * k) * gain);
    for (let k = 0; k < (last ? 3 : 4); k++) bar.hit(kit.kick, k, 0.78 * gain);
    hats(bar, 0.5, 0.22 * gain, 0, last ? 3 : 4);
    for (const k of [0, 2])
      if (!last || k === 0) {
        bar.hit(held(d, 2 * bar.period), k, (style === 'rock' ? 0.15 : 0.4) * gain);
        bar.hit(bass(degree(d), 1.9 * bar.period), k, 0.3 * gain);
      }
  };

  /** Half time: a kick, a snare on 3, the chord ringing, the lead in long notes. */
  const breakdown = (bar: Bar) => {
    const d = verseChords[bar.index % 4]!;
    if (bar.index % 4 === 0) bar.hit(cymbal, 0, 0.6);
    bar.hit(kit.kick, 0, 1);
    if (bar.index % 2) bar.hit(kit.kick, 0.5, 0.7);
    bar.hit(kit.snare, 2, 0.7);
    hats(bar, 1, 0.22);
    bar.hit(held(d, 4 * bar.period), 0, style === 'rock' ? 0.24 : 0.55);
    bar.hit(bass(degree(d), 3.9 * bar.period), 0, 0.4);
    if (bar.index % 2 === 0)
      bar.hit(melody(degree(d + 4 + 7 * leadOctave), 7.6 * bar.period), 0, 0.2);
  };

  /** Quiet: the chords picked out, a kick on the one, hats off the beat. */
  const bridge = (bar: Bar) => {
    const d = chorusChords[bar.index % 4]!;
    arpeggio(bar, d, 0.11);
    bar.hit(kit.kick, 0, 0.4);
    bar.hit(kit.snare, 2, 0.16);
    for (let k = 0; k < 4; k++) bar.hit(kit.hat, k + 0.5, 0.1);
    if (style !== 'rock') bar.hit(held(d, 4 * bar.period), 0, 0.3);
    bar.hit(bass(degree(d), 3.9 * bar.period), 0, 0.22);
  };

  const intro = (bar: Bar) => {
    const d = verseChords[bar.index % 4]!;
    const half = bar.index >= bar.of / 2;
    if (style === 'electro') {
      for (let k = 0; k < 4; k++) bar.hit(kit.kick, k, 0.6);
      if (half) hats(bar, 1, 0.2, 0.5, 4);
      if (half) for (const k of [0, 2.5]) bar.hit(hit(d, bar.period * 0.4), k, 0.1);
      return;
    }
    arpeggio(bar, d, 0.11);
    hats(bar, 1, 0.12);
    if (half) {
      bar.hit(kit.kick, 0, 0.55);
      bar.hit(kit.kick, 2, 0.45);
      bar.hit(bass(degree(d), 3.9 * bar.period), 0, 0.22);
    }
    if (bar.index === bar.of - 1) fill(bar, 3);
  };

  /** A fading groove, then one last hit ringing out. */
  const outro = (bar: Bar) => {
    const d = verseChords[bar.index % 4]!;
    if (bar.index === bar.of - 1) {
      bar.hit(cymbal, 0, 0.9);
      bar.hit(kit.kick, 0, 1);
      bar.hit(held(verseChords[0]!, 6 * bar.period), 0, style === 'rock' ? 0.22 : 0.5);
      bar.hit(bass(degree(verseChords[0]!), 5 * bar.period), 0, 0.35);
      return;
    }
    const gain = 1 - (0.7 * bar.index) / bar.of;
    for (const k of verseKick) bar.hit(kit.kick, k, 0.75 * gain);
    for (const k of [1, 3]) bar.hit(kit.snare, k, 0.45 * gain);
    hats(bar, 0.5, 0.2 * gain);
    bassLine(bar, d, 0.28 * gain);
    arpeggio(bar, d, 0.08 * gain);
  };

  let choruses = 0;
  const parts: Part[] = song.form.map(([kind, bars, bpm]) => {
    const stopHere = kind === 'chorus' && stops && ++choruses >= 2 && bars >= 8;
    const play =
      kind === 'chorus'
        ? (bar: Bar) => chorus(bar, stopHere)
        : { intro, verse, pre, break: breakdown, bridge, outro }[kind];
    return { name: kind, bpm: bpm ?? song.bpm, bars, play };
  });
  return render(parts, 1, rate);
}
