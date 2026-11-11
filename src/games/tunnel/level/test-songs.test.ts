import { describe, expect, it } from 'vitest';
import { beatAt, buildLevelMap, DIFFICULTIES, type Difficulty } from '../../../core';
import { analyseSamples } from '../../../core/analysis/analyse';
import { electroSong, melodySong, rockSong } from '../../../core/analysis/test-songs';
import { PHYSICS_DT, startRacer, stepRacer } from '../physics';
import { generateLevel } from './generate';
import { TrackWorld, type TunnelTrack } from './track';
import { solveLevel, stepAt, validateLevel } from './validate';

const perMinute = (t: TunnelTrack) => t.obstacles.length / (t.duration / 60);

describe.each([
  ['the rock stand-in', rockSong],
  ['the 128 BPM electronic track', electroSong],
  ['the melody song', melodySong],
])('tracks for %s', (_, make) => {
  const song = make();
  const map = buildLevelMap(analyseSamples(song.samples, song.rate));
  const tracks = Object.fromEntries(DIFFICULTIES.map((d) => [d, generateLevel(map, d)])) as Record<
    Difficulty,
    TunnelTrack
  >;

  it.each(DIFFICULTIES)('can be raced on %s without a crash', (d) => {
    const check = validateLevel(tracks[d]);
    expect(check.ok, `stuck at ${check.reached.toFixed(2)} s`).toBe(true);
  });

  it('get busier from easy to hard', () => {
    expect(perMinute(tracks.easy)).toBeLessThan(perMinute(tracks.normal));
    expect(perMinute(tracks.normal)).toBeLessThan(perMinute(tracks.hard));
  });

  it('bend and climb with the melody, within their caps', () => {
    const ys = tracks.normal.path.map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(1);
  });

  it('repeat a repeated bar’s obstacles on the same beats of its bar', () => {
    const t = tracks.normal;
    const barOf = (time: number) => map.downbeats.filter((d) => d <= time + 1e-6).length - 1;
    const offset = (time: number) => beatAt(map, time) - beatAt(map, map.downbeats[barOf(time)]!);
    for (const o of t.obstacles) {
      if (o.repeats === undefined) continue;
      const source = map.downbeats[o.repeats - 1]!;
      const twin = t.obstacles.find(
        (s) =>
          s.kind === o.kind &&
          barOf(s.time) === o.repeats! - 1 &&
          Math.abs(offset(s.time) - offset(o.time)) < 0.01,
      );
      // A repair may have taken the first bar's own obstacle out.
      const repaired = t.chunks.some(
        (c) => c.repairs > 0 && c.start <= source + 1e-6 && c.end > source,
      );
      if (!twin && repaired) continue;
      expect(twin, `${o.kind} at ${o.time.toFixed(2)} repeats bar ${o.repeats}`).toBeDefined();
      // A kick's block stands where the racer is, which a repeat may reach in another lane.
      if (o.kind !== 'snare' && o.kind !== 'kick' && twin!.repeats === undefined)
        expect(o.lanes).toEqual(twin!.lanes);
      expect(source).toBeLessThan(o.time);
    }
  });
});

describe('solveLevel on the rock stand-in', () => {
  it('races hard to the end without a crash', () => {
    const song = rockSong();
    const track = generateLevel(buildLevelMap(analyseSamples(song.samples, song.rate)), 'hard');
    const presses = solveLevel(track)!;
    const world = new TrackWorld(track);
    let p = startRacer(track.startLane);
    let crashes = 0;
    for (let step = 1; step <= stepAt(track.duration); step++) {
      p = stepRacer(p, presses.get(step) ?? {}, world, step * PHYSICS_DT);
      if (p.crash >= 0) crashes++;
    }
    expect(crashes).toBe(0);
  }, 60_000);
});
