import type { PitchCurve } from '../types';
import type { Frames } from './spectrum';
import { percentile } from './stats';

/**
 * The melody's pitch over time, from each frame's strongest partial in the melody range
 * (`spectrum.ts`). Cheap by design: no pitch tracker, just the loudest peak where one
 * clearly stands out, so a lead or a voice over a band reads as its notes (or, where a
 * harmonic outsings it, an octave up: the contour is what counts, not the note name).
 */

/** Curves are sampled this many times per second, like the energy curves. */
export const MELODY_RATE = 50;
/** A frame whose peak holds less of the range's power than this is noise, a chord wash or drums. */
const MIN_SHARE = 0.15;
/** A frame this many dB below the range's loud frames has no melody to hear. */
const QUIET_DB = 30;
/** Frames either side the median looks at (about 35 ms each way). */
const MEDIAN_REACH = 3;
/** Of the frames around one, this many must have a melody for it to keep its own. */
const MIN_VOICED_AROUND = 4;

/**
 * The melody's pitch at `MELODY_RATE`, in MIDI note numbers with fractions, 0 where there
 * is none: frames too quiet or with no partial clearly above the rest are left out, and
 * the rest are smoothed by a median over about 70 ms, which also drops single-frame
 * jumps (a snare's crack, an octave slip).
 */
export function melodyCurve(frames: Frames, duration: number): PitchCurve {
  const { pitch, pitchShare, melodyPower, count } = frames;
  const db = melodyPower.map((p) => 10 * Math.log10(p + 1e-12));
  const loud = percentile(db, 0.99);
  const voiced = new Uint8Array(count);
  for (let i = 0; i < count; i++)
    voiced[i] = pitch[i]! > 0 && pitchShare[i]! >= MIN_SHARE && db[i]! >= loud - QUIET_DB ? 1 : 0;

  const smooth = new Float32Array(count);
  const around: number[] = [];
  for (let i = 0; i < count; i++) {
    if (!voiced[i]) continue;
    around.length = 0;
    for (let k = Math.max(0, i - MEDIAN_REACH); k <= Math.min(count - 1, i + MEDIAN_REACH); k++)
      if (voiced[k]) around.push(pitch[k]!);
    if (around.length < MIN_VOICED_AROUND) continue;
    around.sort((a, b) => a - b);
    smooth[i] = around[Math.floor(around.length / 2)]!;
  }

  const samples = Math.max(1, Math.ceil(duration * MELODY_RATE));
  const values = new Float32Array(samples);
  for (let j = 0; j < samples; j++) {
    const i = Math.min(count - 1, Math.round((j / MELODY_RATE) * frames.rate));
    values[j] = smooth[i]!;
  }
  return { step: 1 / MELODY_RATE, values };
}

/** No melody at all, for analyses made before it was found and hand-made ones in tests. */
export function noMelody(duration: number): PitchCurve {
  return {
    step: 1 / MELODY_RATE,
    values: new Float32Array(Math.max(1, Math.ceil(duration * MELODY_RATE))),
  };
}
