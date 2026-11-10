import { BANDS, type Band } from '../types';
import { Fft, hann } from './fft';

/** Frequency ranges of the bands, in Hz: kick and bass, snare crack, hi-hats and cymbals. */
export const BAND_RANGES: Record<Band, readonly [number, number]> = {
  low: [30, 150],
  mid: [800, 5000],
  high: [6000, 16000],
};

/**
 * About 46 ms per frame (the power of two nearest it) and 11.6 ms between frames, whatever
 * the sample rate: at 22.05 and 44.1 kHz a quarter of the frame, at 48 kHz (the browser's
 * usual rate) 557 samples of a 2048-sample frame.
 */
const FRAME_SECONDS = 0.046;
const HOP_SECONDS = 256 / 22050;
/** Log compression of magnitudes before the flux, so quiet hits still count. */
const COMPRESSION = 1000;

/** Per-frame measurements of a song: the input to everything else. */
export interface Frames {
  /** Frames per second. */
  rate: number;
  count: number;
  /** Power per frame, per band and over the whole audible range. */
  power: Record<Band | 'all', Float32Array>;
  /** Spectral flux per frame and band: how much new energy arrived, per bin. */
  flux: Record<Band, Float32Array>;
  /**
   * Power per pitch class (C, C♯ … B) from 110 Hz to 2 kHz, 12 values a frame: frame `i`'s
   * are at `i * 12` to `i * 12 + 11`. For telling bars apart by their notes and chords.
   */
  chroma: Float32Array;
}

/** The range the chroma listens to, in Hz: bass notes up to the top of most melodies. */
const CHROMA_RANGE = [110, 2000] as const;

function nearestPowerOfTwo(n: number): number {
  return 2 ** Math.round(Math.log2(n));
}

/**
 * Short-time spectrum of mono samples. Frame `i` is centred on sample `i * hop`, so its
 * time is `i / rate`. Reports progress from 0 to 1 as it goes.
 */
export function computeFrames(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (done: number) => void,
): Frames {
  const size = nearestPowerOfTwo(sampleRate * FRAME_SECONDS);
  const hop = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
  const count = Math.max(1, Math.ceil(samples.length / hop));
  const fft = new Fft(size);
  const window = hann(size);
  const frame = new Float32Array(size);
  const bins = size / 2 + 1;
  const mags = new Float32Array(bins);
  let logPrev = new Float32Array(bins);
  let logCur = new Float32Array(bins);
  // A full-scale sine reads about 1 after the Hann window.
  const scale = 4 / size;

  const binOf = (hz: number) =>
    Math.min(bins - 1, Math.max(1, Math.round((hz * size) / sampleRate)));
  const ranges = Object.fromEntries(
    BANDS.map((band) => {
      const [lo, hi] = BAND_RANGES[band];
      return [band, [binOf(lo), Math.max(binOf(lo) + 1, binOf(hi))] as const];
    }),
  ) as Record<Band, readonly [number, number]>;
  const allRange = [binOf(20), binOf(16000)] as const;
  // Each chroma bin's pitch class, from its centre frequency.
  const chromaFrom = binOf(CHROMA_RANGE[0]);
  const chromaTo = binOf(CHROMA_RANGE[1]);
  const pitchClass = new Uint8Array(bins);
  for (let k = chromaFrom; k < chromaTo; k++) {
    const midi = Math.round(69 + 12 * Math.log2((k * sampleRate) / size / 440));
    pitchClass[k] = ((midi % 12) + 12) % 12;
  }
  const chroma = new Float32Array(count * 12);

  const power = {
    low: new Float32Array(count),
    mid: new Float32Array(count),
    high: new Float32Array(count),
    all: new Float32Array(count),
  };
  const flux = {
    low: new Float32Array(count),
    mid: new Float32Array(count),
    high: new Float32Array(count),
  };

  const reportEvery = Math.max(1, Math.floor(count / 50));
  for (let i = 0; i < count; i++) {
    const start = i * hop - size / 2;
    for (let j = 0; j < size; j++) {
      const s = start + j;
      frame[j] = s >= 0 && s < samples.length ? samples[s]! * window[j]! : 0;
    }
    fft.magnitudes(frame, mags);
    for (let k = 0; k < bins; k++) {
      mags[k] = mags[k]! * scale;
      logCur[k] = Math.log1p(COMPRESSION * mags[k]!);
    }

    let all = 0;
    for (let k = allRange[0]; k < allRange[1]; k++) all += mags[k]! * mags[k]!;
    power.all[i] = all;
    for (let k = chromaFrom; k < chromaTo; k++)
      chroma[i * 12 + pitchClass[k]!] = chroma[i * 12 + pitchClass[k]!]! + mags[k]! * mags[k]!;
    for (const band of BANDS) {
      const [lo, hi] = ranges[band];
      let p = 0;
      let f = 0;
      for (let k = lo; k < hi; k++) {
        p += mags[k]! * mags[k]!;
        const d = logCur[k]! - logPrev[k]!;
        if (d > 0) f += d;
      }
      power[band][i] = p;
      flux[band][i] = i === 0 ? 0 : f / (hi - lo);
    }

    [logPrev, logCur] = [logCur, logPrev];
    if (onProgress && i % reportEvery === 0) onProgress(i / count);
  }
  onProgress?.(1);

  return { rate: sampleRate / hop, count, power, flux, chroma };
}
