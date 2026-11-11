/**
 * Whole songs for playtesting the games and checking the analysis end to end, built
 * from the synthetic sounds in `test-audio.ts`, so they are the same on every run:
 *
 * - `rockSong`: a fast rock song in the spirit of the reference song the platformer is
 *   tuned on: about 2:20 at 170 BPM with a half-time breakdown, a quiet bridge at
 *   150 BPM, a build and a last chorus at 180 BPM, a full-band stop and loud choruses.
 * - `electroSong`: a steady 128 BPM electronic track, 2:30 of intro, builds, drops and a
 *   breakdown.
 * - `melodySong`: a short 120 BPM groove with a lead that climbs, holds and falls, for
 *   the melody contour.
 *
 * Each returns the samples, the true beats and where each part starts, and `wavFile`
 * turns samples into a WAV the browser can play (`npm run dev`, then
 * `await import('/src/core/analysis/test-songs.ts')` in the console).
 */
import { biquad, chord, crash, drumKit, noise, place, track, TEST_RATE } from './test-audio';

/** A part of a song: how many bars at what tempo, and how each of its bars is played. */
export interface Part {
  name: string;
  bpm: number;
  bars: number;
  play: (bar: Bar) => void;
}

/** What a part's bar player gets: where the bar is, and helpers to put sounds in it. */
export interface Bar {
  /** The bar's number within its part, and how many bars the part has. */
  index: number;
  of: number;
  period: number;
  /** Song time of a beat (fractions too) in this bar. */
  at(beat: number): number;
  hit(sample: Float32Array, beat: number, gain: number): void;
}

export interface SongParts {
  name: string;
  start: number;
  end: number;
  bpm: number;
}

export interface TestSong {
  samples: Float32Array;
  rate: number;
  beats: number[];
  parts: SongParts[];
}

export function render(parts: Part[], tail: number, rate: number, start = 0.5): TestSong {
  let length = start + tail;
  for (const p of parts) length += (p.bars * 4 * 60) / p.bpm;
  const out = track(length, rate);
  const beats: number[] = [];
  const spans: SongParts[] = [];
  let t = start;
  for (const part of parts) {
    const period = 60 / part.bpm;
    const from = t;
    for (let index = 0; index < part.bars; index++) {
      const t0 = t;
      const bar: Bar = {
        index,
        of: part.bars,
        period,
        at: (beat) => t0 + beat * period,
        hit: (sample, beat, gain) => place(out, sample, t0 + beat * period, gain, rate),
      };
      part.play(bar);
      for (let k = 0; k < 4; k++) beats.push(t0 + k * period);
      t += 4 * period;
    }
    spans.push({ name: part.name, start: from, end: t, bpm: part.bpm });
  }
  // Keep the loudest sample under full scale.
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.95) for (let i = 0; i < out.length; i++) out[i] = (out[i]! / peak) * 0.95;
  return { samples: out, rate, beats, parts: spans };
}

/** A sound of `seconds`, filled sample by sample, with a 3 ms attack and a 20 ms release. */
export function tone(seconds: number, rate: number, fill: (t: number) => number): Float32Array {
  const out = new Float32Array(Math.max(1, Math.round(seconds * rate)));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    out[i] = fill(t) * Math.max(0, Math.min(1, t / 0.003, (seconds - t) / 0.02));
  }
  return out;
}

/** A distorted power chord (root, fifth, octave), palm-muted when `muted`. */
export function powerChord(
  root: number,
  seconds: number,
  rate: number,
  muted = false,
): Float32Array {
  const w = 2 * Math.PI * root;
  return tone(seconds, rate, (t) => {
    const x = Math.sin(w * t) + Math.sin(1.5 * w * t) + 0.6 * Math.sin(2 * w * t);
    const decay = muted ? Math.exp(-t / 0.07) : Math.exp(-t / 2.5);
    return Math.tanh(2.5 * x) * 0.6 * decay;
  });
}

/** A bass note: a sine with two soft harmonics. */
export function bassNote(freq: number, seconds: number, rate: number): Float32Array {
  const w = 2 * Math.PI * freq;
  return tone(
    seconds,
    rate,
    (t) => (Math.sin(w * t) + 0.35 * Math.sin(2 * w * t) + 0.12 * Math.sin(3 * w * t)) * 0.7,
  );
}

/** A plucked clean note, ringing out. */
export function pluck(freq: number, seconds: number, rate: number): Float32Array {
  const w = 2 * Math.PI * freq;
  return tone(
    seconds,
    rate,
    (t) => (Math.sin(w * t) + 0.4 * Math.sin(2 * w * t)) * Math.exp(-t / 0.6) * 0.6,
  );
}

/** A synth stab: a few detuned saws (as sines with harmonics), short. */
export function stab(freqs: number[], seconds: number, rate: number): Float32Array {
  return tone(seconds, rate, (t) => {
    let v = 0;
    for (const f of freqs)
      for (const detune of [0.995, 1, 1.005])
        for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * detune * h * t) / h;
    return (v / (freqs.length * 4)) * Math.exp(-t / 0.18);
  });
}

/** Noise swelling up over `seconds`, its band rising: the riser before a drop. */
export function riser(seconds: number, rate: number): Float32Array {
  const n = Math.round(seconds * rate);
  const out = noise(29, n);
  biquad(out, 'highpass', 3000, 0.7, rate);
  for (let i = 0; i < n; i++) out[i] = out[i]! * (i / n) ** 2 * 0.5;
  return out;
}

/** E minor rock: E5, C5, G5, D5 a bar each. Guitar roots, and the bass an octave down. */
const ROCK_ROOTS = [82.41, 65.41, 98, 73.42];
/** The same chords as clean triads, for the intro and the bridge. */
const ROCK_TRIADS = [
  [164.81, 196, 246.94],
  [130.81, 164.81, 196],
  [196, 246.94, 293.66],
  [146.83, 185, 220],
];

/**
 * The rock stand-in: intro (8 bars), verse (16), pre-chorus (4), chorus (12), verse (8),
 * pre-chorus (4), chorus (8, with a full-band stop in its 7th bar), a half-time
 * breakdown (8) all at 170 BPM; a quiet bridge (8) and a build (4) at 150 BPM; a last
 * chorus (16) and an outro (4) at 180 BPM, the last chord ringing out.
 */
export function rockSong(rate = TEST_RATE): TestSong {
  const kit = drumKit(rate);
  const cymbal = crash(rate);
  const chords = new Map<string, Float32Array>();
  const cached = (key: string, make: () => Float32Array) => {
    if (!chords.has(key)) chords.set(key, make());
    return chords.get(key)!;
  };
  const chug = (root: number, period: number) =>
    cached(`chug${root}${period}`, () => powerChord(root, period / 2, rate, true));
  const ring = (root: number, seconds: number) =>
    cached(`ring${root}${seconds}`, () => powerChord(root, seconds, rate));
  const bass = (root: number, seconds: number) =>
    cached(`bass${root}${seconds}`, () => bassNote(root / 2, seconds, rate));
  const note = (f: number, seconds: number) =>
    cached(`pluck${f}${seconds}`, () => pluck(f, seconds, rate));

  const arpeggio = (bar: Bar, gain: number) => {
    const triad = ROCK_TRIADS[bar.index % 4]!;
    for (let k = 0; k < 8; k++) bar.hit(note(triad[k % 3]!, bar.period * 2), k / 2, gain);
  };
  const verse = (bar: Bar, gain = 1) => {
    const root = ROCK_ROOTS[bar.index % 4]!;
    for (const k of [0, 1.5, 2]) bar.hit(kit.kick, k, (k === 0 ? 0.9 : 0.65) * gain);
    for (const k of [1, 3]) bar.hit(kit.snare, k, 0.5 * gain);
    for (let k = 0; k < 8; k++) {
      bar.hit(kit.hat, k / 2, 0.22 * gain);
      bar.hit(chug(root, bar.period), k / 2, 0.11 * gain);
      bar.hit(bass(root, bar.period / 2), k / 2, 0.3 * gain);
    }
  };
  const chorus = (bar: Bar) => {
    const root = ROCK_ROOTS[bar.index % 4]!;
    if (bar.index % 4 === 0) bar.hit(cymbal, 0, 0.8);
    for (const k of [0, 2, 2.5]) bar.hit(kit.kick, k, k === 0 ? 1 : 0.7);
    // A snare pushed onto the "and" of 4 every other bar: a syncopation.
    for (const k of bar.index % 2 ? [1, 3, 3.5] : [1, 3]) bar.hit(kit.snare, k, 0.6);
    for (let k = 0; k < 8; k++) {
      bar.hit(kit.hat, k / 2, 0.32);
      bar.hit(bass(root, bar.period / 2), k / 2, 0.38);
    }
    bar.hit(ring(root, 4 * bar.period), 0, 0.2);
  };
  const pre = (bar: Bar) => {
    const gain = 0.7 + (0.3 * (bar.index + 1)) / bar.of;
    const root = ROCK_ROOTS[bar.index % 4]!;
    for (let k = 0; k < 4; k++) bar.hit(kit.kick, k, 0.75 * gain);
    const last = bar.index === bar.of - 1;
    if (last) {
      // Snare eighths, then a sixteenth fill into the chorus.
      for (let k = 0; k < 3; k += 0.5) bar.hit(kit.snare, k, (0.4 + 0.05 * k) * gain);
      for (let k = 0; k < 4; k++) bar.hit(kit.snare, 3 + k / 4, 0.55 + 0.05 * k);
    } else for (const k of [1, 3]) bar.hit(kit.snare, k, 0.5 * gain);
    for (let k = 0; k < 8; k++) bar.hit(kit.hat, k / 2, 0.25 * gain);
    for (const k of [0, 2]) bar.hit(ring(root, 2 * bar.period), k, 0.15 * gain);
    for (const k of [0, 2]) bar.hit(bass(root, 2 * bar.period), k, 0.32 * gain);
  };

  const parts: Part[] = [
    {
      name: 'Intro',
      bpm: 170,
      bars: 8,
      play: (bar) => {
        arpeggio(bar, 0.12);
        for (let k = 0; k < 4; k++) bar.hit(kit.hat, k, 0.12);
        if (bar.index >= 4) bar.hit(kit.kick, 0, 0.5);
      },
    },
    { name: 'Verse', bpm: 170, bars: 16, play: (bar) => verse(bar) },
    { name: 'Pre-chorus', bpm: 170, bars: 4, play: pre },
    { name: 'Chorus', bpm: 170, bars: 12, play: chorus },
    { name: 'Verse', bpm: 170, bars: 8, play: (bar) => verse(bar) },
    { name: 'Pre-chorus', bpm: 170, bars: 4, play: pre },
    {
      name: 'Chorus',
      bpm: 170,
      bars: 8,
      play: (bar) => {
        if (bar.index !== 6) return chorus(bar);
        // The band hits the downbeat together, stops, and comes back in on beat 4.
        const root = ROCK_ROOTS[bar.index % 4]!;
        bar.hit(kit.kick, 0, 1);
        bar.hit(kit.snare, 0, 0.6);
        bar.hit(cymbal, 0, 0.5);
        bar.hit(powerChord(root, bar.period * 0.4, rate), 0, 0.2);
        bar.hit(kit.kick, 3, 1);
        bar.hit(kit.snare, 3, 0.6);
        bar.hit(kit.hat, 3.5, 0.3);
        bar.hit(ring(root, bar.period), 3, 0.2);
      },
    },
    {
      name: 'Half-time breakdown',
      bpm: 170,
      bars: 8,
      play: (bar) => {
        const root = ROCK_ROOTS[bar.index % 4]!;
        if (bar.index % 2 === 0) bar.hit(cymbal, 0, 0.7);
        bar.hit(kit.kick, 0, 1);
        bar.hit(kit.kick, 0.5, 0.7);
        bar.hit(kit.snare, 2, 0.7);
        for (let k = 0; k < 4; k++) bar.hit(kit.hat, k, 0.25);
        bar.hit(ring(root, 4 * bar.period), 0, 0.24);
        bar.hit(bass(root, 4 * bar.period), 0, 0.42);
      },
    },
    {
      name: 'Bridge',
      bpm: 150,
      bars: 8,
      play: (bar) => {
        arpeggio(bar, 0.1);
        bar.hit(kit.kick, 0, 0.35);
        bar.hit(kit.snare, 2, 0.15);
        for (let k = 0; k < 4; k++) bar.hit(kit.hat, k + 0.5, 0.1);
      },
    },
    {
      name: 'Build',
      bpm: 150,
      bars: 4,
      play: (bar) => {
        const gain = 0.55 + (0.45 * (bar.index + 1)) / bar.of;
        const root = ROCK_ROOTS[bar.index % 4]!;
        for (let k = 0; k < 4; k++) bar.hit(kit.kick, k, 0.75 * gain);
        const step = bar.index < 2 ? 1 : bar.index === 2 ? 0.5 : 0.25;
        for (let k = bar.index < 2 ? 1 : 0; k < 4; k += bar.index < 2 ? 2 : step)
          bar.hit(kit.snare, k, (0.4 + 0.04 * k) * gain);
        for (let k = 0; k < 8; k++) bar.hit(kit.hat, k / 2, 0.22 * gain);
        bar.hit(ring(root, 4 * bar.period), 0, 0.15 * gain);
        bar.hit(bass(root, 4 * bar.period), 0, 0.3 * gain);
      },
    },
    { name: 'Last chorus', bpm: 180, bars: 16, play: chorus },
    {
      name: 'Outro',
      bpm: 180,
      bars: 4,
      play: (bar) => {
        if (bar.index > 0) return;
        // One last hit, ringing out over the outro.
        bar.hit(cymbal, 0, 0.9);
        bar.hit(kit.kick, 0, 1);
        bar.hit(ring(ROCK_ROOTS[0]!, 14 * bar.period), 0, 0.22);
        bar.hit(bassNote(ROCK_ROOTS[0]! / 2, 12 * bar.period, rate), 0, 0.35);
      },
    },
  ];
  return render(parts, 1, rate);
}

/** A minor progression for the electronic track: Am, F, C, G. */
const ELECTRO_CHORDS = [
  [220, 261.63, 329.63],
  [174.61, 220, 261.63],
  [261.63, 329.63, 392],
  [196, 246.94, 293.66],
];

/**
 * The electronic track at a steady 128 BPM: intro (16 bars, hats from the 9th), build (8,
 * a snare roll speeding up under a riser), drop (16), breakdown (8, pads only), build
 * (8), drop (16), outro (8, fading).
 */
export function electroSong(rate = TEST_RATE): TestSong {
  const kit = drumKit(rate);
  const cymbal = crash(rate);
  const bpm = 128;
  const period = 60 / bpm;
  const stabs = ELECTRO_CHORDS.map((c) => stab(c, period * 0.45, rate));
  const pads = ELECTRO_CHORDS.map((c) => chord(c, 4 * period, 0.06, rate));
  const sub = ELECTRO_CHORDS.map((c) => bassNote(c[0]! / 4, period / 2, rate));
  const rise = riser(8 * 4 * period, rate);

  const fourOnTheFloor = (bar: Bar, gain: number) => {
    for (let k = 0; k < 4; k++) bar.hit(kit.kick, k, (k === 0 ? 0.95 : 0.8) * gain);
  };
  const build = (bar: Bar) => {
    if (bar.index === 0) bar.hit(rise, 0, 1);
    const gain = 0.6 + (0.4 * (bar.index + 1)) / bar.of;
    const last = bar.index === bar.of - 1;
    // The roll: quarters, then eighths, then sixteenths; the build's last beat is silent.
    const step = bar.index < 4 ? 1 : bar.index < 6 ? 0.5 : 0.25;
    for (let k = 0; k < (last ? 3 : 4); k += step) bar.hit(kit.snare, k, (0.35 + 0.03 * k) * gain);
    if (!last) fourOnTheFloor(bar, 0.8 * gain);
    else for (let k = 0; k < 3; k++) bar.hit(kit.kick, k, 0.7);
    for (let k = 0; k < (last ? 3 : 4); k++) bar.hit(kit.hat, k + 0.5, 0.2 * gain);
  };
  const drop = (bar: Bar) => {
    const c = bar.index % 4;
    if (bar.index % 8 === 0) bar.hit(cymbal, 0, 0.8);
    fourOnTheFloor(bar, 1);
    for (const k of [1, 3]) bar.hit(kit.snare, k, 0.55);
    for (let k = 0; k < 4; k++) {
      bar.hit(kit.hat, k + 0.5, 0.35);
      bar.hit(sub[c]!, k + 0.5, 0.45);
    }
    for (const k of [0, 1.5, 3]) bar.hit(stabs[c]!, k, 0.25);
  };

  const parts: Part[] = [
    {
      name: 'Intro',
      bpm,
      bars: 16,
      play: (bar) => {
        fourOnTheFloor(bar, 0.6);
        if (bar.index >= 8) for (let k = 0; k < 4; k++) bar.hit(kit.hat, k + 0.5, 0.2);
      },
    },
    { name: 'Build', bpm, bars: 8, play: build },
    { name: 'Drop', bpm, bars: 16, play: drop },
    {
      name: 'Breakdown',
      bpm,
      bars: 8,
      play: (bar) => {
        bar.hit(pads[bar.index % 4]!, 0, 1);
        for (let k = 0; k < 4; k++) bar.hit(kit.hat, k + 0.5, 0.08);
      },
    },
    { name: 'Build', bpm, bars: 8, play: build },
    { name: 'Drop', bpm, bars: 16, play: drop },
    {
      name: 'Outro',
      bpm,
      bars: 8,
      play: (bar) => {
        const gain = 1 - bar.index / bar.of;
        fourOnTheFloor(bar, 0.7 * gain);
        for (let k = 0; k < 4; k++) bar.hit(kit.hat, k + 0.5, 0.2 * gain);
      },
    },
  ];
  return render(parts, 1, rate);
}

/** A synth lead: a saw-like tone (four harmonics, each weaker), held for `seconds`. */
export function lead(freq: number, seconds: number, rate: number): Float32Array {
  const w = 2 * Math.PI * freq;
  return tone(seconds, rate, (t) => {
    let v = 0;
    for (let h = 1; h <= 4; h++) v += Math.sin(h * w * t) / h;
    return v * 0.5;
  });
}

/** A note of the melody song: from `time` to `end`, as a MIDI note number. */
export interface MelodyNote {
  time: number;
  end: number;
  midi: number;
}

/** Steps of the A natural minor scale from A, in semitones. */
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

/** The A minor scale from A3 (MIDI 57), `n` notes up from it. */
const minorNote = (n: number) => 57 + 12 * Math.floor(n / 7) + MINOR_STEPS[n % 7]!;

/**
 * A 120 BPM song for the melody contour, over a groove of drums and a low bass (A1, under
 * the melody range): an intro with no lead (4 bars), a lead climbing the A minor scale a
 * quarter note at a time from A3 to B5 (4 bars), holding A5 (2 bars), falling back down to
 * A3 (4 bars, from B5), holding A3 (2 bars), and an outro with no lead (2 bars). `notes` are the
 * lead's notes.
 */
export function melodySong(rate = TEST_RATE): TestSong & { notes: MelodyNote[] } {
  const kit = drumKit(rate);
  const bpm = 120;
  const period = 60 / bpm;
  const bass = bassNote(55, period * 0.9, rate);
  const notes: MelodyNote[] = [];
  const voices = new Map<string, Float32Array>();
  const play = (bar: Bar, midi: number, beat: number, beats: number) => {
    const key = `${midi}:${beats}`;
    if (!voices.has(key))
      voices.set(key, lead(440 * 2 ** ((midi - 69) / 12), beats * period * 0.95, rate));
    bar.hit(voices.get(key)!, beat, 0.35);
    notes.push({ time: bar.at(beat), end: bar.at(beat + beats * 0.95), midi });
  };
  const groove = (bar: Bar) => {
    for (const k of [0, 2]) bar.hit(kit.kick, k, 0.8);
    for (const k of [1, 3]) bar.hit(kit.snare, k, 0.4);
    for (let k = 0; k < 8; k++) bar.hit(kit.hat, k / 2, 0.15);
    for (let k = 0; k < 4; k++) bar.hit(bass, k, 0.4);
  };

  const parts: Part[] = [
    { name: 'Intro', bpm, bars: 4, play: groove },
    {
      name: 'Climb',
      bpm,
      bars: 4,
      play: (bar) => {
        groove(bar);
        for (let k = 0; k < 4; k++) play(bar, minorNote(bar.index * 4 + k), k, 1);
      },
    },
    {
      name: 'High',
      bpm,
      bars: 2,
      play: (bar) => {
        groove(bar);
        play(bar, 81, 0, 4);
      },
    },
    {
      name: 'Fall',
      bpm,
      bars: 4,
      play: (bar) => {
        groove(bar);
        for (let k = 0; k < 4; k++) play(bar, minorNote(15 - bar.index * 4 - k), k, 1);
      },
    },
    {
      name: 'Low',
      bpm,
      bars: 2,
      play: (bar) => {
        groove(bar);
        play(bar, 57, 0, 4);
      },
    },
    { name: 'Outro', bpm, bars: 2, play: groove },
  ];
  return { ...render(parts, 1, rate), notes };
}

/** The samples as the bytes of a 16-bit mono WAV file. */
export function wavBytes(samples: Float32Array, rate: number): ArrayBuffer {
  const bytes = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  bytes.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  bytes.setUint32(16, 16, true);
  bytes.setUint16(20, 1, true);
  bytes.setUint16(22, 1, true);
  bytes.setUint32(24, rate, true);
  bytes.setUint32(28, rate * 2, true);
  bytes.setUint16(32, 2, true);
  bytes.setUint16(34, 16, true);
  text(36, 'data');
  bytes.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    bytes.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return bytes.buffer;
}

/** The samples as a 16-bit mono WAV file. */
export function wavFile(samples: Float32Array, rate: number, name: string): File {
  return new File([wavBytes(samples, rate)], name, { type: 'audio/wav' });
}
