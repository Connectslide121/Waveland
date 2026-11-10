/**
 * Random but plausible song analyses for the level tests: any tempo, sections with drops
 * and breakdowns, hits that sometimes follow the groove and sometimes don't. Seeded, so a
 * failing seed can be run again.
 */
import { findFeatures } from './analysis/features';
import { Random } from './random';
import type {
  Drop,
  EnergyCurve,
  Onset,
  Section,
  SectionKind,
  SongAnalysis,
  TempoSegment,
} from './types';

export interface RandomAnalysisOptions {
  /** Song length in seconds; random from 40 to 90 when left out. */
  duration?: number;
  /** Beats per minute; random from 70 to 180 when left out. */
  tempo?: number;
  /** Tempo changes: from the first beat at or after each `time`, the beat goes at `tempo`. */
  changes?: { time: number; tempo: number }[];
}

const RATE = 50;

export function randomAnalysis(seed: number, options: RandomAnalysisOptions = {}): SongAnalysis {
  const rng = new Random(seed);
  const tempo = options.tempo ?? rng.range(70, 180);
  const duration = options.duration ?? rng.range(40, 90);
  const first = rng.range(0.05, 1.5);
  const jitter = () => rng.range(-0.008, 0.008);

  // The tempo map: a segment per change, each starting on the first beat at its tempo.
  const changes = [...(options.changes ?? [])].sort((a, b) => a.time - b.time);
  const segments: TempoSegment[] = [{ start: 0, end: duration, tempo, beatPeriod: 60 / tempo }];
  const beats: number[] = [];
  // Sometimes the tracker trims silent beats at both ends.
  const lead = rng.chance(0.3) ? rng.int(1, 6) : 0;
  for (let t = first + lead * (60 / tempo); t < duration - 0.3;) {
    const next = changes[segments.length - 1];
    if (next && t >= next.time) {
      segments.at(-1)!.end = t;
      segments.push({ start: t, end: duration, tempo: next.tempo, beatPeriod: 60 / next.tempo });
    }
    beats.push(t + jitter());
    t += segments.at(-1)!.beatPeriod;
  }
  const periodAt = (t: number) =>
    [...segments].reverse().find((s) => t >= s.start)?.beatPeriod ?? 60 / tempo;
  const phase = rng.int(0, 3);
  const downbeats = beats.filter((_, i) => i >= phase && (i - phase) % 4 === 0);

  // Sections of 4 to 16 bars, with drops after builds and breakdowns.
  const sections: Section[] = [];
  const drops: Drop[] = [];
  let start = 0;
  let bar = 0;
  let previous: SectionKind = 'intro';
  while (start < duration - 1e-6) {
    // Sections start and end on bar lines, like the analysis' own.
    bar += rng.int(4, 16);
    const end = downbeats[bar] ?? duration;
    let kind: SectionKind;
    if (start === 0) kind = 'intro';
    else if (end >= duration) kind = 'outro';
    else if (previous === 'build' || previous === 'breakdown')
      kind = rng.chance(0.8) ? 'drop' : 'main';
    else
      kind = rng.weighted<SectionKind>([
        ['main', 3],
        ['build', 2],
        ['breakdown', 1.5],
      ]);
    const energy =
      kind === 'drop'
        ? rng.range(0.8, 1)
        : kind === 'breakdown'
          ? rng.range(0.15, 0.4)
          : rng.range(0.4, 0.75);
    sections.push({ start, end, kind, energy });
    if (kind === 'drop') drops.push({ time: start, strength: rng.range(0.5, 1) });
    previous = kind;
    start = end;
  }
  const sectionAt = (t: number) => sections.find((s) => t >= s.start && t < s.end) ?? sections[0]!;

  // Energy curves: the section's level with some wobble, bass pumping on the beat.
  const count = Math.ceil(duration * RATE);
  const curve = (f: (t: number, s: Section) => number): EnergyCurve => {
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const t = i / RATE;
      values[i] = Math.max(0, Math.min(1, f(t, sectionAt(t))));
    }
    return { step: 1 / RATE, values };
  };
  const wobble = rng.range(0, 0.3);
  const energy = curve((t, s) => s.energy + wobble * Math.sin(t * 0.7));
  const low = curve(
    (t, s) =>
      s.energy *
      (s.kind === 'breakdown' ? 0.4 : 1) *
      (0.7 + 0.3 * Math.cos((t / periodAt(t)) * Math.PI * 2)),
  );
  const mid = curve((_, s) => s.energy * 0.8);
  const high = curve((_, s) => s.energy * 0.6);

  // Hits: kicks on beats, snares on 2 and 4 (or scattered), hats on eighths, all patchy.
  const onsets: SongAnalysis['onsets'] = { low: [], mid: [], high: [] };
  const hit = (list: Onset[], time: number, s: Section) => {
    if (time < duration)
      list.push({ time, strength: Math.min(1, rng.range(0.3, 1) * (0.5 + s.energy)) });
  };
  const snareStyle = rng.weighted<'backbeat' | 'scattered' | 'none'>([
    ['backbeat', 6],
    ['scattered', 2],
    ['none', 1],
  ]);
  beats.forEach((t, i) => {
    const s = sectionAt(t);
    const period = periodAt(t);
    const quiet = s.kind === 'breakdown' || s.kind === 'intro';
    if (rng.chance(quiet ? 0.4 : 0.9)) hit(onsets.low, t + jitter(), s);
    const inBar = (i - phase + 4) % 4;
    if (snareStyle === 'backbeat' && inBar % 2 === 1 && rng.chance(quiet ? 0.5 : 0.95))
      hit(onsets.mid, t + jitter(), s);
    if (snareStyle === 'scattered' && rng.chance(0.4))
      hit(onsets.mid, t + rng.int(0, 1) * (period / 2) + jitter(), s);
    for (const half of [0, period / 2])
      if (rng.chance(quiet ? 0.3 : 0.75)) hit(onsets.high, t + half + jitter(), s);
  });

  const bands = { low, mid, high };
  moments(new Random(seed ^ 0x5eed), { downbeats, sections, onsets, energy, bands, periodAt });
  return {
    duration,
    tempo,
    segments,
    beats,
    downbeats,
    onsets,
    energy,
    bands,
    sections,
    drops,
    features: findFeatures({ duration, segments, beats, downbeats, onsets, energy, bands }),
  };
}

/**
 * Musical moments put into a random song, with their own randomness so the rest of the
 * song stays as it was: a crash on some section starts, fills into some bar lines, now
 * and then a held chord (the drums leave it alone) or a stop (everything cuts out).
 */
function moments(
  rng: Random,
  song: {
    downbeats: number[];
    sections: Section[];
    onsets: SongAnalysis['onsets'];
    energy: EnergyCurve;
    bands: SongAnalysis['bands'];
    periodAt: (t: number) => number;
  },
) {
  const { downbeats, onsets, periodAt } = song;
  const clear = (from: number, to: number, bands: (keyof typeof onsets)[]) => {
    for (const band of bands)
      onsets[band] = onsets[band].filter((o) => o.time < from || o.time >= to);
  };
  const add = (band: keyof typeof onsets, time: number, strength: number) => {
    onsets[band].push({ time, strength });
  };
  for (const s of song.sections.slice(1)) {
    if (s.kind === 'breakdown' || !rng.chance(0.6)) continue;
    clear(s.start - 0.03, s.start + 0.03, ['low', 'mid', 'high']);
    add('low', s.start, 1);
    add('mid', s.start, 1);
    add('high', s.start, 1);
    // A crash is loud: louder than the hats and the kicks around it.
    for (const [curve, by] of [
      [song.bands.high, 0.4],
      [song.bands.low, 0.2],
    ] as const) {
      const i0 = Math.round(s.start / curve.step);
      for (let k = i0; k < i0 + 5 && k < curve.values.length; k++)
        curve.values[k] = Math.min(1, curve.values[k]! + by);
    }
  }
  downbeats.forEach((d, i) => {
    if (i < 2 || i >= downbeats.length - 2) return;
    const p = periodAt(d);
    const roll = rng.next();
    if (roll < 0.12) {
      // A sixteenth-note snare fill over the beat before the bar line.
      clear(d - p - 0.03, d - 0.03, ['low', 'mid']);
      for (let k = 0; k < 4; k++) add('mid', d - p + (k * p) / 4, rng.range(0.5, 0.9));
    } else if (roll < 0.2) {
      // A held chord from the bar line: one hit, then nothing from the drums for a while.
      const length = rng.range(1.5, 2.5) * p;
      clear(d + 0.03, d + length, ['low', 'mid']);
      clear(d - 0.03, d + 0.03, ['low']);
      add('low', d, 0.95);
    } else if (roll < 0.25) {
      // A stop: the band cuts out from beat 2 for one or two beats.
      const from = d + p;
      const to = from + rng.int(1, 2) * p;
      clear(from - 0.03, to - 0.03, ['low', 'mid', 'high']);
      for (const curve of [song.energy, song.bands.low, song.bands.mid, song.bands.high]) {
        const i0 = Math.ceil((from + 0.05) / curve.step);
        const i1 = Math.floor(to / curve.step);
        for (let k = i0; k < i1 && k < curve.values.length; k++) curve.values[k] = 0.02;
      }
    }
  });
  for (const band of ['low', 'mid', 'high'] as const) onsets[band].sort((a, b) => a.time - b.time);
}
