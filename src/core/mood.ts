import type {
  EnergyCurve,
  Mood,
  MoodCurves,
  Section,
  SectionFeel,
  SectionMood,
  SongAnalysis,
} from './types';

/**
 * The song's mood, beat by beat and per section, from what the analysis already has: the
 * loudness per band and the hits. Pure: the level map builds it every time (nothing new
 * is analysed, so cached analyses stay valid).
 *
 * - intensity: the overall energy per beat, over the song's own range;
 * - brightness: the high band's share of the loudness, over the song's own range;
 * - density: hits per beat (all bands, hits within 35 ms counted once), 1 at four a beat;
 * - heaviness: the low band's share of the loudness, over the song's own range.
 *
 * The curves are smoothed over about a bar (two beats either side), so they follow the
 * music's contour rather than every hit.
 */

/** Beats either side a curve is smoothed over. */
const SMOOTH_BEATS = 2;
/** Hits weaker than this don't count toward the density. */
const DENSITY_MIN = 0.3;
/** Hits in different bands this close together are one. */
const SAME_HIT = 0.035;
/** Hits per beat that count as fully busy. */
const BUSY_HITS = 4;
/** A main section this loud (0–1) or quieter is calm. */
const CALM_LEVEL = 0.3;
/** Intros and outros louder than this are a groove, not calm. */
const LOUD_EDGE = 0.55;
/** A main section at least this loud is a chorus… */
const CHORUS_LEVEL = 0.6;
/** …when it is this loud, or this much louder than the song's middling main sections. */
const CHORUS_ALWAYS = 0.75;
const CHORUS_ABOVE = 0.08;
/** A main section rising this much from its first bar to its last, into a louder one, builds. */
const BUILD_RISE = 0.25;
const BUILD_NEXT = 0.1;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** The mean of a curve over [from, to). */
function curveMean(curve: EnergyCurve, from: number, to: number): number {
  const i0 = Math.max(0, Math.floor(from / curve.step));
  const i1 = Math.min(curve.values.length, Math.max(i0 + 1, Math.ceil(to / curve.step)));
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += curve.values[i]!;
  return i1 > i0 ? sum / (i1 - i0) : 0;
}

/** Values spread to 0–1 over their own 5th to 95th percentile (flat values sit at 0.5). */
function spread(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const lo = at(0.05);
  const hi = at(0.95);
  if (hi - lo < 0.02) return values.map(() => 0.5);
  return values.map((v) => clamp01((v - lo) / (hi - lo)));
}

/** A triangular moving average over `SMOOTH_BEATS` either side. */
export function smoothBeats(values: readonly number[], reach = SMOOTH_BEATS): number[] {
  return values.map((_, i) => {
    let sum = 0;
    let weights = 0;
    for (let k = -reach; k <= reach; k++) {
      const v = values[i + k];
      if (v === undefined) continue;
      const w = reach + 1 - Math.abs(k);
      sum += w * v;
      weights += w;
    }
    return weights > 0 ? sum / weights : 0;
  });
}

/**
 * The mood curves over a beat grid: `beats` are the grid's beats, `span(i)` how long
 * beat i lasts, `energy` the overall energy per beat already spread over the song's range.
 */
export function moodCurves(
  analysis: Pick<SongAnalysis, 'bands' | 'onsets'>,
  beats: readonly number[],
  span: (i: number) => number,
  energy: readonly number[],
): MoodCurves {
  const { low, mid, high } = analysis.bands;
  const share = (band: EnergyCurve) =>
    beats.map((t, i) => {
      const end = t + span(i);
      const all = curveMean(low, t, end) + curveMean(mid, t, end) + curveMean(high, t, end);
      return all > 1e-6 ? curveMean(band, t, end) / all : 0;
    });

  // Hits per beat: every band's, those within SAME_HIT of one another counted once.
  const hits = [...analysis.onsets.low, ...analysis.onsets.mid, ...analysis.onsets.high]
    .filter((o) => o.strength >= DENSITY_MIN)
    .map((o) => o.time)
    .sort((a, b) => a - b);
  const counts = new Array<number>(beats.length).fill(0);
  let last = -Infinity;
  let b = 0;
  for (const t of hits) {
    if (t - last < SAME_HIT) continue;
    last = t;
    while (b + 1 < beats.length && beats[b + 1]! <= t) b++;
    if (beats.length > 0 && t >= beats[0]! - span(0)) counts[b]! += 1;
  }

  return {
    intensity: smoothBeats(energy),
    brightness: smoothBeats(spread(share(high))),
    density: smoothBeats(counts).map((c) => clamp01(c / BUSY_HITS)),
    heaviness: smoothBeats(spread(share(low))),
  };
}

/** A curve's value at fractional beat `beat`, between its beats. */
export function curveAt(curve: readonly number[], beat: number): number {
  if (curve.length === 0) return 0;
  const i = Math.max(0, Math.min(curve.length - 1, Math.floor(beat)));
  const next = Math.min(curve.length - 1, i + 1);
  const f = Math.max(0, Math.min(1, beat - i));
  return curve[i]! * (1 - f) + curve[next]! * f;
}

/** The mean mood of the beats from `from` to `to` (indices), unsmoothed edges included. */
function meanMood(curves: MoodCurves, from: number, to: number): Mood {
  const mean = (c: number[]) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += c[i]!;
    return to > from ? sum / (to - from) : 0;
  };
  return {
    intensity: mean(curves.intensity),
    brightness: mean(curves.brightness),
    density: mean(curves.density),
    heaviness: mean(curves.heaviness),
  };
}

/**
 * Each section's mood and feel. The structure's kinds name builds, drops and breakdowns;
 * the rest feel by how loud they are: calm when quiet (and intros and outros unless
 * loud), a chorus when loud (clearly louder than the song's middling main sections), a
 * build when a main section rises bar by bar into a louder one, else a groove.
 */
export function sectionMoods(
  sections: readonly Section[],
  beats: readonly number[],
  curves: MoodCurves,
): SectionMood[] {
  const range = (s: Section) => {
    let from = beats.findIndex((t) => t >= s.start - 1e-6);
    if (from < 0) from = beats.length;
    let to = beats.findIndex((t) => t >= s.end - 1e-6);
    if (to < 0) to = beats.length;
    return [from, Math.max(from, to)] as const;
  };
  const moods = sections.map((s) => {
    const [from, to] = range(s);
    return to > from
      ? meanMood(curves, from, to)
      : { intensity: s.energy, brightness: 0.5, density: 0, heaviness: 0.5 };
  });
  const mains = moods
    .filter((_, i) => sections[i]!.kind === 'main')
    .map((m) => m.intensity)
    .sort((a, b) => a - b);
  const middling = mains[Math.floor((mains.length - 1) / 2)] ?? 0.5;

  return sections.map((s, i): SectionMood => {
    const mood = moods[i]!;
    const level = mood.intensity;
    let feel: SectionFeel;
    if (s.kind === 'drop' || s.kind === 'build' || s.kind === 'breakdown') feel = s.kind;
    else if (s.kind === 'intro' || s.kind === 'outro') feel = level > LOUD_EDGE ? 'groove' : 'calm';
    else if (level <= CALM_LEVEL) feel = 'calm';
    else if (level >= CHORUS_LEVEL && (level >= CHORUS_ALWAYS || level >= middling + CHORUS_ABOVE))
      feel = 'chorus';
    else {
      // Rising bar by bar into something louder: a build, though no drop follows.
      const [from, to] = range(s);
      const bar = Math.min(4, Math.floor((to - from) / 2));
      const next = moods[i + 1];
      const rise =
        bar > 0
          ? meanMood(curves, to - bar, to).intensity - meanMood(curves, from, from + bar).intensity
          : 0;
      feel =
        rise >= BUILD_RISE && next !== undefined && next.intensity >= level + BUILD_NEXT
          ? 'build'
          : 'groove';
    }
    return { ...mood, feel };
  });
}
