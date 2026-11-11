import { describe, expect, it } from 'vitest';
import {
  beatAt,
  beatIndexAt,
  buildLevelMap,
  DIFFICULTIES,
  timeOfBeat,
  type Difficulty,
  type LevelEvent,
  type LevelMap,
  type MusicFeatures,
} from '../../../core';
import { randomAnalysis } from '../../../core/test-analysis';
import { DIFFICULTY, generateLevel, laneWindow, leanedLane } from './generate';
import type { Obstacle, TunnelTrack } from './track';
import { validateLevel } from './validate';

/**
 * The rules about where obstacles go: only on the pulse a player can count (easy and
 * normal), the song's texture is not a moment, a part keeps its pattern from phrase to
 * phrase, a busy bar always has something, and on easy a block more often stands where the
 * racer is.
 */

/** A steady 120 BPM groove of 20 bars (40 s) with nothing in it, to put hits into. */
function quiet(energy = 0.7): LevelMap {
  const map = buildLevelMap(
    randomAnalysis(11, {
      duration: 40,
      tempo: 120,
      sections: [{ bars: 40, kind: 'main', energy: 0.7 }],
    }),
  );
  return {
    ...map,
    energy: map.energy.map(() => energy),
    events: map.events.filter((e) => e.kind === 'section' || e.kind === 'offbeat'),
    drops: [],
    features: {
      sustains: [],
      stops: [],
      accents: [],
      fills: [],
      syncopations: [],
      bars: map.features.bars.map((b, i) => ({ ...b, repeats: i, similarity: 1 })),
    },
  };
}

const at = (map: LevelMap, bar: number, beat = 0) =>
  timeOfBeat(map, map.beats.indexOf(map.downbeats[bar]!) + beat);

function withHits(
  map: LevelMap,
  hitsAt: { time: number; kind: 'kick' | 'snare'; intensity: number }[],
  features: Partial<MusicFeatures> = {},
): LevelMap {
  const events: LevelEvent[] = [
    ...map.events,
    ...hitsAt.map((h) => ({ ...h, beat: beatIndexAt(map, h.time) })),
  ].sort((a, b) => a.time - b.time);
  return { ...map, events, features: { ...map.features, ...features } };
}

/** How far a time is from the nearest beat or "and", in beats. */
const offPulse = (map: LevelMap, time: number) => {
  const eighths = beatAt(map, time) * 2;
  return Math.abs(eighths - Math.round(eighths)) / 2;
};

const ofKind = (track: TunnelTrack, ...kinds: Obstacle['kind'][]) =>
  track.obstacles.filter((o) => kinds.includes(o.kind));

describe('presses on the pulse', () => {
  /** Kicks and snares on every sixteenth of a bar, plus accents on the sixteenths. */
  const dense = () => {
    const map = quiet(1);
    const list: { time: number; kind: 'kick' | 'snare'; intensity: number }[] = [];
    const accents: { time: number; strength: number }[] = [];
    for (let bar = 3; bar < 17; bar++)
      for (let k = 0; k < 16; k++) {
        const time = at(map, bar, k / 4);
        list.push({ time, kind: k % 8 === 4 ? 'snare' : 'kick', intensity: 0.9 });
      }
    for (let bar = 4; bar < 17; bar += 3) accents.push({ time: at(map, bar, 1.25), strength: 0.5 });
    return withHits(map, list, { accents });
  };

  it('puts kicks, snares and accent walls on a beat or an "and" on easy and normal', () => {
    const map = dense();
    for (const d of ['easy', 'normal'] as Difficulty[]) {
      const track = generateLevel(map, d);
      const placed = ofKind(track, 'kick', 'snare', 'wall', 'low');
      expect(placed.length, d).toBeGreaterThan(10);
      for (const o of placed)
        expect(offPulse(map, o.time), `${d} ${o.kind}`).toBeLessThanOrEqual(0.08);
      expect(validateLevel(track).ok).toBe(true);
    }
  });

  it('lets hard use the sixteenths too, accent walls included', () => {
    const map = dense();
    const track = generateLevel(map, 'hard');
    expect(ofKind(track, 'kick', 'snare').some((o) => offPulse(map, o.time) > 0.08)).toBe(true);
    expect(ofKind(track, 'wall', 'low').some((o) => offPulse(map, o.time) > 0.08)).toBe(true);
    expect(DIFFICULTY.hard.sixteenths).toBe(true);
    expect(DIFFICULTY.easy.sixteenths || DIFFICULTY.normal.sixteenths).toBe(false);
  });

  it('gives no sliding block to a syncopation that is the song’s texture', () => {
    const map = quiet();
    // Three off-beat hits a bar for 9 bars: the texture. One a bar: moments.
    const texture = [3, 4, 5, 6, 7, 8, 9, 10, 11].flatMap((bar) =>
      [0.5, 1.5, 2.5].map((beat) => ({ time: at(map, bar, beat), strength: 0.8 })),
    );
    const rare = [3, 4, 5, 6, 7, 8, 9, 10, 11].map((bar) => ({
      time: at(map, bar, 1.5),
      strength: 0.8,
    }));
    expect(
      ofKind(generateLevel(withHits(map, [], { syncopations: texture }), 'hard'), 'slide'),
    ).toEqual([]);
    expect(
      ofKind(generateLevel(withHits(map, [], { syncopations: rare }), 'hard'), 'slide').length,
    ).toBeGreaterThan(0);
  });

  it('keeps a bar’s pattern from the bar a phrase back, then the beat, then the strength', () => {
    const map = quiet(0.2);
    // Four kicks a bar, as many as it holds: which ones are picked depends on the order.
    const list: { time: number; kind: 'kick'; intensity: number }[] = [];
    for (let bar = 3; bar < 17; bar++)
      for (let k = 0; k < 4; k++) {
        // The strengths differ from bar to bar, so strength alone would pick differently.
        const intensity = 0.6 + 0.3 * (((bar * 7 + k * 3) % 5) / 4);
        list.push({ time: at(map, bar, k), kind: 'kick', intensity });
      }
    // An "and" as strong as any, which the beats come before.
    for (let bar = 3; bar < 17; bar++)
      list.push({ time: at(map, bar, 1.5), kind: 'kick', intensity: 1 });
    const track = generateLevel(withHits(map, list), 'hard');
    const offsets = (bar: number) =>
      ofKind(track, 'kick')
        .filter((o) => o.time >= at(map, bar) - 1e-6 && o.time < at(map, bar + 1) - 1e-6)
        .map((o) => Math.round((beatAt(map, o.time) - beatAt(map, at(map, bar))) * 4) / 4);
    let same = 0;
    let bars = 0;
    for (let bar = 7; bar < 17; bar++) {
      const [now, before] = [offsets(bar), offsets(bar - 4)];
      if (now.length === 0 || before.length === 0) continue;
      bars++;
      // The smaller pattern is part of the larger.
      const [small, large] = now.length <= before.length ? [now, before] : [before, now];
      if (small.every((b) => large.includes(b))) same++;
    }
    expect(bars).toBeGreaterThan(5);
    expect(same / bars).toBeGreaterThan(0.8);
    // On the beat before the "and" where the bar has to leave one out: no "and" comes in a
    // bar that left a beat out.
    const ands = ofKind(track, 'kick').filter(
      (o) => offPulse(map, o.time) === 0 && beatAt(map, o.time) % 1 !== 0,
    );
    const beatsPicked = ofKind(track, 'kick').filter((o) => beatAt(map, o.time) % 1 === 0);
    expect(beatsPicked.length).toBeGreaterThan(ands.length);
  });
});

describe('a floor for busy bars', () => {
  /** Two kicks a bar in a quiet song: the music's own activity asks for no obstacle at all. */
  const sparse = () => {
    const map = quiet(0);
    const list: { time: number; kind: 'kick'; intensity: number }[] = [];
    for (let bar = 3; bar < 17; bar++)
      for (const k of [0, 2]) list.push({ time: at(map, bar, k), kind: 'kick', intensity: 0.9 });
    return withHits(map, list);
  };

  it('puts at least the difficulty’s share of obstacles in every busy bar, more on hard', () => {
    const map = sparse();
    const per = (d: Difficulty) => ofKind(generateLevel(map, d), 'kick').length / 14;
    expect(per('easy')).toBeGreaterThanOrEqual(DIFFICULTY.easy.busyFloor - 0.15);
    expect(per('normal')).toBeGreaterThanOrEqual(DIFFICULTY.normal.busyFloor - 0.15);
    expect(per('hard')).toBeGreaterThanOrEqual(1.5);
    expect(per('easy')).toBeLessThan(per('normal'));
    expect(per('normal')).toBeLessThan(per('hard'));
    for (const d of DIFFICULTIES) expect(validateLevel(generateLevel(map, d)).ok).toBe(true);
  });

  it('leaves a bar with no moment of its own empty', () => {
    const map = quiet(0);
    expect(generateLevel(map, 'hard').obstacles).toEqual([]);
  });
});

describe('blocks lean toward where the racer is', () => {
  it('puts a share of kick blocks in the centre lane, more on easy, a pure function of the pick', () => {
    const centre = (lean: number, lanes: number) => {
      let n = 0;
      for (let i = 0; i < 1000; i++)
        if (leanedLane((i + 0.5) / 1000, lanes, lean) === (lanes - 1) / 2) n++;
      return n / 1000;
    };
    expect(centre(0, 5)).toBeCloseTo(0.2, 1);
    expect(centre(DIFFICULTY.easy.lean, 3)).toBeGreaterThan(0.59);
    expect(centre(DIFFICULTY.easy.lean, 3)).toBeGreaterThan(centre(DIFFICULTY.normal.lean, 5));
    expect(leanedLane(0.99, 3, 0.4)).toBe(2);
    expect(leanedLane(0, 3, 0.4)).toBe(1);
    for (let i = 0; i < 100; i++) {
      const lane = leanedLane(i / 100, 5, 0.2);
      expect(lane >= 0 && lane < 5).toBe(true);
    }
  });

  it('stands more of easy’s kick blocks in the middle lane than a plain pick would', () => {
    const map = quiet(1);
    const list: { time: number; kind: 'kick'; intensity: number }[] = [];
    for (let bar = 3; bar < 17; bar++)
      for (const k of [0, 2]) list.push({ time: at(map, bar, k), kind: 'kick', intensity: 0.9 });
    const track = generateLevel(withHits(map, list), 'easy');
    const kicks = ofKind(track, 'kick');
    expect(kicks.length).toBeGreaterThan(8);
    const share =
      kicks.filter((o) => o.lanes.length === 1 && o.lanes[0] === 1).length / kicks.length;
    expect(share).toBeGreaterThan(0.45);
  });

  it('opens windows of lanes that always hold the line', () => {
    for (let lanes = 3; lanes <= 5; lanes += 2)
      for (let line = 0; line < lanes; line++)
        for (let width = 1; width <= lanes; width++) {
          const open = laneWindow(line, width, lanes);
          expect(open).toHaveLength(width);
          expect(open).toContain(line);
          expect(open[0]!).toBeGreaterThanOrEqual(0);
          expect(open[open.length - 1]!).toBeLessThan(lanes);
        }
  });
});
