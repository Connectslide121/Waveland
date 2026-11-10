import { describe, expect, it } from 'vitest';
import { beatFit, beatIndexAt, buildLevelMap, fitBeatGrid } from './level-map';
import { randomAnalysis } from './test-analysis';

describe('fitBeatGrid', () => {
  it('fits the period and extends the grid back to the start of the song', () => {
    const beats = [2.5, 3, 3.5, 4.5, 5]; // one skipped beat at 4.0
    const { start, period } = fitBeatGrid(beats, 120);
    expect(period).toBeCloseTo(0.5, 6);
    expect(start).toBeCloseTo(0, 6);
  });

  it('falls back to the tempo, or 120 BPM, without beats', () => {
    expect(fitBeatGrid([], 100).period).toBeCloseTo(0.6);
    expect(fitBeatGrid([], 0).period).toBeCloseTo(0.5);
  });
});

describe('beatFit', () => {
  const at = (bpm: number, from: number, count: number) =>
    Array.from({ length: count }, (_, i) => from + (i * 60) / bpm);

  it('calls a song steady when its beats sit on one grid', () => {
    expect(beatFit({ beats: at(128, 0.3, 200), tempo: 128 })).toBe('steady');
  });

  it('calls a song changing when its tempo moves from 100 to 130 BPM', () => {
    const slow = at(100, 0.3, 64);
    const fast = at(130, slow.at(-1)! + 0.6, 128);
    expect(beatFit({ beats: [...slow, ...fast], tempo: 100 })).toBe('changing');
  });

  it('finds no beat in a song with hardly any', () => {
    expect(beatFit({ beats: [], tempo: 120 })).toBe('none');
    expect(beatFit({ beats: at(120, 0, 5), tempo: 120 })).toBe('none');
  });
});

describe('buildLevelMap', () => {
  const analysis = randomAnalysis(7, { tempo: 128, duration: 60 });
  const map = buildLevelMap(analysis);

  it('puts a regular beat grid over the whole song', () => {
    expect(map.beats[0]).toBeGreaterThanOrEqual(0);
    expect(map.beats[0]).toBeLessThan(map.beatPeriod);
    expect(map.beats[map.beats.length - 1]).toBeLessThan(60);
    expect(map.beats[map.beats.length - 1]! + map.beatPeriod).toBeGreaterThanOrEqual(60);
    expect(map.tempo).toBeCloseTo(128, 0);
    for (let i = 1; i < map.beats.length; i++)
      expect(map.beats[i]! - map.beats[i - 1]!).toBeCloseTo(map.beatPeriod, 6);
  });

  it('keeps the bars where the analysis put them', () => {
    for (const d of analysis.downbeats) {
      const nearest = Math.min(...map.downbeats.map((x) => Math.abs(x - d)));
      expect(nearest).toBeLessThan(0.03);
    }
    expect(map.downbeats[0]).toBe(map.beats[map.barPhase]);
  });

  it('has a bass and an energy level per beat, from 0 to 1', () => {
    expect(map.bass).toHaveLength(map.beats.length);
    expect(map.energy).toHaveLength(map.beats.length);
    for (const v of [...map.bass, ...map.energy]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('lists every hit, off-beat, drop and section as events sorted by time', () => {
    const count = (kind: string) => map.events.filter((e) => e.kind === kind).length;
    expect(count('kick')).toBeGreaterThan(0);
    expect(count('hat')).toBeGreaterThan(0);
    expect(count('offbeat')).toBe(map.beats.filter((t) => t + map.beatPeriod / 2 < 60).length);
    expect(count('drop')).toBe(analysis.drops.length);
    expect(count('section')).toBe(analysis.sections.length);
    for (let i = 1; i < map.events.length; i++)
      expect(map.events[i]!.time).toBeGreaterThanOrEqual(map.events[i - 1]!.time);
    for (const e of map.events) expect(e.beat).toBe(beatIndexAt(map, e.time));
  });

  it('puts snares on the eighth-note grid', () => {
    for (const e of map.events.filter((x) => x.kind === 'snare')) {
      const eighths = (e.time - map.beats[0]!) / (map.beatPeriod / 2);
      expect(Math.abs(eighths - Math.round(eighths))).toBeLessThan(1e-6);
    }
  });

  it('puts drops on bar lines', () => {
    for (const e of map.events.filter((x) => x.kind === 'drop'))
      expect(map.downbeats).toContain(e.time);
  });

  it('is the same for the same analysis, and seeded from it', () => {
    expect(buildLevelMap(randomAnalysis(7, { tempo: 128, duration: 60 }))).toEqual(map);
    expect(buildLevelMap(randomAnalysis(8, { tempo: 128, duration: 60 })).seed).not.toBe(map.seed);
  });

  it('copes with a song without beats', () => {
    const silent = { ...analysis, beats: [], downbeats: [], tempo: 0 };
    const empty = buildLevelMap(silent);
    expect(empty.beatPeriod).toBeCloseTo(0.5);
    expect(empty.beats.length).toBe(120);
  });
});
