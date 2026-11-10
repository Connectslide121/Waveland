/**
 * Synthetic drums for the analysis tests: clicks, kicks, snares and hats at known times,
 * so a test knows exactly what the analysis should find. Deterministic (seeded noise).
 */

export const TEST_RATE = 22050;

function noise(seed: number, length: number): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) / 2 ** 31 - 1;
  }
  return out;
}

/** An RBJ biquad, run over the samples in place. */
function biquad(
  x: Float32Array,
  kind: 'highpass' | 'bandpass',
  hz: number,
  q: number,
  rate: number,
) {
  const w = (2 * Math.PI * hz) / rate;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const [b0, b1, b2] =
    kind === 'highpass' ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2] : [alpha, 0, -alpha];
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

function normalise(x: Float32Array): Float32Array {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  return peak > 0 ? x.map((v) => v / peak) : x;
}

function sound(
  seconds: number,
  rate: number,
  fill: (t: number, i: number) => number,
): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = fill(i / rate, i);
  return out;
}

/** The drum sounds, rendered once per sample rate. */
export function drumKit(rate = TEST_RATE) {
  const attack = (t: number, seconds = 0.002) => Math.min(1, t / seconds);
  // Every sound fades out over its last 20 ms, so cutting it off adds no click of its own.
  const tail = (t: number, length: number) => Math.min(1, (length - t) / 0.02);
  // Kick: a sine falling from 110 Hz to 50 Hz, low enough to stay in the low band.
  let phase = 0;
  const kick = sound(0.25, rate, (t) => {
    phase += (2 * Math.PI * (50 + 60 * Math.exp(-t / 0.03))) / rate;
    return Math.sin(phase) * attack(t, 0.006) * Math.exp(-t / 0.08) * tail(t, 0.25);
  });
  // Snare and hat: shaped noise, filtered after shaping so the attack stays in their band.
  const shapedNoise = (seed: number, seconds: number, decay: number) =>
    noise(seed, Math.round(seconds * rate)).map(
      (v, i) => v * attack(i / rate) * Math.exp(-i / rate / decay) * tail(i / rate, seconds),
    );
  // Snare: noise around 2 kHz.
  const snare = shapedNoise(7, 0.2, 0.06);
  biquad(snare, 'bandpass', 2000, 1, rate);
  biquad(snare, 'bandpass', 2000, 1, rate);
  // Hat: noise above 8 kHz.
  const hat = shapedNoise(11, 0.08, 0.02);
  biquad(hat, 'highpass', 8000, 0.7, rate);
  biquad(hat, 'highpass', 8000, 0.7, rate);
  // Click: a 4 ms broadband tick.
  const click = normalise(
    noise(3, Math.round(0.004 * rate)).map((v, i, a) => v * (1 - i / a.length)),
  );
  return { kick, snare: normalise(snare), hat: normalise(hat), click };
}

/** An empty track of the given length. */
export function track(seconds: number, rate = TEST_RATE): Float32Array {
  return new Float32Array(Math.round(seconds * rate));
}

/** Mix a sound into the track at a time, scaled by `gain`. */
export function place(
  out: Float32Array,
  sample: Float32Array,
  time: number,
  gain = 1,
  rate = TEST_RATE,
) {
  const start = Math.round(time * rate);
  for (let i = 0; i < sample.length && start + i < out.length; i++) {
    if (start + i >= 0) out[start + i] = out[start + i]! + sample[i]! * gain;
  }
}

/** Beat times at a tempo from `start` until `end`. */
export function beatGrid(bpm: number, start: number, end: number): number[] {
  const times: number[] = [];
  for (let t = start; t < end - 1e-9; t += 60 / bpm) times.push(t);
  return times;
}

/** A click on every beat. */
export function clickTrack(bpm: number, seconds: number, start = 0.5, rate = TEST_RATE) {
  const { click } = drumKit(rate);
  const out = track(seconds, rate);
  const beats = beatGrid(bpm, start, seconds - 0.2);
  for (const t of beats) place(out, click, t, 0.8, rate);
  return { samples: out, beats };
}

export interface PatternOptions {
  bpm: number;
  seconds: number;
  /** When the first downbeat lands. */
  start?: number;
  /** Loudness over time, 0 to 1. */
  gain?: (time: number) => number;
  rate?: number;
}

/**
 * A four-on-the-floor groove: kick on every beat (accented on 1), snare on 2 and 4,
 * hats on the off-beat eighths.
 */
export function drumPattern({
  bpm,
  seconds,
  start = 0.5,
  gain = () => 1,
  rate = TEST_RATE,
}: PatternOptions) {
  const kit = drumKit(rate);
  const out = track(seconds, rate);
  const beats = beatGrid(bpm, start, seconds - 0.3);
  const half = 30 / bpm;
  const kicks: number[] = [];
  const snares: number[] = [];
  const hats: number[] = [];
  beats.forEach((t, i) => {
    const g = gain(t);
    place(out, kit.kick, t, (i % 4 === 0 ? 0.9 : 0.6) * g, rate);
    kicks.push(t);
    if (i % 2 === 1) {
      place(out, kit.snare, t, 0.5 * g, rate);
      snares.push(t);
    }
    if (t + half < seconds - 0.3) {
      place(out, kit.hat, t + half, 0.3 * g, rate);
      hats.push(t + half);
    }
  });
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  return { samples: out, beats, downbeats, kicks, snares, hats };
}

/**
 * How a part of a tempo-change song is played: `groove` is `drumPattern`'s (kick on every
 * beat, snare on 2 and 4, hats on the off-beats); `half` a half-time feel at the same
 * tempo (kick on 1, snare on 3, hats on every beat); `clicks` a click on every beat.
 */
export type Feel = 'groove' | 'half' | 'clicks';

export interface TempoPart {
  bpm: number;
  bars: number;
  feel?: Feel;
}

/**
 * A song whose tempo changes: the parts one after another, each starting on the beat the
 * one before would have had next. Returns the true beats and where each later part starts.
 */
export function tempoChangeSong(parts: TempoPart[], start = 0.5, rate = TEST_RATE) {
  const kit = drumKit(rate);
  let length = start + 1;
  for (const p of parts) length += (p.bars * 4 * 60) / p.bpm;
  const out = track(length, rate);
  const beats: number[] = [];
  const changes: number[] = [];
  let t = start;
  for (const [index, part] of parts.entries()) {
    if (index > 0) changes.push(t);
    const period = 60 / part.bpm;
    const feel = part.feel ?? 'groove';
    for (let i = 0; i < part.bars * 4; i++, t += period) {
      beats.push(t);
      const inBar = i % 4;
      if (feel === 'clicks') place(out, kit.click, t, 0.8, rate);
      else if (feel === 'groove') {
        place(out, kit.kick, t, inBar === 0 ? 0.9 : 0.6, rate);
        if (inBar % 2 === 1) place(out, kit.snare, t, 0.5, rate);
        place(out, kit.hat, t + period / 2, 0.3, rate);
      } else {
        if (inBar === 0) place(out, kit.kick, t, 0.9, rate);
        if (inBar === 2) place(out, kit.snare, t, 0.6, rate);
        place(out, kit.hat, t, 0.3, rate);
      }
    }
  }
  return { samples: out, beats, changes };
}
