import type { TempoGrid, TempoSegment } from './types';

/**
 * Reading a tempo map: where a moment is in beats and bars, and how fast the beat goes
 * there. Every game times things with these instead of start + k × period arithmetic, so
 * it follows a song whose tempo changes. Pure functions of the grid (plain data, so it
 * crosses to workers); a steady song's grid is one segment and reads as one straight line.
 */

/** The tempo when there is no beat at all. */
export const FALLBACK_TEMPO = 120;

const FALLBACK_SEGMENT: TempoSegment = {
  start: 0,
  end: Infinity,
  tempo: FALLBACK_TEMPO,
  beatPeriod: 60 / FALLBACK_TEMPO,
};

/** Index of the last of the sorted `times` at or before `t`, or -1. */
export function lastAtOrBefore(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Index of the tempo segment at song time `t` (the first before the song, the last after). */
function segmentIndexAt(segments: readonly TempoSegment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid]!.start <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The tempo segment at song time `t` (the first before the song, the last after it). */
export function segmentAt(grid: Pick<TempoGrid, 'segments'>, t: number): TempoSegment {
  return grid.segments[segmentIndexAt(grid.segments, t)] ?? FALLBACK_SEGMENT;
}

/**
 * Where the regular grid of the segment holding beat `i` is anchored: the index of its
 * first beat, and its period. Within a segment beats are that first beat + k × period.
 */
function anchorOf(grid: Pick<TempoGrid, 'beats' | 'segments'>, i: number) {
  const s = segmentIndexAt(grid.segments, grid.beats[i]!);
  const segment = grid.segments[s] ?? FALLBACK_SEGMENT;
  // A later segment starts on its first beat exactly.
  const first = s === 0 ? 0 : Math.max(0, lastAtOrBefore(grid.beats, segment.start));
  return { first, period: segment.beatPeriod, segment: s };
}

/** True when beats `i` and `i + 1` are in different segments: the interval at a change. */
function crossesChange(grid: Pick<TempoGrid, 'beats' | 'segments'>, i: number): boolean {
  if (grid.segments.length < 2) return false;
  const next = grid.beats[i + 1];
  return (
    next !== undefined &&
    segmentIndexAt(grid.segments, next) !== segmentIndexAt(grid.segments, grid.beats[i]!)
  );
}

/** Seconds per beat at song time `t`. */
export function periodAt(grid: Pick<TempoGrid, 'segments'>, t: number): number {
  return segmentAt(grid, t).beatPeriod;
}

/** Beats per minute at song time `t`. */
export function tempoAt(grid: Pick<TempoGrid, 'segments'>, t: number): number {
  return segmentAt(grid, t).tempo;
}

/**
 * Where song time `t` is in beats: 3 on the grid's fourth beat, 3.5 halfway to the next.
 * Before the first beat and after the last it goes on at that segment's tempo (negative
 * before the first).
 */
export function beatAt(grid: Pick<TempoGrid, 'beats' | 'segments'>, t: number): number {
  const beats = grid.beats;
  if (beats.length === 0) return t / periodAt(grid, t);
  const i = Math.max(0, lastAtOrBefore(beats, t));
  if (crossesChange(grid, i)) return i + (t - beats[i]!) / (beats[i + 1]! - beats[i]!);
  const { first, period } = anchorOf(grid, i);
  return first + (t - beats[first]!) / period;
}

/** The song time of beat number `b` (fractional), the inverse of `beatAt`. */
export function timeOfBeat(grid: Pick<TempoGrid, 'beats' | 'segments'>, b: number): number {
  const beats = grid.beats;
  const n = beats.length;
  if (n === 0) return b * periodAt(grid, 0);
  const i = Math.max(0, Math.min(n - 1, Math.floor(b)));
  if (i === Math.floor(b) && crossesChange(grid, i))
    return beats[i]! + (b - i) * (beats[i + 1]! - beats[i]!);
  const { first, period } = anchorOf(grid, i);
  return beats[first]! + (b - first) * period;
}

/** Index of the grid beat at or just before `t`, within the grid. */
export function beatIndexAt(grid: Pick<TempoGrid, 'beats' | 'segments'>, t: number): number {
  const i = Math.floor(beatAt(grid, t) + 1e-6);
  return Math.max(0, Math.min(grid.beats.length - 1, i));
}

/** The beat number of a time that is on the grid (a downbeat), as a whole number. */
function wholeBeat(grid: TempoGrid, t: number): number {
  return Math.round(beatAt(grid, t));
}

/**
 * Where song time `t` is in bars: 2 on the third bar line, 2.5 halfway through that bar.
 * Bars are counted from the grid's downbeats, so a bar cut short by a tempo change is
 * still one bar; before the first and after the last, bars are four beats.
 */
export function barAt(grid: TempoGrid, t: number): number {
  const downs = grid.downbeats;
  const b = beatAt(grid, t);
  if (downs.length === 0) return b / 4;
  const j = lastAtOrBefore(downs, t + 1e-9);
  if (j < 0) return (b - wholeBeat(grid, downs[0]!)) / 4;
  const from = wholeBeat(grid, downs[j]!);
  if (j === downs.length - 1) return j + (b - from) / 4;
  return j + (b - from) / (wholeBeat(grid, downs[j + 1]!) - from);
}

/** Which beat of its bar `t` is in: 0 on the bar line, up to 3 in 4/4. */
export function beatInBar(grid: TempoGrid, t: number): number {
  const b = Math.floor(beatAt(grid, t) + 1e-6);
  const downs = grid.downbeats;
  if (downs.length === 0) return ((b % 4) + 4) % 4;
  const j = lastAtOrBefore(downs, timeOfBeat(grid, b) + 1e-6);
  const from = wholeBeat(grid, downs[Math.max(0, j)]!);
  return (((b - from) % 4) + 4) % 4;
}

/** The song time `beats` beats before `t`, following the tempo map. */
export function beatsBefore(grid: Pick<TempoGrid, 'beats' | 'segments'>, t: number, beats: number) {
  return timeOfBeat(grid, beatAt(grid, t) - beats);
}

/**
 * `t` moved onto the grid's `division`-th notes (2 for eighths) when it is within
 * `tolerance` beats of one, else `t` as it is.
 */
export function snapToGrid(
  grid: Pick<TempoGrid, 'beats' | 'segments'>,
  t: number,
  division: number,
  tolerance: number,
): number {
  const notes = beatAt(grid, t) * division;
  const nearest = Math.round(notes);
  return Math.abs(notes - nearest) / division <= tolerance
    ? timeOfBeat(grid, nearest / division)
    : t;
}

/** A steady grid: one tempo from `start` (the first beat, at or after 0) to `duration`. */
export function steadyGrid(start: number, period: number, duration: number): TempoGrid {
  const beats: number[] = [];
  for (let t = start; t < duration - 1e-6; t = start + beats.length * period) beats.push(t);
  return {
    segments: [{ start: 0, end: duration, tempo: 60 / period, beatPeriod: period }],
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
  };
}

/**
 * The tempos of a tempo map in words, rounded to whole BPM: "128" for a steady song,
 * "120 → 150" for one change, "96–160" (lowest to highest) for more.
 */
export function describeTempos(segments: readonly Pick<TempoSegment, 'tempo'>[]): string {
  const bpms: number[] = [];
  for (const s of segments) {
    const bpm = Math.round(s.tempo);
    if (bpm !== bpms[bpms.length - 1]) bpms.push(bpm);
  }
  if (bpms.length <= 1) return String(bpms[0] ?? FALLBACK_TEMPO);
  if (bpms.length === 2) return `${bpms[0]} → ${bpms[1]}`;
  return `${Math.min(...bpms)}–${Math.max(...bpms)}`;
}
