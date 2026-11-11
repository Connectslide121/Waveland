import { describe, expect, it } from 'vitest';
import {
  beatAt,
  buildLevelMap,
  DIFFICULTIES,
  timeOfBeat,
  type Difficulty,
  type LevelMap,
} from '../../../core';
import { analyseSamples } from '../../../core/analysis/analyse';
import { electroSong, rockSong } from '../../../core/analysis/test-songs';
import { randomAnalysis } from '../../../core/test-analysis';
import { hits } from '../physics';
import { DROP_BARS, generateLevel } from './generate';
import type { TunnelTrack } from './track';
import { validateLevel } from './validate';

/**
 * The booster pickups, boost hoops and the build's squeeze: what the generator puts on the
 * music's moments besides obstacles. None of them may be needed: the validator never sees
 * them.
 */

const fromSong = (make: typeof rockSong) => {
  const song = make();
  return buildLevelMap(analyseSamples(song.samples, song.rate));
};

/** A 128 BPM random song with drops. */
const dropSong = () =>
  buildLevelMap(
    randomAnalysis(21, {
      tempo: 128,
      sections: [
        { bars: 4, kind: 'intro', energy: 0.3 },
        { bars: 8, kind: 'build', energy: 0.6 },
        { bars: 12, kind: 'drop', energy: 1 },
        { bars: 4, kind: 'breakdown', energy: 0.3 },
        { bars: 8, kind: 'build', energy: 0.6 },
        { bars: 12, kind: 'drop', energy: 1 },
        { bars: 4, kind: 'outro', energy: 0.3 },
      ],
    }),
  );

const songs: [string, LevelMap][] = [
  ['the rock stand-in', fromSong(rockSong)],
  ['the electronic track', fromSong(electroSong)],
  ['a random song with drops', dropSong()],
];

const tracks = new Map<string, TunnelTrack>();
const trackOf = (name: string, map: LevelMap, d: Difficulty) => {
  const key = `${name}:${d}`;
  let t = tracks.get(key);
  if (!t) tracks.set(key, (t = generateLevel(map, d)));
  return t;
};

const barsBetween = (map: LevelMap, from: number, to: number) =>
  map.downbeats.filter((d) => d >= from - 1e-6 && d < to - 1e-6).length;

/** Whether song time `t` is in a drop's set piece. */
const inSetPiece = (map: LevelMap, t: number) =>
  map.events.some((e) => {
    if (e.kind !== 'drop') return false;
    const start = map.downbeats.find((x) => x >= e.time - 1e-6)!;
    return t >= start - 1e-6 && t < timeOfBeat(map, beatAt(map, start) + 4 * DROP_BARS);
  });

const feelAt = (t: TunnelTrack, time: number) =>
  t.looks.find((l) => time >= l.start && time < l.end)!.feel;

describe.each(songs)('boosters on %s', (name, map) => {
  it.each(DIFFICULTIES)('are one a section at most, several bars apart (%s)', (d) => {
    const t = trackOf(name, map, d);
    expect(t.boosters.length).toBeGreaterThan(0);
    for (const look of t.looks)
      expect(
        t.boosters.filter((b) => b.time >= look.start && b.time < look.end).length,
      ).toBeLessThanOrEqual(1);
    for (let i = 1; i < t.boosters.length; i++) {
      const gap = barsBetween(map, t.boosters[i - 1]!.time, t.boosters[i]!.time);
      expect(gap).toBeGreaterThanOrEqual(6);
      expect(t.boosters[i]!.kind).not.toBe(t.boosters[i - 1]!.kind);
    }
  });

  it.each(DIFFICULTIES)('sit on a downbeat of a section’s first phrase, in the light (%s)', (d) => {
    const t = trackOf(name, map, d);
    for (const b of t.boosters) {
      expect(map.downbeats.some((x) => Math.abs(x - b.time) < 1e-6)).toBe(true);
      const look = t.looks.find((l) => b.time >= l.start && b.time < l.end)!;
      // One of the first four bars that are free (a stop or a drop's set piece isn't).
      const free = map.downbeats.filter(
        (x) =>
          x >= look.start - 1e-6 &&
          x >= (map.downbeats.find((d) => d >= 3) ?? 0) + 2 &&
          x < b.time - 1e-6 &&
          !t.dark.some((k) => x >= k.time - 0.5 && x < k.end + 0.1) &&
          !inSetPiece(map, x),
      );
      expect(free.length).toBeLessThan(4);
      expect(t.dark.some((x) => b.time >= x.time - 0.5 && b.time < x.end + 0.1)).toBe(false);
      expect(inSetPiece(map, b.time)).toBe(false);
    }
  });

  it.each(DIFFICULTIES)('and hoops stand clear of every obstacle in their lane (%s)', (d) => {
    const t = trackOf(name, map, d);
    for (const b of [...t.boosters, ...t.hoops])
      for (const o of t.obstacles)
        if (Math.abs(o.time - b.time) <= 0.3)
          expect(hits(o, b.lane, 0, o.time), `at ${b.time.toFixed(2)}`).toBe(false);
  });

  it('are never needed: the track is raced clean without them', () => {
    const t = trackOf(name, map, 'normal');
    expect(validateLevel({ ...t, boosters: [], hoops: [] }).ok).toBe(true);
    expect(validateLevel(t).ok).toBe(true);
  });
});

describe('what each section feel gets as a booster', () => {
  it('gives a build a shield, and a chorus or a drop a surge', () => {
    const t = trackOf('the electronic track', fromSong(electroSong), 'normal');
    const kinds = t.boosters.map((b) => [feelAt(t, b.time), b.kind]);
    expect(kinds).toContainEqual(['build', 'shield']);
    expect(kinds).toContainEqual(['drop', 'surge']);
  });
});

describe('boost hoops', () => {
  it('are four in a row on the downbeats of a chorus’s or a drop’s phrase, a lane apart at most', () => {
    let phrases = 0;
    for (const [name, map] of songs)
      for (const d of DIFFICULTIES) {
        const t = trackOf(name, map, d);
        const groups = new Map<number, TunnelTrack['hoops']>();
        for (const h of t.hoops.filter((x) => x.kind === 'phrase')) {
          groups.set(h.group, [...(groups.get(h.group) ?? []), h]);
          expect(['chorus', 'drop']).toContain(feelAt(t, h.time));
          expect(map.downbeats.some((x) => Math.abs(x - h.time) < 1e-6)).toBe(true);
        }
        for (const hoops of groups.values()) {
          phrases++;
          expect(hoops.map((h) => h.slot)).toEqual([0, 1, 2, 3]);
          expect(hoops.every((h) => h.size === 4)).toBe(true);
          for (let i = 1; i < hoops.length; i++) {
            expect(Math.abs(hoops[i]!.lane - hoops[i - 1]!.lane)).toBeLessThanOrEqual(1);
            expect(barsBetween(map, hoops[i - 1]!.time, hoops[i]!.time)).toBe(1);
          }
        }
      }
    expect(phrases).toBeGreaterThan(5);
  });

  it('end a fill’s slalom on the bar line, in a lane its last block leaves open', () => {
    const map = fromSong(rockSong);
    const t = trackOf('the rock stand-in', map, 'normal');
    const fillHoops = t.hoops.filter((h) => h.kind === 'fill');
    expect(fillHoops.length).toBeGreaterThan(0);
    for (const h of fillHoops) {
      const fill = map.features.fills.find((f) => Math.abs(f.end - h.time) < 1e-6)!;
      expect(fill).toBeDefined();
      const slalom = t.obstacles.filter(
        (o) => o.kind === 'slalom' && o.time >= fill.time - 1e-6 && o.time < fill.end - 1e-6,
      );
      const last = slalom[slalom.length - 1]!;
      expect(hits(last, h.lane, 0, last.time)).toBe(false);
      expect(h.size).toBe(1);
    }
  });
});

describe('the squeeze at the end of a build', () => {
  it.each(DIFFICULTIES)(
    'narrows in three walls with a line of gems down the open lane (%s)',
    (d) => {
      const map = fromSong(electroSong);
      const t = trackOf('the electronic track', map, d);
      const walls = t.obstacles.filter((o) => o.kind === 'squeeze');
      // Two builds, three walls each.
      expect(walls).toHaveLength(6);
      for (let g = 0; g < 2; g++) {
        const layer = walls.slice(g * 3, g * 3 + 3);
        const open = layer.map((o) =>
          Array.from({ length: t.lanes }, (_, k) => k).filter((k) => !o.lanes.includes(k)),
        );
        // Each wall leaves no more open than the one before, and one lane stays open in all.
        for (let i = 1; i < 3; i++)
          expect(open[i]!.length).toBeLessThanOrEqual(open[i - 1]!.length);
        const line = open[0]!.filter((k) => open.every((o) => o.includes(k)));
        expect(line.length).toBeGreaterThan(0);
        // On beats 1, 2 and 3 of the build's last bar, which ends where the section ends.
        const section = t.looks.find((l) => layer[0]!.time >= l.start && layer[0]!.time < l.end)!;
        expect(section.feel).toBe('build');
        const bar = [...map.downbeats].reverse().find((x) => x < section.end - 1e-6)!;
        layer.forEach((o, k) =>
          expect(o.time).toBeCloseTo(timeOfBeat(map, beatAt(map, bar) + k + 1), 6),
        );
        // The gems run down the open lane through the bar, and nowhere else in it.
        const gems = t.pickups.filter((p) => p.time >= bar - 1e-6 && p.time < section.end - 1e-6);
        expect(gems.length).toBeGreaterThanOrEqual(6);
        expect(gems.every((p) => line.includes(p.lane))).toBe(true);
      }
      expect(validateLevel(t).ok).toBe(true);
    },
  );
});
