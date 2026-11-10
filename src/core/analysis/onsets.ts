import type { Onset } from '../types';
import { clamp01, movingAverage, percentile } from './stats';

/**
 * How far the flux peak trails the hit, in frames. Negative: with log compression the
 * flux peaks as soon as the hit enters the window, about half a frame before its centre.
 * Measured with the synthetic drums in the tests.
 */
export const ONSET_LAG_FRAMES = -0.5;

/** Seconds around a frame that its threshold averages over. */
const THRESHOLD_SECONDS = 0.1;
/** A peak must be the highest within this many seconds either side. */
const PEAK_SECONDS = 0.035;
/** Below this mean flux per bin, a band is silent: nothing in it counts as a hit. */
const SILENCE = 0.05;
/** How far above its neighbourhood a peak must rise, as a share of the band's loud flux. */
const DELTA = 0.12;

/** The song time of a frame's flux peak. */
export function frameTime(frame: number, rate: number): number {
  return Math.max(0, (frame - ONSET_LAG_FRAMES) / rate);
}

/**
 * Pick the hits in one band's flux: local maxima well above their neighbourhood. Strength
 * compares each hit with the band's loud hits, so a quiet passage reads as weaker hits.
 */
export function pickOnsets(flux: Float32Array, rate: number): Onset[] {
  const average = movingAverage(flux, Math.max(1, Math.round(THRESHOLD_SECONDS * rate)));
  const radius = Math.max(1, Math.round(PEAK_SECONDS * rate));
  const loud = percentile(flux, 0.99);
  const delta = DELTA * loud;
  const peaks: { frame: number; value: number }[] = [];

  for (let i = 1; i < flux.length; i++) {
    const value = flux[i]!;
    if (value < SILENCE || value < average[i]! + delta) continue;
    let highest = true;
    for (let j = Math.max(0, i - radius); j <= Math.min(flux.length - 1, i + radius); j++) {
      // Ties go to the earliest frame.
      if (flux[j]! > value || (j < i && flux[j] === value)) {
        highest = false;
        break;
      }
    }
    if (highest) peaks.push({ frame: i, value });
  }

  const reference = percentile(
    peaks.map((p) => p.value),
    0.95,
  );
  return peaks.map(({ frame, value }) => ({
    time: frameTime(refinePeak(flux, frame), rate),
    strength: reference > 0 ? clamp01(value / reference) : 0,
  }));
}

/** Sub-frame position of a peak, from a parabola through it and its neighbours. */
export function refinePeak(values: ArrayLike<number>, i: number): number {
  const a = values[i - 1];
  const b = values[i];
  const c = values[i + 1];
  if (a === undefined || b === undefined || c === undefined) return i;
  const denominator = a - 2 * b + c;
  if (denominator >= 0) return i;
  const offset = (0.5 * (a - c)) / denominator;
  return i + Math.max(-0.5, Math.min(0.5, offset));
}
