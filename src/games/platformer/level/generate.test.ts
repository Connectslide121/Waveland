import { afterEach, describe, expect, it } from 'vitest';
import { buildLevelMap, DIFFICULTIES, type Difficulty, type LevelMap } from '../../../core';
import { randomAnalysis } from '../../../core/test-analysis';
import { bridgeWindows, DIFFICULTY, generateLevel, MAX_JUMP, MAX_TOP, MIN_TOP } from './generate';
import { solidTop, type PlatformerLevel } from './level';
import { validateLevel } from './validate';

const maps = new Map<number, LevelMap>();
/** A random song of 30 to 45 s (short, to keep the search quick), cached per seed. */
function song(seed: number): LevelMap {
  let map = maps.get(seed);
  if (!map) {
    map = buildLevelMap(randomAnalysis(seed, { duration: 30 + (seed % 4) * 5 }));
    maps.set(seed, map);
  }
  return map;
}

const levels = new Map<string, PlatformerLevel>();
function level(seed: number, difficulty: Difficulty): PlatformerLevel {
  const key = `${seed}:${difficulty}`;
  let found = levels.get(key);
  if (!found) {
    found = generateLevel(song(seed), difficulty);
    levels.set(key, found);
  }
  return found;
}

/** Widths of the pits in a level's gap stretches. */
function pitWidths(l: PlatformerLevel): number[] {
  const widths: number[] = [];
  for (const c of l.chunks.filter((x) => x.kind === 'gap')) {
    const inside = l.solids.filter((s) => s.x0 >= c.x0 - 1e-6 && s.x1 <= c.x1 + 1e-6);
    for (let i = 1; i < inside.length; i++) {
      const pit = inside[i]!.x0 - inside[i - 1]!.x1;
      if (pit > 1 && inside[i]!.kind !== 'ledge' && inside[i - 1]!.kind !== 'ledge')
        widths.push(pit);
    }
  }
  return widths;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const HAZARDS = new Set(['gap', 'eq', 'bridge', 'spikes', 'drop']);

describe('generateLevel: always completable', () => {
  // Random songs at every tempo and shape; each difficulty in turn.
  for (let seed = 1; seed <= 12; seed++) {
    const difficulty = DIFFICULTIES[seed % 3]!;
    it(`song ${seed} (${difficulty}) can be finished`, () => {
      const l = level(seed, difficulty);
      const check = validateLevel(l);
      expect(check.ok, `stuck at ${check.reached.toFixed(2)} s`).toBe(true);
    });
  }

  it('keeps the layout in order and in bounds', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const l = level(seed, DIFFICULTIES[seed % 3]!);
      for (let i = 1; i < l.solids.length; i++)
        expect(l.solids[i]!.x0).toBeGreaterThanOrEqual(l.solids[i - 1]!.x0);
      for (const s of l.solids) {
        expect(s.x1).toBeGreaterThan(s.x0);
        if (s.kind !== 'eq') {
          expect(s.top).toBeGreaterThanOrEqual(MIN_TOP);
          expect(s.top).toBeLessThanOrEqual(MAX_TOP);
        }
      }
      // The stretches follow each other in time and space, and cover the whole song.
      expect(l.chunks[0]!.start).toBe(0);
      expect(l.chunks[l.chunks.length - 1]!.end).toBe(l.duration);
      for (let i = 1; i < l.chunks.length; i++) {
        expect(l.chunks[i]!.start).toBeCloseTo(l.chunks[i - 1]!.end, 6);
        expect(l.chunks[i]!.x0).toBeCloseTo(l.chunks[i - 1]!.x1, 6);
      }
    }
  });
});

describe('generateLevel: the music', () => {
  let drops = 0;
  // Longer songs with drops (one has two, one comes early), and fast ones, whose bars are
  // too short for a staircase in two.
  const songs: [number, number | undefined][] = [
    [102, undefined],
    [103, undefined],
    [114, undefined],
    [124, undefined],
    [102, 174],
    [103, 174],
  ];
  for (const [seed, tempo] of songs) {
    it(`builds a staircase set piece with gems at every drop (song ${seed}${tempo ? ` at ${tempo} BPM` : ''})`, () => {
      const map = buildLevelMap(randomAnalysis(seed, { duration: 80, tempo }));
      const l = generateLevel(map, DIFFICULTIES[seed % 3]!);
      const runIn = l.chunks[0]!.end;
      const runOut = l.chunks[l.chunks.length - 1]!.start;
      for (const e of map.events.filter((x) => x.kind === 'drop')) {
        // Drops with room for a set piece: after the run-in, four bars before the run-out.
        if (e.time < runIn || e.time > runOut - 16 * map.beatPeriod) continue;
        drops++;
        const piece = l.chunks.find((c) => c.kind === 'drop' && c.start >= e.time - 1e-6);
        expect(piece, `drop at ${e.time.toFixed(2)} s`).toBeDefined();
        expect(piece!.start - e.time).toBeLessThan(4 * map.beatPeriod + 1e-6);
        const steps = l.solids.filter(
          (s) => s.kind === 'step' && s.x0 >= piece!.x0 && s.x1 <= piece!.x1 + 1e-6,
        );
        expect(steps.length).toBeGreaterThanOrEqual(3);
        for (let i = 1; i < steps.length; i++)
          expect(steps[i]!.top).toBeGreaterThanOrEqual(steps[i - 1]!.top);
        const gems = l.pickups.filter(
          (p) => p.kind === 'gem' && p.time >= piece!.start && p.time < piece!.end,
        );
        expect(gems.length).toBeGreaterThanOrEqual(steps.length);
      }
    }, 20_000);
  }

  it('had drops to check', () => expect(drops).toBeGreaterThanOrEqual(6));

  it('keeps breakdowns calm: no spikes, equalisers or bridges', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const l = level(seed, DIFFICULTIES[seed % 3]!);
      for (const c of l.chunks.filter((x) => x.section === 'breakdown'))
        expect(['calm', 'flat', 'gap', 'drop']).toContain(c.kind);
    }
  });

  it('puts coins on the hi-hats (on the beats where there are none), and bridges only where there are snares', () => {
    const map = song(5);
    const l = level(5, 'normal');
    const hatTimes = map.events.filter((e) => e.kind === 'hat').map((e) => e.time);
    const hats = new Set(hatTimes);
    for (const p of l.pickups.filter((x) => x.kind === 'coin')) {
      if (hats.has(p.time)) continue;
      // Not on a hat: on a beat with no hat within a beat of it.
      expect(map.beats).toContain(p.time);
      expect(hatTimes.every((t) => Math.abs(t - p.time) > map.beatPeriod)).toBe(true);
    }
    expect(l.pickups.some((p) => p.kind === 'coin' && hats.has(p.time))).toBe(true);
    const snares = map.events.filter((e) => e.kind === 'snare').map((e) => e.time);
    for (const s of l.solids.filter((x) => x.kind === 'bridge'))
      for (const [from] of s.windows!) expect(snares).toContain(from);
  });

  it('keeps coins apart from each other and from the gems, even on fast hats', () => {
    const map = buildLevelMap(randomAnalysis(102, { duration: 80, tempo: 174 }));
    const l = generateLevel(map, 'hard');
    const coins = l.pickups.filter((p) => p.kind === 'coin').map((p) => p.x);
    const gems = l.pickups.filter((p) => p.kind === 'gem').map((p) => p.x);
    expect(coins.length).toBeGreaterThan(0);
    const sorted = [...coins].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++)
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(26 - 1e-6);
    for (const c of coins)
      for (const g of gems) expect(Math.abs(c - g)).toBeGreaterThanOrEqual(26 - 1e-6);
  });

  it('puts coins on the beats of a song with no hi-hats', () => {
    const map = song(5);
    const quiet = { ...map, events: map.events.filter((e) => e.kind !== 'hat') };
    const l = generateLevel(quiet, 'normal');
    const coins = l.pickups.filter((p) => p.kind === 'coin');
    expect(coins.length).toBeGreaterThan(map.beats.length / 4);
    for (const c of coins) expect(map.beats).toContain(c.time);
  });

  it('moves the equalisers with the bass', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const map = song(seed);
      const l = level(seed, DIFFICULTIES[seed % 3]!);
      for (const s of l.solids.filter((x) => x.kind === 'eq')) {
        const { times, tops } = s.keys!;
        const base = Math.min(...tops);
        for (let i = 0; i < times.length; i++) {
          const beat = map.beats.indexOf(times[i]!);
          expect(beat).toBeGreaterThanOrEqual(0);
          // Louder bass, higher column: the rise is the bass level times the column's shape.
          if (map.bass[beat] === 0) expect(tops[i]).toBeCloseTo(base, 6);
        }
      }
    }
  });
});

describe('generateLevel: bridges come and go', () => {
  const saved = { ...DIFFICULTY.normal };
  afterEach(() => Object.assign(DIFFICULTY.normal, saved));

  /** A rock song: the snare exactly on 2 and 4 of every bar, doubled on the "and" of 4 when asked. */
  function backbeat(seed: number, doubled: boolean): LevelMap {
    const map = buildLevelMap(randomAnalysis(seed, { duration: 60, tempo: 150 }));
    const snares = map.beats.flatMap((t, i) => {
      const inBar = (((i - map.barPhase) % 4) + 4) % 4;
      if (inBar === 1) return [t];
      if (inBar === 3) return doubled ? [t, t + map.beatPeriod / 2] : [t];
      return [];
    });
    const events = [
      ...map.events.filter((e) => e.kind !== 'snare'),
      ...snares.map((time) => ({ kind: 'snare' as const, time, intensity: 1 })),
    ].sort((a, b) => a.time - b.time);
    return { ...map, events };
  }

  for (const doubled of [false, true])
    it(`leaves every bridge gone for at least a beat between its windows (snares on 2 and 4${doubled ? ', doubled' : ''})`, () => {
      // Every busy bar an obstacle, so there are bridges to check.
      DIFFICULTY.normal.hazard = 1;
      let checked = 0;
      for (const seed of [21, 22, 23]) {
        const map = backbeat(seed, doubled);
        const l = generateLevel(map, 'normal');
        expect(validateLevel(l).ok).toBe(true);
        for (const bridge of l.solids.filter((s) => s.kind === 'bridge')) {
          const windows = bridge.windows!;
          expect(windows.length).toBeGreaterThan(0);
          for (let i = 1; i < windows.length; i++) {
            const gone = windows[i]![0] - windows[i - 1]![1];
            expect(gone).toBeGreaterThanOrEqual(map.beatPeriod - 1e-6);
            // Not there anywhere in the gap.
            for (let k = 1; k < 8; k++)
              expect(solidTop(bridge, windows[i - 1]![1] + (gone * k) / 8)).toBeNull();
            checked++;
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
    }, 20_000);

  it('keeps each window on a snare, the bridge there on it', () => {
    const snares = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((b) => b * 0.5);
    // Snares on every beat (0.5 s), held 1.5 beats: the bridge's own snare at 2 s, then
    // only snares a full beat after a window ends, either way.
    expect(bridgeWindows(snares, 2, 0.75, 0.5)).toEqual([
      [0.5, 1.25],
      [2, 2.75],
      [3.5, 4.25],
    ]);
  });
});

describe('generateLevel: seeds and difficulty', () => {
  it('gives the same level for the same song and difficulty', () => {
    expect(generateLevel(song(3), 'hard')).toEqual(level(3, 'hard'));
  });

  it('gives another level at another difficulty, or for another song', () => {
    expect(level(3, 'easy')).not.toEqual(level(3, 'hard'));
    expect(level(3, 'easy').seed).not.toBe(level(3, 'hard').seed);
    expect(level(4, 'hard').seed).not.toBe(level(3, 'hard').seed);
  });

  it('makes hard levels busier, with wider gaps, than easy ones', () => {
    const stats = (d: Difficulty) => {
      const ls = [1, 2, 3, 4, 5, 6].map((s) => level(s, d));
      const chunks = ls.flatMap((l) => l.chunks);
      return {
        hazards: chunks.filter((c) => HAZARDS.has(c.kind)).length / chunks.length,
        gap: mean(ls.flatMap(pitWidths)),
        spikes: mean(ls.flatMap((l) => l.spikes.map((s) => (s.x1 - s.x0) / l.speed))),
      };
    };
    const easy = stats('easy');
    const hard = stats('hard');
    expect(hard.hazards).toBeGreaterThan(easy.hazards);
    expect(hard.gap).toBeGreaterThan(easy.gap);
    expect(hard.spikes).toBeGreaterThan(easy.spikes);
  });
});

describe('generateLevel: repairs', () => {
  const saved = { ...DIFFICULTY.hard };
  afterEach(() => Object.assign(DIFFICULTY.hard, saved));

  it('makes impossible gaps and steps passable', () => {
    // Gaps far wider than any jump and towering staircase steps.
    Object.assign(DIFFICULTY.hard, { hazard: 1, gap: 1.6, stepRise: 200, rise: 300 });
    const l = generateLevel(song(5), 'hard');
    expect(validateLevel(l).ok).toBe(true);
    expect(l.chunks.reduce((n, c) => n + c.repairs, 0)).toBeGreaterThan(0);
    for (const width of pitWidths(l)) expect(width).toBeLessThan(MAX_JUMP);
  });
});
