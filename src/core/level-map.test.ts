import { describe, expect, it } from 'vitest';
import { beatFit, buildLevelMap, fitBeatGrid } from './level-map';
import { beatAt, beatIndexAt, periodAt, tempoAt, timeOfBeat } from './tempo-map';
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
    expect(beatFit({ beats: at(128, 0.3, 200), tempo: 128, duration: 95 })).toBe('steady');
  });

  it('calls a song changing when its tempo map moves from 100 to 130 BPM', () => {
    const slow = at(100, 0.3, 64);
    const change = slow.at(-1)! + 0.6;
    const fast = at(130, change, 128);
    const segments = [
      { start: 0, end: change, tempo: 100, beatPeriod: 0.6 },
      { start: change, end: 100, tempo: 130, beatPeriod: 60 / 130 },
    ];
    expect(beatFit({ beats: [...slow, ...fast], tempo: 130, duration: 100, segments })).toBe(
      'changing',
    );
  });

  it('calls a beat loose when it drifts off its one grid', () => {
    const slow = at(100, 0.3, 64);
    const fast = at(130, slow.at(-1)! + 0.6, 128);
    expect(beatFit({ beats: [...slow, ...fast], tempo: 100, duration: 100 })).toBe('loose');
  });

  it('finds no beat in a song with hardly any', () => {
    expect(beatFit({ beats: [], tempo: 120, duration: 60 })).toBe('none');
    expect(beatFit({ beats: at(120, 0, 5), tempo: 120, duration: 60 })).toBe('none');
  });
});

describe('buildLevelMap', () => {
  const analysis = randomAnalysis(7, { tempo: 128, duration: 60 });
  const map = buildLevelMap(analysis);

  const period = periodAt(map, 0);

  it('puts a regular beat grid over the whole song, as one tempo segment', () => {
    expect(map.segments).toEqual([{ start: 0, end: 60, tempo: map.tempo, beatPeriod: period }]);
    expect(map.beats[0]).toBeGreaterThanOrEqual(0);
    expect(map.beats[0]).toBeLessThan(period);
    expect(map.beats[map.beats.length - 1]).toBeLessThan(60);
    expect(map.beats[map.beats.length - 1]! + period).toBeGreaterThanOrEqual(60);
    expect(map.tempo).toBeCloseTo(128, 0);
    for (let i = 1; i < map.beats.length; i++)
      expect(map.beats[i]! - map.beats[i - 1]!).toBeCloseTo(period, 6);
  });

  it('reads the steady grid as the straight line it is', () => {
    for (const t of [0, 0.37, 12.5, 59.9]) {
      expect(beatAt(map, t)).toBe((t - map.beats[0]!) / period);
      expect(timeOfBeat(map, beatAt(map, t))).toBeCloseTo(t, 9);
    }
    map.beats.forEach((t, i) => expect(timeOfBeat(map, i)).toBe(t));
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
    expect(count('offbeat')).toBe(map.beats.filter((t) => t + period / 2 < 60).length);
    expect(count('drop')).toBe(analysis.drops.length);
    expect(count('section')).toBe(analysis.sections.length);
    for (let i = 1; i < map.events.length; i++)
      expect(map.events[i]!.time).toBeGreaterThanOrEqual(map.events[i - 1]!.time);
    for (const e of map.events) expect(e.beat).toBe(beatIndexAt(map, e.time));
  });

  it('puts snares on the eighth-note grid', () => {
    for (const e of map.events.filter((x) => x.kind === 'snare')) {
      const eighths = (e.time - map.beats[0]!) / (period / 2);
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
    const silent = { ...analysis, beats: [], downbeats: [], tempo: 0, segments: [] };
    const empty = buildLevelMap(silent);
    expect(periodAt(empty, 0)).toBeCloseTo(0.5);
    expect(empty.beats.length).toBe(120);
  });
});

describe('buildLevelMap with tempo changes', () => {
  const analysis = randomAnalysis(11, {
    tempo: 120,
    duration: 80,
    changes: [
      { time: 30, tempo: 150 },
      { time: 55, tempo: 75 },
    ],
  });
  const map = buildLevelMap(analysis);
  const changeAt = (i: number) => analysis.segments[i]!.start;

  it('has a segment per tempo, each starting on a grid beat near its change', () => {
    expect(map.segments.map((s) => Math.round(s.tempo))).toEqual([120, 150, 75]);
    expect(map.segments[0]!.start).toBe(0);
    expect(map.segments.at(-1)!.end).toBe(80);
    map.segments.slice(1).forEach((s, i) => {
      expect(map.beats).toContain(s.start);
      expect(Math.abs(s.start - changeAt(i + 1))).toBeLessThan(0.03);
      expect(map.segments[i]!.end).toBe(s.start);
    });
  });

  it('keeps every grid beat within 30 ms of a tracked beat, with none skipped or doubled', () => {
    for (const t of map.beats) {
      if (t < analysis.beats[0]! - 0.1 || t > analysis.beats.at(-1)! + 0.1) continue;
      const nearest = Math.min(...analysis.beats.map((b) => Math.abs(b - t)));
      expect(nearest).toBeLessThan(0.03);
    }
    for (let i = 1; i < map.beats.length; i++) {
      const gap = map.beats[i]! - map.beats[i - 1]!;
      const period = periodAt(map, map.beats[i - 1]!);
      expect(gap / period).toBeGreaterThan(0.5);
      expect(gap / period).toBeLessThan(1.5);
    }
  });

  it('reads beats, periods and tempos through the changes', () => {
    expect(tempoAt(map, 10)).toBeCloseTo(120, 0);
    expect(tempoAt(map, 40)).toBeCloseTo(150, 0);
    expect(tempoAt(map, 70)).toBeCloseTo(75, 0);
    // beatAt counts every grid beat once and goes up steadily.
    map.beats.forEach((t, i) => expect(beatAt(map, t)).toBeCloseTo(i, 9));
    let last = -Infinity;
    for (let t = 0; t < 80; t += 0.05) {
      const b = beatAt(map, t);
      expect(b).toBeGreaterThan(last);
      expect(timeOfBeat(map, b)).toBeCloseTo(t, 9);
      last = b;
    }
  });

  it('starts bars afresh in each segment', () => {
    for (const s of map.segments.slice(1)) {
      const first = map.beats.indexOf(s.start);
      const inSegment = map.downbeats.filter((d) => d >= s.start && d < s.end);
      expect(inSegment.length).toBeGreaterThan(0);
      expect(map.beats.indexOf(inSegment[0]!) - first).toBeLessThan(4);
    }
  });
});
