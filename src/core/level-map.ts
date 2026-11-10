import { hashOf } from './random';
import type {
  Band,
  EnergyCurve,
  LevelEvent,
  LevelEventKind,
  LevelMap,
  Onset,
  SongAnalysis,
} from './types';

/** Onsets this close to the eighth-note grid (in beats) are moved onto it. */
const SNAP_BEATS = 0.15;
/** The tempo used when a song has no beat at all. */
const FALLBACK_TEMPO = 120;

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
  // Number the beats on the guessed period (a skipped beat keeps its place), then fit.
  const ks = beats.map((t) => Math.round((t - first) / guess));
  const n = beats.length;
  const meanK = ks.reduce((a, b) => a + b, 0) / n;
  const meanT = beats.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (ks[i]! - meanK) * (beats[i]! - meanT);
    den += (ks[i]! - meanK) ** 2;
  }
  const period = den > 0 && num > 0 ? num / den : guess;
  const at0 = meanT - period * meanK;
  // Extend back to the first beat at or after the song's start.
  const start = at0 - Math.floor(at0 / period) * period;
  return { start, period };
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

/** Index of the grid beat at or just before `time`. */
export function beatIndexAt(map: Pick<LevelMap, 'beats' | 'beatPeriod'>, time: number): number {
  const start = map.beats[0] ?? 0;
  const i = Math.floor((time - start) / map.beatPeriod + 1e-6);
  return Math.max(0, Math.min(map.beats.length - 1, i));
}

/**
 * The level map for a song: the analysis put on a regular beat grid, as time-based events
 * every game can read. Pure and deterministic.
 */
export function buildLevelMap(analysis: SongAnalysis): LevelMap {
  const { duration } = analysis;
  const { start, period } = fitBeatGrid(analysis.beats, analysis.tempo);
  const beats: number[] = [];
  for (let t = start; t < duration - 1e-6; t = start + beats.length * period) beats.push(t);

  // The bar phase most of the analysis' downbeats agree on.
  const votes = [0, 0, 0, 0];
  for (const d of analysis.downbeats) {
    const k = Math.round((d - start) / period);
    votes[((k % 4) + 4) % 4]! += 1;
  }
  const barPhase = votes.indexOf(Math.max(...votes));
  const downbeats = beats.filter((_, i) => i >= barPhase && (i - barPhase) % 4 === 0);

  const bass = spread(beats.map((t) => curveMean(analysis.bands.low, t, t + period)));
  const energy = spread(beats.map((t) => curveMean(analysis.energy, t, t + period)));

  const grid = { beats, beatPeriod: period };
  const events: LevelEvent[] = [];
  const add = (time: number, kind: LevelEventKind, intensity: number, extra = {}) => {
    if (time < 0 || time >= duration) return;
    events.push({ time, kind, intensity, beat: beatIndexAt(grid, time), ...extra });
  };
  // Hits move onto the eighth-note grid when they are close to it, so games stay on the beat.
  const snap = (time: number) => {
    const eighths = (time - start) / (period / 2);
    const nearest = Math.round(eighths);
    return Math.abs(eighths - nearest) / 2 <= SNAP_BEATS ? start + (nearest * period) / 2 : time;
  };
  for (const [band, kind] of ONSET_KINDS) {
    const seen = new Set<number>();
    for (const onset of analysis.onsets[band] as Onset[]) {
      const time = snap(onset.time);
      // Two hits snapped onto the same spot are one.
      const key = Math.round(time * 1000);
      if (seen.has(key)) continue;
      seen.add(key);
      add(time, kind, onset.strength);
    }
  }
  beats.forEach((t, i) => add(t + period / 2, 'offbeat', energy[i] ?? 0));
  for (const drop of analysis.drops) {
    // On the nearest bar line, when there is one within a beat.
    let time = drop.time;
    for (const d of downbeats) if (Math.abs(d - drop.time) < Math.abs(time - drop.time)) time = d;
    add(Math.abs(time - drop.time) <= period ? time : drop.time, 'drop', drop.strength);
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

  return {
    seed,
    duration,
    tempo: 60 / period,
    beatPeriod: period,
    beats,
    downbeats,
    barPhase,
    bass,
    energy,
    events,
    sections: analysis.sections,
    drops: analysis.drops,
  };
}
