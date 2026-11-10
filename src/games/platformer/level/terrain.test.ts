import { describe, expect, it } from 'vitest';
import {
  beatAt,
  buildLevelMap,
  DIFFICULTIES,
  periodAt,
  timeOfBeat,
  type LevelMap,
} from '../../../core';
import { randomAnalysis } from '../../../core/test-analysis';
import { PLAYER_WIDTH, STEP_UP } from '../physics';
import { generateLevel, STYLE_OF_FEEL } from './generate';
import { solidTop, timeAtX, xAtTime, type Chunk, type PlatformerLevel, type Solid } from './level';
import { FLOAT_RANGE, HEAVE_MAX, MORPH_BEATS } from './terrain';
import { validateLevel } from './validate';

/**
 * A fast rock song that changes tempo and mood: a quiet intro, a verse, a build into a
 * drop, a chorus, a breakdown, another chorus and a quiet outro, at 150, then 120, then
 * 160 BPM.
 */
function rockSong(seed: number): LevelMap {
  return buildLevelMap(
    randomAnalysis(seed, {
      tempo: 150,
      duration: 100,
      changes: [
        { time: 40, tempo: 120 },
        { time: 70, tempo: 160 },
      ],
      sections: [
        { bars: 6, kind: 'intro', energy: 0.25 },
        { bars: 8, kind: 'main', energy: 0.55 },
        { bars: 4, kind: 'build', energy: 0.6 },
        { bars: 8, kind: 'drop', energy: 0.95 },
        { bars: 8, kind: 'main', energy: 0.9 },
        { bars: 4, kind: 'breakdown', energy: 0.2 },
        { bars: 8, kind: 'main', energy: 0.88 },
        { bars: 8, kind: 'outro', energy: 0.3 },
      ],
    }),
  );
}

const map = rockSong(5);
const levels = Object.fromEntries(DIFFICULTIES.map((d) => [d, generateLevel(map, d)])) as Record<
  (typeof DIFFICULTIES)[number],
  PlatformerLevel
>;
const normal = levels.normal;
const built = (l: PlatformerLevel) =>
  l.chunks.filter((c) => c.kind !== 'run-in' && c.kind !== 'run-out');
const feelAt = (t: number) =>
  map.moods[map.sections.findIndex((s) => t >= s.start && t < s.end)]!.feel;
const solidsIn = (l: PlatformerLevel, c: Chunk, kind?: Solid['kind']) =>
  l.solids.filter((s) => s.x0 >= c.x0 - 1e-6 && s.x1 <= c.x1 + 1e-6 && (!kind || s.kind === kind));
const range = (s: Solid) => Math.max(...s.keys!.tops) - Math.min(...s.keys!.tops);

describe('terrain styles: a rock song with tempo and mood changes', () => {
  it('feels every kind of section the song has', () => {
    expect(map.segments).toHaveLength(3);
    expect(map.moods.map((m) => m.feel)).toEqual([
      'calm',
      'groove',
      'build',
      'drop',
      'chorus',
      'breakdown',
      'chorus',
      'calm',
    ]);
  });

  it('can be finished at every difficulty', () => {
    for (const d of DIFFICULTIES) {
      const check = validateLevel(levels[d]);
      expect(check.ok, `${d}: stuck at ${check.reached.toFixed(2)} s`).toBe(true);
    }
  });

  it('builds the same level every time', () => {
    expect(generateLevel(rockSong(5), 'hard')).toEqual(levels.hard);
  });

  it('picks each stretch’s style by its section’s feel (a drop’s first stretch is its set piece)', () => {
    for (const l of Object.values(levels)) {
      const styles = new Set<string>();
      for (const c of built(l)) {
        styles.add(c.style);
        if (c.kind === 'drop') expect(c.style).toBe('drop');
        // A stretch made flat as a last resort is still ground.
        else if (c.kind !== 'flat' || c.repairs === 0)
          expect(c.style, `at ${c.start.toFixed(2)} s`).toBe(
            STYLE_OF_FEEL[feelAt(c.start + periodAt(map, c.start) / 2)],
          );
      }
      expect([...styles].sort()).toEqual(['climb', 'contour', 'drop', 'float', 'heave']);
    }
  });

  it('floats calm parts on wide slabs drifting gently, resting where the player steps on', () => {
    const calm = built(normal).filter((c) => c.style === 'float');
    const slabs = calm.flatMap((c) => solidsIn(normal, c, 'float'));
    expect(slabs.length).toBeGreaterThan(calm.length);
    const moving = slabs.filter((s) => s.keys && range(s) > 4);
    expect(moving.length).toBeGreaterThan(slabs.length / 2);
    for (const s of slabs) {
      // It drifts at most its range either way of its own height (once any reshaping at a
      // change of style is over).
      const on = timeAtX(normal, s.x0 - PLAYER_WIDTH);
      for (const [k, t] of (s.keys?.times ?? []).entries())
        if (t >= on)
          expect(Math.abs(s.keys!.tops[k]! - s.top)).toBeLessThanOrEqual(FLOAT_RANGE + 1e-6);
      // Where the player's front reaches it, it is at its own height.
      expect(solidTop(s, on)).toBeCloseTo(s.top, 3);
    }
  });

  it('heaves a chorus’s ground with the bass on the beat, whole runs of columns together', () => {
    const chorus = built(normal).filter((c) => c.style === 'heave');
    const columns = chorus.flatMap((c) => solidsIn(normal, c, 'heave'));
    expect(columns.length).toBeGreaterThan(chorus.length * 2);
    for (const s of columns) expect(range(s)).toBeLessThanOrEqual(HEAVE_MAX + 1e-6);
    // Up on the beat, down by the off-beat, somewhere in every heaving stretch.
    for (const c of chorus) {
      const cols = solidsIn(normal, c, 'heave');
      if (cols.length === 0) continue;
      const lift = (s: Solid, t: number) => solidTop(s, t)! - s.top;
      let heaved = false;
      for (let b = Math.ceil(beatAt(map, c.start)); timeOfBeat(map, b) < c.end; b++) {
        const on = timeOfBeat(map, b) + 0.17;
        const off = timeOfBeat(map, b + 0.5) + 0.17;
        if (cols.some((s) => lift(s, on) > 10 && lift(s, off) < lift(s, on) - 5)) heaved = true;
      }
      expect(heaved, `stretch at ${c.start.toFixed(2)} s`).toBe(true);
    }
    // Neighbours in a run (keyed on the same beats) are never more than a step apart, so
    // it can be run along.
    let pairs = 0;
    for (let i = 1; i < normal.solids.length; i++) {
      const a = normal.solids[i - 1]!;
      const b = normal.solids[i]!;
      if (a.kind !== 'heave' || b.kind !== 'heave' || b.x0 - a.x1 > 4) continue;
      if (a.keys!.times[0] !== b.keys!.times[0] || a.keys!.times.length !== b.keys!.times.length)
        continue;
      pairs++;
      for (const t of b.keys!.times) {
        const step = Math.abs(solidTop(b, t + 0.05)! - solidTop(a, t + 0.05)!);
        expect(step).toBeLessThanOrEqual(STEP_UP);
      }
    }
    expect(pairs).toBeGreaterThan(10);
  });

  it('climbs through the build, step by step toward the drop', () => {
    const build = built(normal).filter((c) => c.style === 'climb');
    expect(build.length).toBeGreaterThan(0);
    const heights = build.map((c) => {
      const ground = solidsIn(normal, c, 'ground');
      return ground[ground.length - 1]!.top;
    });
    const first = solidsIn(normal, build[0]!, 'ground')[0]!.top;
    expect(heights.at(-1)!).toBeGreaterThan(first);
    for (let i = 1; i < heights.length; i++)
      expect(heights[i]!).toBeGreaterThanOrEqual(heights[i - 1]!);
    const steps = normal.obstacles.filter((o) => o.reason === 'kick, the build climbing');
    expect(steps.length).toBeGreaterThan(0);
  });

  it('makes a build busier as it goes than the same music would be', () => {
    // The same song, its build read as a groove: no more common obstacles than the build.
    const plain = {
      ...map,
      moods: map.moods.map((m) => (m.feel === 'build' ? { ...m, feel: 'groove' as const } : m)),
    };
    const l = generateLevel(plain, 'normal');
    const build = map.sections.find((s) => s.kind === 'build')!;
    const common = (x: PlatformerLevel) =>
      x.obstacles.filter(
        (o) =>
          ['kick', 'bridge', 'spikes'].includes(o.kind) &&
          o.reason !== 'kick, the build climbing' &&
          !o.label.startsWith('Step') &&
          o.time >= build.start &&
          o.time < build.end,
      ).length;
    expect(common(normal)).toBeGreaterThanOrEqual(common(l));
  });

  it('builds a bigger drop: a longer staircase', () => {
    const drop = built(normal).find((c) => c.kind === 'drop')!;
    expect(solidsIn(normal, drop, 'step').length).toBeGreaterThanOrEqual(5);
  });

  it('changes style on the downbeat, in view: resting before it, reshaping after', () => {
    let changes = 0;
    const chunks = built(normal);
    for (let i = 1; i < chunks.length; i++) {
      const c = chunks[i]!;
      if (c.style === chunks[i - 1]!.style || c.style === 'drop') continue;
      const moving = solidsIn(normal, c).filter((s) => s.keys && s.kind !== 'eq');
      if (moving.length === 0) continue;
      changes++;
      // Nothing of the new style moves before the downbeat…
      for (const s of moving)
        expect(solidTop(s, c.start - 0.02)).toBeCloseTo(solidTop(s, c.start - 1)!, 3);
      // …and something in view then has moved within a bar or two of it.
      const view = xAtTime(normal, c.start) + 672;
      const after = timeOfBeat(map, beatAt(map, c.start) + Math.max(4, MORPH_BEATS) + 2);
      const moved = moving.some((s) => {
        if (s.x0 > view) return false;
        for (let t = c.start; t <= after; t += 0.05)
          if (Math.abs(solidTop(s, t)! - solidTop(s, c.start - 0.02)!) > 3) return true;
        return false;
      });
      expect(moved, `change at ${c.start.toFixed(2)} s to ${c.style}`).toBe(true);
    }
    expect(changes).toBeGreaterThanOrEqual(3);
  });
});

describe('terrain styles: random songs', () => {
  for (let seed = 40; seed <= 45; seed++) {
    const difficulty = DIFFICULTIES[seed % 3]!;
    it(`song ${seed} with tempo changes (${difficulty}) can be finished`, () => {
      const m = buildLevelMap(
        randomAnalysis(seed, {
          duration: 45,
          changes: [
            { time: 15, tempo: 100 + (seed % 5) * 15 },
            { time: 30, tempo: 170 - (seed % 4) * 20 },
          ],
        }),
      );
      const l = generateLevel(m, difficulty);
      const check = validateLevel(l);
      expect(check.ok, `stuck at ${check.reached.toFixed(2)} s`).toBe(true);
    });
  }
});
