import { describe, expect, it } from 'vitest';
import { buildLevelMap, DIFFICULTIES, type Difficulty } from '../../../core';
import { analyseSamples } from '../../../core/analysis/analyse';
import { electroSong, rockSong } from '../../../core/analysis/test-songs';
import { generateLevel } from './generate';
import type { PlatformerLevel } from './level';
import { validateLevel } from './validate';

/** Obstacles a minute, but for the small steps plain ground takes with the energy. */
const perMinute = (l: PlatformerLevel) =>
  l.obstacles.filter((o) => o.kind !== 'kick' || o.air).length / (l.duration / 60);

describe.each([
  ['the rock stand-in', rockSong],
  ['the 128 BPM electronic track', electroSong],
])('levels for %s', (_, make) => {
  const song = make();
  const map = buildLevelMap(analyseSamples(song.samples, song.rate));
  const levels = Object.fromEntries(DIFFICULTIES.map((d) => [d, generateLevel(map, d)])) as Record<
    Difficulty,
    PlatformerLevel
  >;

  it('get busier from easy to hard', () => {
    expect(perMinute(levels.easy)).toBeLessThan(perMinute(levels.normal));
    expect(perMinute(levels.normal)).toBeLessThan(perMinute(levels.hard));
  });

  it.each(DIFFICULTIES)(
    'can be finished on %s, and not without the dash or the slam',
    (d) => {
      const level = levels[d];
      expect(validateLevel(level).ok).toBe(true);
      expect(level.lessons.map((l) => l.action)).toEqual(['dash', 'slam']);
      expect(validateLevel(level, 'dash').ok).toBe(false);
      // Stuck at a slam plate: nothing else gets under its ceiling.
      const noSlam = validateLevel(level, 'slam');
      expect(noSlam.ok).toBe(false);
      const plate = level.obstacles.find((o) => o.needs === 'slam' && o.time >= noSlam.reached - 2);
      expect(plate).toBeDefined();
    },
    60_000,
  );
});
