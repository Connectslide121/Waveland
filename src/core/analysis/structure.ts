import {
  BANDS,
  type Band,
  type Drop,
  type EnergyCurve,
  type Onset,
  type Section,
  type SectionKind,
} from '../types';
import type { Frames } from './spectrum';
import { clamp01, mean, percentile } from './stats';

/** Energy curves are sampled this many times per second. */
export const ENERGY_RATE = 50;
/** Loudness range an energy curve spans, in dB below the song's loud parts. */
const ENERGY_RANGE_DB = 40;

/** Bars either side of a bar line that the novelty compares. */
const NOVELTY_BARS = 4;
/** A bar line becomes a section boundary when the music changes at least this much. */
const NOVELTY_MIN = 0.12;
/** The shortest section, in bars (except at the very start and end). */
const MIN_SECTION_BARS = 4;
/** How much "drive" (energy plus bass) must jump for a section to be a drop. */
const DROP_JUMP = 0.15;
/** And how high in the song's own range the dropped-into section must sit, 0 to 1. */
const DROP_LEVEL = 0.6;

/** A frame curve resampled to `ENERGY_RATE`, as 0 to 1 against the song's loud parts. */
function energyCurve(power: Float32Array, frameRate: number, duration: number): EnergyCurve {
  const db = power.map((p) => 10 * Math.log10(p + 1e-12));
  const reference = percentile(db, 0.99);
  const count = Math.max(1, Math.ceil(duration * ENERGY_RATE));
  const values = new Float32Array(count);
  for (let j = 0; j < count; j++) {
    const x = (j / ENERGY_RATE) * frameRate;
    const i = Math.min(db.length - 1, Math.floor(x));
    const next = Math.min(db.length - 1, i + 1);
    const frac = x - i;
    const value = db[i]! * (1 - frac) + db[next]! * frac;
    values[j] = clamp01((value - reference + ENERGY_RANGE_DB) / ENERGY_RANGE_DB);
  }
  return { step: 1 / ENERGY_RATE, values };
}

export function energyCurves(
  frames: Frames,
  duration: number,
): { energy: EnergyCurve; bands: Record<Band, EnergyCurve> } {
  return {
    energy: energyCurve(frames.power.all, frames.rate, duration),
    bands: {
      low: energyCurve(frames.power.low, frames.rate, duration),
      mid: energyCurve(frames.power.mid, frames.rate, duration),
      high: energyCurve(frames.power.high, frames.rate, duration),
    },
  };
}

function curveMean(curve: EnergyCurve, start: number, end: number): number {
  const from = Math.max(0, Math.floor(start / curve.step));
  const to = Math.min(curve.values.length, Math.max(from + 1, Math.ceil(end / curve.step)));
  return mean(curve.values, from, to);
}

interface StructureInput {
  duration: number;
  downbeats: number[];
  onsets: Record<Band, Onset[]>;
  energy: EnergyCurve;
  bands: Record<Band, EnergyCurve>;
}

/** Bar spans: from each downbeat to the next, with any pickup folded into the first bar. */
function barsOf(downbeats: number[], duration: number): [number, number][] {
  const lines = downbeats.filter((t) => t > 0.05 && t < duration - 0.05);
  // A pickup shorter than a bar joins the first bar; so does a last bar's short tail.
  const barLength = lines.length > 1 ? (lines.at(-1)! - lines[0]!) / (lines.length - 1) : Infinity;
  if (lines.length > 1 && lines[0]! < barLength) lines.shift();
  if (lines.length > 1 && duration - lines.at(-1)! < barLength / 2) lines.pop();
  const edges = [0, ...lines, duration];
  const bars: [number, number][] = [];
  for (let i = 0; i < edges.length - 1; i++) bars.push([edges[i]!, edges[i + 1]!]);
  return bars;
}

/** How much the music changes at each bar line: the distance between the bars before and after. */
export function barNovelty(features: number[][]): number[] {
  const n = features.length;
  const novelty = new Array<number>(n).fill(0);
  const dims = features[0]?.length ?? 1;
  for (let i = 2; i <= n - 2; i++) {
    const k = Math.min(NOVELTY_BARS, i, n - i);
    let sum = 0;
    for (let d = 0; d < dims; d++) {
      let before = 0;
      let after = 0;
      for (let j = 0; j < k; j++) {
        before += features[i - 1 - j]![d]!;
        after += features[i + j]![d]!;
      }
      sum += ((after - before) / k) ** 2;
    }
    novelty[i] = Math.sqrt(sum / dims);
  }
  return novelty;
}

/** Bar lines where a new section starts: the clearest changes, at least a few bars apart. */
function boundaries(novelty: number[]): number[] {
  const candidates = novelty
    .map((value, i) => ({ value, i }))
    .filter(
      ({ value, i }) =>
        value >= NOVELTY_MIN &&
        value >= (novelty[i - 1] ?? 0) &&
        value >= (novelty[i + 1] ?? 0) &&
        value >= (novelty[i - 2] ?? 0) &&
        value >= (novelty[i + 2] ?? 0),
    )
    .sort((a, b) => b.value - a.value);
  const chosen: number[] = [];
  for (const { i } of candidates) {
    if (chosen.every((c) => Math.abs(c - i) >= MIN_SECTION_BARS)) chosen.push(i);
  }
  return chosen.sort((a, b) => a - b);
}

/** Split the song into sections, name them by their energy, and find the drops. */
export function findStructure(input: StructureInput): { sections: Section[]; drops: Drop[] } {
  const { duration, energy, bands, onsets } = input;
  if (duration <= 0) return { sections: [], drops: [] };
  const bars = barsOf(input.downbeats, duration);

  // What each bar sounds like: loudness per band and how busy each band is.
  const density = BANDS.map((band) =>
    bars.map(([start, end]) => {
      let sum = 0;
      for (const o of onsets[band]) if (o.time >= start && o.time < end) sum += o.strength;
      return sum / Math.max(0.1, end - start);
    }),
  );
  const densityScale = density.map((d) => Math.max(1e-6, ...d));
  const features = bars.map(([start, end], b) => [
    curveMean(energy, start, end),
    ...BANDS.map((band) => curveMean(bands[band], start, end)),
    ...density.map((d, i) => d[b]! / densityScale[i]!),
  ]);

  const lines = boundaries(barNovelty(features));
  const edges = [0, ...lines, bars.length];
  const spans = edges.slice(0, -1).map((first, i) => {
    const last = edges[i + 1]! - 1;
    const start = bars[first]![0];
    const end = bars[last]![1];
    const mid = (start + end) / 2;
    return {
      start,
      end,
      energy: curveMean(energy, start, end),
      drive: (curveMean(energy, start, end) + curveMean(bands.low, start, end)) / 2,
      rising: curveMean(energy, mid, end) - curveMean(energy, start, mid),
    };
  });

  const lowest = Math.min(...spans.map((s) => s.drive));
  const range = Math.max(0.2, Math.max(...spans.map((s) => s.drive)) - lowest);
  const level = (s: (typeof spans)[number]) => (s.drive - lowest) / range;

  const kinds: SectionKind[] = spans.map(() => 'main');
  const drops: Drop[] = [];
  spans.forEach((span, i) => {
    const prev = spans[i - 1];
    if (!prev) return;
    const jump = span.drive - prev.drive;
    if (jump >= DROP_JUMP && level(span) >= DROP_LEVEL) {
      kinds[i] = 'drop';
      drops.push({ time: span.start, strength: clamp01(jump / 0.4) });
    }
  });
  spans.forEach((span, i) => {
    if (kinds[i] === 'drop') return;
    const last = i === spans.length - 1;
    if (kinds[i + 1] === 'drop')
      kinds[i] = span.rising > 0.03 ? 'build' : i === 0 ? 'intro' : 'breakdown';
    else if (i === 0 && level(span) < DROP_LEVEL && spans.length > 1) kinds[i] = 'intro';
    else if (last && level(span) < DROP_LEVEL && spans.length > 1) kinds[i] = 'outro';
    else if (level(span) < 0.35) kinds[i] = 'breakdown';
  });

  return {
    sections: spans.map((s, i) => ({
      start: s.start,
      end: s.end,
      kind: kinds[i]!,
      energy: s.energy,
    })),
    drops,
  };
}
