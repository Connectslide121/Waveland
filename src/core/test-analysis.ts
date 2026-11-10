/**
 * Random but plausible song analyses for the level tests: any tempo, sections with drops
 * and breakdowns, hits that sometimes follow the groove and sometimes don't. Seeded, so a
 * failing seed can be run again.
 */
import { Random } from './random';
import type { Drop, EnergyCurve, Onset, Section, SectionKind, SongAnalysis } from './types';

export interface RandomAnalysisOptions {
  /** Song length in seconds; random from 40 to 90 when left out. */
  duration?: number;
  /** Beats per minute; random from 70 to 180 when left out. */
  tempo?: number;
}

const RATE = 50;

export function randomAnalysis(seed: number, options: RandomAnalysisOptions = {}): SongAnalysis {
  const rng = new Random(seed);
  const tempo = options.tempo ?? rng.range(70, 180);
  const duration = options.duration ?? rng.range(40, 90);
  const period = 60 / tempo;
  const first = rng.range(0.05, 1.5);
  const jitter = () => rng.range(-0.008, 0.008);

  const beats: number[] = [];
  // Sometimes the tracker trims silent beats at both ends.
  const lead = rng.chance(0.3) ? rng.int(1, 6) : 0;
  for (let t = first + lead * period; t < duration - 0.3; t += period) beats.push(t + jitter());
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
      (0.7 + 0.3 * Math.cos((t / period) * Math.PI * 2)),
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

  return {
    duration,
    tempo,
    beats,
    downbeats,
    onsets,
    energy,
    bands: { low, mid, high },
    sections,
    drops,
  };
}
