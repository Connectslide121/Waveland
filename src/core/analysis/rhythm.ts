import { BANDS, type Band } from '../types';
import { frameTime, refinePeak } from './onsets';
import type { Frames } from './spectrum';
import { mean, movingAverage, percentile } from './stats';

/** The tempo range the tracker looks in. */
export const MIN_BPM = 60;
export const MAX_BPM = 200;
/** Tempo the tracker leans toward when two octaves fit equally well (beats, not bars or 16ths). */
const PREFERRED_BPM = 120;
/** Width of that lean, in octaves. */
const PREFERENCE_OCTAVES = 1;
/** Halve the period when half of it keeps this share of the pulse, up to this tempo. */
export const HALVING_SHARE = 0.5;
export const HALVING_MAX_BPM = 180;
/** How strongly the beat tracker sticks to the tempo (Ellis's "tightness"). */
const TIGHTNESS = 100;
/** How much each band counts toward the beat: kicks and snares more than hats. */
const BAND_WEIGHTS: Record<Band, number> = { low: 1, mid: 1, high: 0.5 };
/** Below this loud flux a band is silent and left out of the beat envelope. */
const SILENT_BAND = 0.05;

/** One envelope of "something hit here" for the beat tracker, from all bands. */
export function beatEnvelope(frames: Frames): Float32Array {
  const env = new Float32Array(frames.count);
  for (const band of BANDS) {
    const flux = frames.flux[band];
    const loud = percentile(flux, 0.99);
    if (loud < SILENT_BAND) continue;
    const weight = BAND_WEIGHTS[band] / loud;
    for (let i = 0; i < env.length; i++) env[i] = env[i]! + flux[i]! * weight;
  }
  // Light smoothing so hits that straddle two frames still line up with each other.
  return movingAverage(env, 1);
}

/** The envelope above its half-second average: the hits, without the swell of loudness. */
export function pulseOf(env: Float32Array, rate: number): Float32Array {
  const local = movingAverage(env, Math.round(rate * 0.5));
  const x = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) x[i] = Math.max(0, env[i]! - local[i]!);
  return x;
}

/** The lags (in frames) a beat period can have, from `MAX_BPM` down to `MIN_BPM`. */
export function lagRange(rate: number, length: number): { minLag: number; maxLag: number } {
  return {
    minLag: Math.floor((rate * 60) / MAX_BPM),
    maxLag: Math.min(length - 1, Math.ceil((rate * 60) / MIN_BPM)),
  };
}

/**
 * Autocorrelation of `x[from, to)` at every lag up to `maxLag + 1` (from `minLag - 1`), each
 * the mean product over the pairs it has.
 */
export function autocorrelation(
  x: Float32Array,
  from: number,
  to: number,
  minLag: number,
  maxLag: number,
): Float64Array {
  const ac = new Float64Array(maxLag + 2);
  const length = to - from;
  for (let lag = Math.max(1, minLag - 1); lag <= maxLag + 1 && lag < length; lag++) {
    let sum = 0;
    for (let i = from + lag; i < to; i++) sum += x[i]! * x[i - lag]!;
    ac[lag] = sum / (length - lag);
  }
  return ac;
}

/** How much the tracker leans toward a tempo: 1 at `PREFERRED_BPM`, less an octave away. */
export function tempoPreference(bpm: number): number {
  const octaves = Math.log2(bpm / PREFERRED_BPM) / PREFERENCE_OCTAVES;
  return Math.exp(-0.5 * octaves * octaves);
}

/** The beat period in frames (fractional), from the envelope's autocorrelation. */
export function estimatePeriod(env: Float32Array, rate: number): number {
  const x = pulseOf(env, rate);
  const { minLag, maxLag } = lagRange(rate, x.length);
  const ac = autocorrelation(x, 0, x.length, minLag, maxLag);

  let best = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const score = ac[lag]! * tempoPreference((rate * 60) / lag);
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  if (best < 0 || bestScore <= 0) return (rate * 60) / PREFERRED_BPM;
  // A backbeat repeats every two beats and can outscore the beat itself: when half the
  // period still carries a good share of the pulse, the beat is the faster one.
  let half = Math.floor(best / 2);
  if (ac[half + 1]! > ac[half]!) half++;
  if (half >= (rate * 60) / HALVING_MAX_BPM && ac[half]! >= HALVING_SHARE * ac[best]!) best = half;
  return refinePeak(ac, best);
}

/** The envelope over its own loudness (RMS), so the tracker's scores mean the same in any song. */
export function beatScores(env: Float32Array): Float32Array {
  const sd = Math.sqrt(mean(env.map((v) => v * v))) || 1;
  return env.map((v) => v / sd);
}

/**
 * Dynamic-programming beat tracker (Ellis 2007): beats sit on strong hits and keep close to
 * the period, so it holds the grid through quiet passages. `period` is in frames, one for
 * the whole song or one per frame (a tempo map: the interval ending at a frame keeps to
 * that frame's period, so beats join at a tempo change without a skipped or doubled
 * beat). Returns beat frames (fractional).
 */
export function trackBeats(env: Float32Array, period: number | Float64Array): number[] {
  const n = env.length;
  if (n === 0) return [];
  const score = beatScores(env);
  const total = new Float64Array(n);
  const from = new Int32Array(n).fill(-1);
  const steady = typeof period === 'number';
  const periodAt = (t: number) => (steady ? period : period[t]!);
  let p = periodAt(0);
  let near = Math.max(1, Math.round(p / 2));
  let far = Math.round(p * 2);

  for (let t = 0; t < n; t++) {
    if (!steady && period[t] !== p) {
      p = period[t]!;
      near = Math.max(1, Math.round(p / 2));
      far = Math.round(p * 2);
    }
    let best = -Infinity;
    let bestFrom = -1;
    for (let tau = Math.max(0, t - far); tau <= t - near; tau++) {
      const misfit = Math.log((t - tau) / p);
      const value = total[tau]! - TIGHTNESS * misfit * misfit;
      if (value > best) {
        best = value;
        bestFrom = tau;
      }
    }
    total[t] = score[t]! + (bestFrom >= 0 ? best : 0);
    from[t] = bestFrom;
  }

  // The last beat: the best total within the final period.
  let last = n - 1;
  for (let t = Math.max(0, n - Math.ceil(periodAt(n - 1))); t < n; t++)
    if (total[t]! > total[last]!) last = t;
  const frames: number[] = [];
  for (let t = last; t >= 0; t = from[t]!) frames.push(t);
  frames.reverse();

  // Leave out beats before the music starts and after it ends.
  const strength = (f: number) => Math.max(score[f - 1] ?? 0, score[f]!, score[f + 1] ?? 0);
  const rms = Math.sqrt(mean(frames.map((f) => strength(f) ** 2)));
  const threshold = 0.5 * rms;
  let first = 0;
  let end = frames.length;
  while (first < end && strength(frames[first]!) <= threshold) first++;
  while (end > first && strength(frames[end - 1]!) <= threshold) end--;

  // Nudge each beat onto its hit when there is one.
  return frames.slice(first, end).map((f) => {
    let peak = f;
    for (const g of [f - 1, f + 1]) if ((env[g] ?? -1) > env[peak]!) peak = g;
    return refinePeak(env, peak);
  });
}

/** Tempo in BPM from beat times: the slope of a straight line through them. */
export function tempoFromBeats(beats: number[], fallback: number): number {
  const n = beats.length;
  if (n < 4) return fallback;
  const meanIndex = (n - 1) / 2;
  const meanTime = mean(beats);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanIndex) * (beats[i]! - meanTime);
    den += (i - meanIndex) ** 2;
  }
  const secondsPerBeat = num / den;
  return secondsPerBeat > 0 ? 60 / secondsPerBeat : fallback;
}

/**
 * Which beats start a bar, assuming 4/4: the phase where kicks land on 1 (and 3), snares on
 * 2 and 4, and the loudness changes (new sections, crashes) fall on 1.
 */
export function findDownbeatPhase(beatFrames: number[], frames: Frames): number {
  if (beatFrames.length < 8) return 0;
  const at = (values: Float32Array, f: number) => {
    let peak = 0;
    for (let j = Math.round(f) - 2; j <= Math.round(f) + 2; j++)
      peak = Math.max(peak, values[j] ?? 0);
    return peak;
  };
  const normalise = (values: Float32Array) => {
    const loud = percentile(values, 0.99) || 1;
    return beatFrames.map((f) => at(values, f) / loud);
  };
  const kick = normalise(frames.flux.low);
  const snare = normalise(frames.flux.mid);
  const loudness = frames.power.all.map((p) => 10 * Math.log10(p + 1e-10));
  const lift = beatFrames.map((f, i) => {
    const prev = beatFrames[i - 1] ?? f - 1;
    const next = beatFrames[i + 1] ?? f + 1;
    const before = mean(loudness, Math.max(0, Math.round(prev)), Math.round(f));
    const after = mean(loudness, Math.round(f), Math.min(loudness.length, Math.round(next)));
    return Math.max(0, after - before) / 6;
  });

  let best = 0;
  let bestScore = -Infinity;
  for (let phase = 0; phase < 4; phase++) {
    let score = 0;
    beatFrames.forEach((_, i) => {
      const position = (((i - phase) % 4) + 4) % 4;
      if (position === 0) score += 1.5 * kick[i]! - snare[i]! + lift[i]!;
      else if (position === 2) score += kick[i]! - snare[i]!;
      else score += snare[i]! - 0.5 * kick[i]!;
    });
    if (score > bestScore) {
      bestScore = score;
      best = phase;
    }
  }
  return best;
}

export function beatTimes(beatFrames: number[], rate: number): number[] {
  return beatFrames.map((f) => frameTime(f, rate));
}
