import {
  BANDS,
  type Accent,
  type Band,
  type BarInfo,
  type EnergyCurve,
  type Fill,
  type MusicFeatures,
  type Onset,
  type Stop,
  type Sustain,
  type Syncopation,
  type TempoSegment,
} from '../types';
import { clamp01, percentile } from './stats';

/**
 * The musical moments a level is built from, found in what the analysis already has: the
 * hits per band, the loudness curves and the beats. Pure; runs in the analysis worker, and
 * on the hand-made analyses of the level tests.
 */

export interface FeatureInput {
  duration: number;
  segments: TempoSegment[];
  beats: number[];
  downbeats: number[];
  onsets: Record<Band, Onset[]>;
  energy: EnergyCurve;
  bands: Record<Band, EnergyCurve>;
  /** Mean power per pitch class (12 values) over a span, or null when there is none. */
  chroma?: (start: number, end: number) => Float32Array | null;
}

/** Hits in different bands this close together are one hit, s. */
const TOGETHER = 0.035;
/** Seconds either side of a hit that its neighbours are compared over. */
const NEIGHBOURHOOD = 4;

/** An accent is this much louder (0–1 over 40 dB, so 6 dB) than its bands' usual hits, summed. */
const ACCENT_EXCESS = 0.15;

/** Sustains: loudness may fall this much (0–1 over 40 dB, so 8 dB) and still hold. */
const SUSTAIN_DROP = 0.2;
/** A hit this strong (in its band) can start a sustain, and ends one. */
const SUSTAIN_HIT = 0.55;
/** Held for at least this many beats. */
const SUSTAIN_BEATS = 0.9;
/** Kicks and snares within a sustain: at most this many a beat (it thins out). */
const SUSTAIN_HITS_PER_BEAT = 1;

/** Stops: loudness below this (0–1 over 40 dB) is nearly silent… */
const STOP_LEVEL = 0.3;
/** …and this far below the music around it. */
const STOP_BELOW = 0.3;
/** Before and after, the band plays at least this loud. */
const STOP_MUSIC = 0.5;
/** For at least this many beats. */
const STOP_BEATS = 0.9;
/** Hits weaker than this don't break a stop (a room's echo, a breath). */
const STOP_HIT = 0.25;

/** Fills: kicks and snares no further apart than this, in beats, are one run. */
const FILL_GAP = 0.55;
/** At least this many hits, this many a beat, ending this close to the bar line (beats). */
const FILL_HITS = 4;
const FILL_DENSITY = 2.5;
const FILL_REACH = 0.75;
/** And this much denser than the same span of the bar before. */
const FILL_CONTRAST = 1.75;
/** How far before the bar line a fill may start, in beats. */
const FILL_SPAN = 2;

/** Syncopations: kicks or snares at least this strong, at least this far off the beat (beats). */
const SYNC_STRENGTH = 0.5;
const SYNC_OFF = 0.2;

/** Bars at least this alike repeat each other. */
export const REPEAT_SIMILARITY = 0.95;
/** Slots a bar's hits are counted in, per band. */
const PATTERN_SLOTS = 16;

/** One hit, maybe in several bands at once. */
interface Hit {
  time: number;
  /** Strength per band (0 where it has none). */
  strength: Record<Band, number>;
}

/** Every band's hits merged into hits across bands, in time order. */
function hitsOf(onsets: Record<Band, Onset[]>): Hit[] {
  const all = BANDS.flatMap((band) => onsets[band].map((o) => ({ band, ...o }))).sort(
    (a, b) => a.time - b.time,
  );
  const hits: Hit[] = [];
  for (const o of all) {
    const last = hits[hits.length - 1];
    if (last && o.time - last.time <= TOGETHER && last.strength[o.band] === 0) {
      last.strength[o.band] = o.strength;
      // Timed by the kick or the snare when there is one: the crack, not the cymbal's swell.
      if (
        o.band !== 'high' &&
        last.strength.high > 0 &&
        last.strength.low + last.strength.mid === 0
      )
        last.time = o.time;
    } else hits.push({ time: o.time, strength: { low: 0, mid: 0, high: 0, [o.band]: o.strength } });
  }
  return hits;
}

/** The tempo segment's period at `t`. */
function periodAt(segments: TempoSegment[], t: number): number {
  let period = segments[0]?.beatPeriod ?? 0.5;
  for (const s of segments) if (t >= s.start) period = s.beatPeriod;
  return period;
}

/** How far `t` is from the nearest beat, in beats (0 to 0.5). */
function offBeat(beats: number[], segments: TempoSegment[], t: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beats[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  const before = beats[lo]!;
  const after = beats[lo + 1];
  const period = after !== undefined && after > before ? after - before : periodAt(segments, t);
  const phase = ((((t - before) / period) % 1) + 1) % 1;
  return Math.min(phase, 1 - phase);
}

/** The curve's value at time `t` (the nearest sample). */
function at(curve: EnergyCurve, t: number): number {
  const i = Math.round(t / curve.step);
  return curve.values[Math.max(0, Math.min(curve.values.length - 1, i))] ?? 0;
}

/** Highest value of the curve over [from, to]. */
function peak(curve: EnergyCurve, from: number, to: number): number {
  let best = 0;
  const i0 = Math.max(0, Math.floor(from / curve.step));
  const i1 = Math.min(curve.values.length - 1, Math.ceil(to / curve.step));
  for (let i = i0; i <= i1; i++) best = Math.max(best, curve.values[i]!);
  return best;
}

/** The median of the values, or 0. */
const median = (values: number[]) => percentile(values, 0.5);

/** Kicks and snares: the hits a fill, a syncopation or a sustain's end is made of. */
const drumOf = (h: Hit) => Math.max(h.strength.low, h.strength.mid);

/**
 * Accents: hits in two bands or more at once, louder in those bands than that band's
 * usual hits nearby by `ACCENT_EXCESS` or more between them (a crash over the hats, a
 * kick over the kicks). Loudness, not onset strength: strengths are capped at the band's
 * loud hits, so a crash would read as just another hat.
 */
function findAccents(input: FeatureInput, hits: Hit[]): Accent[] {
  const { bands, segments } = input;
  const loudness = hits.map(
    (h) =>
      Object.fromEntries(
        BANDS.map((band) => [band, peak(bands[band], h.time, h.time + 0.06)]),
      ) as Record<Band, number>,
  );
  // The hits within `NEIGHBOURHOOD` of each hit: [from, to).
  let lo = 0;
  let hi = 0;
  const windows = hits.map((h) => {
    while (hits[lo]!.time < h.time - NEIGHBOURHOOD) lo++;
    while (hi < hits.length && hits[hi]!.time <= h.time + NEIGHBOURHOOD) hi++;
    return [lo, hi] as const;
  });
  const found: Accent[] = [];
  hits.forEach((h, i) => {
    const loud = BANDS.filter((band) => h.strength[band] >= 0.3);
    if (loud.length < 2) return;
    const [from, to] = windows[i]!;
    let excess = 0;
    for (const band of loud) {
      const usual: number[] = [];
      for (let j = from; j < to; j++)
        if (hits[j]!.strength[band] > 0) usual.push(loudness[j]![band]);
      excess += Math.max(0, loudness[i]![band] - median(usual));
    }
    if (excess < ACCENT_EXCESS) return;
    const accent = { time: h.time, strength: clamp01(excess / (2.5 * ACCENT_EXCESS)) };
    // A beat apart at least: the stronger of two close ones.
    const last = found[found.length - 1];
    if (last && h.time - last.time < periodAt(segments, h.time) * 0.9) {
      if (accent.strength > last.strength) found[found.length - 1] = accent;
    } else found.push(accent);
  });
  return found;
}

/**
 * Stops: the loudness nearly silent, and well below the music around it, for a beat or
 * more with no hit in it, with the band playing just before and coming back after.
 */
function findStops(input: FeatureInput, hits: Hit[]): Stop[] {
  const { energy, segments, duration } = input;
  const step = energy.step;
  const values = energy.values;
  // The level of the music around each sample: its upper quartile over a few seconds.
  const radius = Math.round(NEIGHBOURHOOD / step);
  const stride = Math.max(1, Math.round(0.25 / step));
  const levels: number[] = [];
  for (let i = 0; i < values.length; i += stride)
    levels.push(percentile(values.subarray(Math.max(0, i - radius), i + radius), 0.75));
  const level = (i: number) => levels[Math.min(levels.length - 1, Math.round(i / stride))] ?? 0;

  const stops: Stop[] = [];
  let i = 0;
  while (i < values.length) {
    const quiet = (k: number) => values[k]! < STOP_LEVEL && values[k]! < level(k) - STOP_BELOW;
    if (!quiet(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < values.length && quiet(j)) j++;
    const from = i * step;
    const to = j * step;
    i = j;
    const period = periodAt(segments, from);
    if (to - from < STOP_BEATS * period || to >= duration - 0.05) continue;
    // Music right before and right after.
    if (peak(energy, from - period, from) < STOP_MUSIC) continue;
    if (peak(energy, to, to + period) < STOP_MUSIC) continue;
    // Nothing hits in it (past the last hit's ring).
    if (
      hits.some(
        (h) =>
          h.time > from + 0.06 && h.time < to - 0.03 && drumOf(h) + h.strength.high >= STOP_HIT,
      )
    )
      continue;
    // It ends when the band comes back: the first hit after it, if one is near.
    const back = hits.find((h) => h.time >= to - 0.06 && h.time <= to + period / 2);
    stops.push({ time: from, end: back ? Math.max(from + STOP_BEATS * period, back.time) : to });
  }
  return stops;
}

/**
 * Sustains: after a strong hit, the loudness stays within `SUSTAIN_DROP` of where it was
 * just after the hit, with hardly a kick or a snare, for most of a beat or more. It ends
 * where the sound fades or the next strong hit comes.
 */
function findSustains(input: FeatureInput, hits: Hit[], stops: Stop[]): Sustain[] {
  const { energy, segments } = input;
  const found: Sustain[] = [];
  let free = 0;
  hits.forEach((h, i) => {
    const strength = Math.max(drumOf(h), h.strength.high);
    if (strength < SUSTAIN_HIT || h.time < free) return;
    const period = periodAt(segments, h.time);
    const start = peak(energy, h.time + 0.03, h.time + 0.12);
    if (start < STOP_MUSIC) return;
    // The next strong kick or snare ends it.
    let next = Infinity;
    let thin = 0;
    for (let k = i + 1; k < hits.length; k++) {
      const o = hits[k]!;
      if (o.time - h.time < 0.1) continue;
      if (drumOf(o) >= SUSTAIN_HIT) {
        next = o.time;
        break;
      }
      if (drumOf(o) >= 0.2) thin++;
      if (o.time - h.time > 8 * period) break;
    }
    let end = h.time + 0.12;
    const limit = Math.min(next, h.time + 8 * period, input.duration);
    while (end < limit && at(energy, end) >= start - SUSTAIN_DROP) end += energy.step;
    end = Math.min(end, limit);
    const beats = (end - h.time) / period;
    if (beats < SUSTAIN_BEATS || thin > beats * SUSTAIN_HITS_PER_BEAT) return;
    // A stop isn't held: the band is silent there.
    if (stops.some((s) => s.time < end && s.end > h.time + 0.1)) return;
    found.push({ time: h.time, end, strength, sound: soundOf(input, h.time + 0.1, end) });
    free = end;
  });
  return found;
}

/** Pitch classes this loud against the loudest one sound in a chord. */
const CHORD_SHARE = 0.35;

/**
 * What holds over [from, to]: a cymbal ringing when the highs outweigh the rest, else a
 * chord when three pitch classes or more sound, else a note.
 */
function soundOf(input: FeatureInput, from: number, to: number): Sustain['sound'] {
  let high = 0;
  let rest = 0;
  for (let t = from; t < to; t += input.energy.step) {
    high += at(input.bands.high, t);
    rest += Math.max(at(input.bands.low, t), at(input.bands.mid, t));
  }
  if (high > rest * 1.2) return 'ring';
  const chroma = input.chroma?.(from, to);
  const loudest = chroma ? Math.max(...chroma) : 0;
  if (!chroma || loudest <= 1e-9) return 'note';
  const sounding = [...chroma].filter((v) => v >= CHORD_SHARE * loudest).length;
  return sounding >= 3 ? 'chord' : 'note';
}

/**
 * Fills: a run of kicks and snares (or toms) leading into a bar line, at least
 * `FILL_DENSITY` hits a beat over most of a beat or more, clearly denser than the same
 * span of the bar before.
 */
function findFills(input: FeatureInput, hits: Hit[]): Fill[] {
  const drums = hits.filter((h) => drumOf(h) >= 0.15);
  const fills: Fill[] = [];
  for (const line of input.downbeats) {
    const period = periodAt(input.segments, line - 0.01);
    const span = drums.filter((h) => h.time >= line - FILL_SPAN * period && h.time < line - 0.04);
    // The run that reaches the bar line, walking back while the hits stay close.
    const run: number[] = [];
    for (let k = span.length - 1; k >= 0; k--) {
      const t = span[k]!.time;
      const later = run[0] ?? line;
      if (run.length === 0 ? line - t > FILL_REACH * period : later - t > FILL_GAP * period) break;
      run.unshift(t);
    }
    if (run.length < FILL_HITS) continue;
    const length = Math.max(period / 4, line - run[0]!) / period;
    if (run.length / length < FILL_DENSITY) continue;
    // Denser than the bar before at the same place.
    const bar = 4 * period;
    const before = drums.filter(
      (h) => h.time >= run[0]! - bar - 0.02 && h.time < line - bar - 0.04,
    );
    if (run.length < FILL_CONTRAST * before.length) continue;
    fills.push({ time: run[0]!, end: line, hits: run });
  }
  return fills;
}

/** Syncopations: strong kicks or snares well off the beat, outside fills. */
function findSyncopations(input: FeatureInput, hits: Hit[], fills: Fill[]): Syncopation[] {
  return hits
    .filter(
      (h) =>
        drumOf(h) >= SYNC_STRENGTH &&
        offBeat(input.beats, input.segments, h.time) >= SYNC_OFF &&
        !fills.some((f) => h.time >= f.time - 0.02 && h.time < f.end),
    )
    .map((h) => ({ time: h.time, strength: drumOf(h) }));
}

/** Unit length, or all zeros when there is nothing. */
function unit(values: Float32Array): Float32Array {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  return norm > 1e-9 ? values.map((v) => v / norm) : values.fill(0);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

const isZero = (a: Float32Array) => a.every((v) => v === 0);

/** What a bar sounds like: its pitch classes, its hits on a sixteenth grid, its loudness. */
interface Fingerprint {
  chroma: Float32Array | null;
  pattern: Float32Array;
  loudness: number;
}

function fingerprint(input: FeatureInput, start: number, end: number): Fingerprint {
  const pattern = new Float32Array(BANDS.length * PATTERN_SLOTS);
  BANDS.forEach((band, b) => {
    for (const o of input.onsets[band]) {
      if (o.time < start - 0.03 || o.time >= end - 0.03) continue;
      const slot = Math.round(((o.time - start) / (end - start)) * PATTERN_SLOTS);
      // A hit counts in its slot and a little in the slots either side, so a hit a few
      // milliseconds off doesn't make a bar sound different.
      for (const [d, w] of [
        [0, 1],
        [-1, 0.25],
        [1, 0.25],
      ] as const) {
        const s = (((slot + d) % PATTERN_SLOTS) + PATTERN_SLOTS) % PATTERN_SLOTS;
        pattern[b * PATTERN_SLOTS + s] = pattern[b * PATTERN_SLOTS + s]! + w * o.strength;
      }
    }
  });
  const chroma = input.chroma?.(start, end) ?? null;
  let loudness = 0;
  let n = 0;
  for (let t = start; t < end; t += input.energy.step * 2, n++) loudness += at(input.energy, t);
  return {
    chroma: chroma && !isZero(chroma) ? unit(Float32Array.from(chroma)) : null,
    pattern: unit(pattern),
    loudness: n > 0 ? loudness / n : 0,
  };
}

/** How alike two bars sound, 0 to 1. */
export function barSimilarity(a: Fingerprint, b: Fingerprint): number {
  const quiet = isZero(a.pattern) && isZero(b.pattern);
  let sum = 0;
  let weight = 0;
  if (a.chroma && b.chroma) {
    sum += dot(a.chroma, b.chroma);
    weight++;
  }
  if (!quiet) {
    sum += dot(a.pattern, b.pattern);
    weight++;
  }
  const alike = weight > 0 ? sum / weight : 1;
  return Math.max(0, alike * (1 - Math.min(1, 2 * Math.abs(a.loudness - b.loudness))));
}

/** The bars, each with the first bar that sounds like it. */
function findBars(input: FeatureInput): BarInfo[] {
  const lines = input.downbeats.filter((d) => d < input.duration - 0.05);
  const bars: BarInfo[] = [];
  const prints: Fingerprint[] = [];
  lines.forEach((start, i) => {
    const length = (lines[i + 1] ?? start + 4 * periodAt(input.segments, start)) - start;
    const end = Math.min(input.duration, start + length);
    const print = fingerprint(input, start, end);
    let repeats = bars.length;
    let similarity = 1;
    // The first bar of a group of alike bars that this one sounds like.
    for (let j = 0; j < bars.length; j++) {
      if (bars[j]!.repeats !== j) continue;
      const s = barSimilarity(print, prints[j]!);
      if (s >= REPEAT_SIMILARITY) {
        repeats = j;
        similarity = s;
        break;
      }
    }
    bars.push({ start, end, repeats, similarity });
    prints.push(print);
  });
  return bars;
}

/** Every musical moment of the song. */
export function findFeatures(input: FeatureInput): MusicFeatures {
  const hits = hitsOf(input.onsets);
  const stops = findStops(input, hits);
  const fills = findFills(input, hits);
  return {
    sustains: findSustains(input, hits, stops),
    stops,
    accents: findAccents(input, hits),
    fills,
    syncopations: findSyncopations(input, hits, fills),
    bars: findBars(input),
  };
}

/** No moments at all: for analyses made before the features were found. */
export function noFeatures(): MusicFeatures {
  return { sustains: [], stops: [], accents: [], fills: [], syncopations: [], bars: [] };
}
