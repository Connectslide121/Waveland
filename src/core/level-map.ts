import { noFeatures } from './analysis/features';
import { fitGrid } from './analysis/grid-fit';
import { moodCurves, sectionMoods } from './mood';
import { hashOf } from './random';
import { beatAt, beatIndexAt, FALLBACK_TEMPO, periodAt, snapToGrid } from './tempo-map';
import type {
  Band,
  BarInfo,
  BeatFit,
  MusicFeatures,
  TempoGrid,
  EnergyCurve,
  LevelEvent,
  LevelEventKind,
  LevelMap,
  Onset,
  SongAnalysis,
  TempoSegment,
} from './types';

/** Onsets this close to the eighth-note grid (in beats) are moved onto it. */
const SNAP_BEATS = 0.15;

/** Ties in time are sorted by kind in this order, so the event list is stable. */
const KIND_ORDER: Record<LevelEventKind, number> = {
  section: 0,
  drop: 1,
  kick: 2,
  snare: 3,
  hat: 4,
  offbeat: 5,
};

/** The onset bands and the event each one becomes. */
const ONSET_KINDS: [Band, LevelEventKind][] = [
  ['low', 'kick'],
  ['mid', 'snare'],
  ['high', 'hat'],
];

/** The first grid beat and the beat period: a straight line fitted through the tracked beats. */
export function fitBeatGrid(beats: number[], tempo: number): { start: number; period: number } {
  const guess = 60 / (tempo > 0 ? tempo : FALLBACK_TEMPO);
  const first = beats[0];
  if (first === undefined || beats.length < 2)
    return { start: (first ?? 0) % guess, period: guess };
  // The grid the beats agree on: a skipped beat keeps its place, beats on the off-beats
  // for a while don't tilt it.
  const { at, period } = fitGrid(beats, guess);
  // Extend back to the first beat at or after the song's start.
  const start = at - Math.floor(at / period) * period;
  return { start, period };
}

/**
 * The analysis' tempo segments, or one over the whole song at its tempo when it has none
 * (an analysis from before the tempo map, or a hand-made one in a test).
 */
function tempoSegmentsOf(analysis: Pick<SongAnalysis, 'segments' | 'tempo' | 'duration'>) {
  if (analysis.segments?.length) return analysis.segments;
  const tempo = analysis.tempo > 0 ? analysis.tempo : FALLBACK_TEMPO;
  return [{ start: 0, end: analysis.duration, tempo, beatPeriod: 60 / tempo }];
}

/** The tracked beats of a segment: from its start up to the next one's. */
function beatsIn(beats: number[], segment: TempoSegment, last: boolean): number[] {
  return beats.filter((t) => t >= segment.start - 1e-6 && (last ? true : t < segment.end - 1e-6));
}

/**
 * The beat grid over the whole song: a straight line fitted through each tempo segment's
 * tracked beats. The first is extended back to the song's start and the last on to its
 * end; each later segment starts on its own grid's beat nearest the change, and the
 * segment before stops a half beat before it, so no beat is doubled at a change.
 */
export function fitTempoGrid(
  analysis: Pick<SongAnalysis, 'segments' | 'tempo' | 'duration' | 'beats'>,
): { segments: TempoSegment[]; beats: number[] } {
  const { duration } = analysis;
  const found = tempoSegmentsOf(analysis);
  const fits = found.map((s, i) =>
    fitBeatGrid(beatsIn(analysis.beats, s, i === found.length - 1), s.tempo),
  );
  // Where each segment's grid starts.
  const starts = fits.map((fit, i) => {
    if (i === 0) return fit.start;
    const k = Math.round((found[i]!.start - fit.start) / fit.period);
    return fit.start + k * fit.period;
  });
  const beats: number[] = [];
  const segments: TempoSegment[] = [];
  fits.forEach(({ period }, i) => {
    const start = starts[i]!;
    const next = starts[i + 1];
    const end = next === undefined ? duration : next - period / 2;
    // A segment too short for a beat of its own: the one before goes on through it.
    if (i > 0 && (start <= beats[beats.length - 1]! + 1e-6 || start >= end)) return;
    for (let t = start, k = 0; t < end - 1e-6; t = start + ++k * period) beats.push(t);
    segments.push({
      start: i === 0 ? 0 : start,
      end: duration,
      tempo: 60 / period,
      beatPeriod: period,
    });
  });
  segments.forEach((s, i) => (s.end = segments[i + 1]?.start ?? duration));
  return { segments, beats };
}

/** The mean of a curve over [from, to). */
function curveMean(curve: EnergyCurve, from: number, to: number): number {
  const i0 = Math.max(0, Math.floor(from / curve.step));
  const i1 = Math.min(curve.values.length, Math.max(i0 + 1, Math.ceil(to / curve.step)));
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += curve.values[i]!;
  return i1 > i0 ? sum / (i1 - i0) : 0;
}

/** Values spread to 0–1 over their own 5th to 95th percentile (flat values stay as they are). */
function spread(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const lo = at(0.05);
  const hi = at(0.95);
  if (hi - lo < 0.05) return values.map((v) => Math.max(0, Math.min(1, v)));
  return values.map((v) => Math.max(0, Math.min(1, (v - lo) / (hi - lo))));
}

/** Fewer tracked beats than this, and the song has no beat to play to. */
const MIN_BEATS = 8;
/** At least this share of the tracked beats on the grid, and the beat is tight. */
const STEADY_SHARE = 0.8;

/**
 * How the song's beat reads: `none` when there is hardly a beat at all, `loose` when the
 * tracked beats drift off their segment's grid (swing, rubato), else `changing` when the
 * tempo map has more than one segment and `steady` when it has one. Games follow the
 * tempo map either way; the menus say what it is.
 */
export function beatFit(
  analysis: Pick<SongAnalysis, 'beats' | 'tempo' | 'duration'> &
    Partial<Pick<SongAnalysis, 'segments'>>,
): BeatFit {
  if (analysis.beats.length < MIN_BEATS) return 'none';
  const grid = fitTempoGrid({ ...analysis, segments: analysis.segments ?? [] });
  const on = analysis.beats.filter((t) => {
    const b = beatAt(grid, t);
    const period = periodAt(grid, t);
    return Math.abs(b - Math.round(b)) * period <= Math.min(0.05, 0.12 * period);
  }).length;
  if (on / analysis.beats.length < STEADY_SHARE) return 'loose';
  return grid.segments.length > 1 ? 'changing' : 'steady';
}

/**
 * The level map for a song: the analysis put on a beat grid that follows its tempo map,
 * as time-based events every game can read. Pure and deterministic.
 */
export function buildLevelMap(analysis: SongAnalysis): LevelMap {
  const { duration } = analysis;
  const { segments, beats } = fitTempoGrid(analysis);
  const grid = { segments, beats };

  // Each segment's bar phase: the one most of the analysis' downbeats in it agree on, or
  // the bars going on from the segment before when it has none.
  const downbeats: number[] = [];
  let barPhase = 0;
  segments.forEach((s, i) => {
    // Its beats: [from, to). A later segment starts on its first beat exactly.
    const from = i === 0 ? 0 : beatIndexAt(grid, s.start);
    const last = i === segments.length - 1;
    const to = last ? beats.length : beatIndexAt(grid, segments[i + 1]!.start);
    const votes = [0, 0, 0, 0];
    for (const d of analysis.downbeats) {
      if (i > 0 && d < s.start - s.beatPeriod / 2) continue;
      if (!last && d >= s.end - s.beatPeriod / 2) continue;
      const k = Math.round(beatAt(grid, d)) - from;
      votes[((k % 4) + 4) % 4]! += 1;
    }
    let phase = votes.indexOf(Math.max(...votes));
    if (Math.max(...votes) === 0 && downbeats.length > 0) {
      const since = from - Math.round(beatAt(grid, downbeats[downbeats.length - 1]!));
      phase = (((4 - since) % 4) + 4) % 4;
    }
    if (i === 0) barPhase = phase;
    for (let k = from + phase; k < to; k += 4) downbeats.push(beats[k]!);
  });

  // How long each beat lasts: its segment's period, or up to the next beat at a change.
  const span = (i: number) => {
    const period = periodAt(grid, beats[i]!);
    const gap = (beats[i + 1] ?? Infinity) - beats[i]!;
    return Math.abs(gap - period) < 1e-6 || gap === Infinity ? period : gap;
  };
  const bass = spread(beats.map((t, i) => curveMean(analysis.bands.low, t, t + span(i))));
  const energy = spread(beats.map((t, i) => curveMean(analysis.energy, t, t + span(i))));

  const events: LevelEvent[] = [];
  const add = (time: number, kind: LevelEventKind, intensity: number, extra = {}) => {
    if (time < 0 || time >= duration) return;
    events.push({ time, kind, intensity, beat: beatIndexAt(grid, time), ...extra });
  };
  for (const [band, kind] of ONSET_KINDS) {
    const seen = new Set<number>();
    for (const onset of analysis.onsets[band] as Onset[]) {
      // Hits move onto the eighth-note grid when they are close to it, so games stay on the beat.
      const time = snapToGrid(grid, onset.time, 2, SNAP_BEATS);
      // Two hits snapped onto the same spot are one.
      const key = Math.round(time * 1000);
      if (seen.has(key)) continue;
      seen.add(key);
      add(time, kind, onset.strength);
    }
  }
  beats.forEach((t, i) => add(t + span(i) / 2, 'offbeat', energy[i] ?? 0));
  for (const drop of analysis.drops) {
    // On the nearest bar line, when there is one within a beat.
    let time = drop.time;
    for (const d of downbeats) if (Math.abs(d - drop.time) < Math.abs(time - drop.time)) time = d;
    add(
      Math.abs(time - drop.time) <= periodAt(grid, drop.time) ? time : drop.time,
      'drop',
      drop.strength,
    );
  }
  for (const s of analysis.sections) add(s.start, 'section', s.energy, { section: s.kind });
  events.sort((a, b) => a.time - b.time || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  const seed = hashOf(
    'waveland',
    duration,
    analysis.tempo,
    analysis.beats.length,
    analysis.onsets.low.length,
    analysis.onsets.mid.length,
    analysis.onsets.high.length,
    analysis.sections.length,
    analysis.drops.length,
  );

  const features = gridFeatures(
    analysis.features ?? noFeatures(),
    { segments, beats, downbeats },
    duration,
  );

  const mood = moodCurves(analysis, beats, span, energy);
  const moods = sectionMoods(analysis.sections, beats, mood);

  // The tempo the song spends most of its time at.
  const main = segments.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  return {
    seed,
    duration,
    tempo: main.tempo,
    segments,
    beats,
    downbeats,
    barPhase,
    bass,
    energy,
    events,
    sections: analysis.sections,
    moods,
    mood,
    drops: analysis.drops,
    features,
  };
}

/**
 * The analysis' musical moments on the grid: hits snapped onto it as the events are,
 * held sounds and stops ending on its sixteenths, fills leading into a grid bar line, and
 * one bar per grid bar, repeating the first grid bar its analysis bar repeats.
 */
export function gridFeatures(
  found: MusicFeatures,
  grid: TempoGrid,
  duration: number,
): MusicFeatures {
  const snap = (t: number, division: number, tolerance: number) =>
    snapToGrid(grid, t, division, tolerance);
  const inSong = (t: number) => t >= 0 && t < duration;
  const sustains = found.sustains
    .map((s) => {
      const time = snap(s.time, 2, SNAP_BEATS);
      return { ...s, time, end: Math.max(time + 0.05, snap(s.end, 4, SNAP_BEATS)) };
    })
    .filter((s) => inSong(s.time));
  const stops = found.stops
    .map((s) => {
      // The silence starts as the last hit's ring fades: on the eighth it is nearest.
      const time = snap(s.time, 2, 0.25);
      return { time, end: Math.max(time + 0.05, snap(s.end, 2, SNAP_BEATS)) };
    })
    .filter((s) => inSong(s.time));
  const accents = found.accents
    .map((a) => ({ ...a, time: snap(a.time, 2, SNAP_BEATS) }))
    .filter((a) => inSong(a.time));
  const fills = found.fills
    .map((f) => {
      const hits = [...new Set(f.hits.map((t) => snap(t, 4, 0.12)))].sort((a, b) => a - b);
      // The bar line it leads into, on the grid.
      let end = Infinity;
      for (const d of grid.downbeats) if (Math.abs(d - f.end) < Math.abs(end - f.end)) end = d;
      if (!(Math.abs(end - f.end) <= periodAt(grid, f.end))) end = f.end;
      return { time: hits[0] ?? f.time, end, hits: hits.filter((t) => t < end - 1e-6) };
    })
    .filter((f) => inSong(f.time) && f.hits.length > 0);
  const syncopations = found.syncopations
    .map((s) => ({ ...s, time: snap(s.time, 4, 0.1) }))
    .filter((s) => inSong(s.time));

  // Each grid bar takes the analysis bar starting nearest it (within two beats).
  const groupOf = grid.downbeats.map((start) => {
    let best: BarInfo | undefined;
    for (const bar of found.bars)
      if (!best || Math.abs(bar.start - start) < Math.abs(best.start - start)) best = bar;
    return best && Math.abs(best.start - start) <= 2 * periodAt(grid, start) ? best : undefined;
  });
  const firstOf = new Map<number, number>();
  const bars: BarInfo[] = grid.downbeats.map((start, i) => {
    const end = grid.downbeats[i + 1] ?? duration;
    const own = groupOf[i];
    if (!own) return { start, end, repeats: i, similarity: 1 };
    const first = firstOf.get(own.repeats);
    if (first === undefined) {
      firstOf.set(own.repeats, i);
      return { start, end, repeats: i, similarity: 1 };
    }
    return { start, end, repeats: first, similarity: own.similarity };
  });
  return { sustains, stops, accents, fills, syncopations, bars };
}
