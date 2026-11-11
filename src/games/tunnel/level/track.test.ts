import { describe, expect, it } from 'vitest';
import { buildLevelMap, type LevelMap, type MelodyMove } from '../../../core';
import { randomAnalysis } from '../../../core/test-analysis';
import {
  CLIMB_RANGE,
  FEEL_OF_KIND,
  looksFor,
  MAX_CLIMB,
  MAX_HEADING,
  pathAt,
  pathFor,
  runFor,
  runSpeed,
  speedAt,
  steadyRun,
  timeAtZ,
  zAtTime,
} from './track';

describe('the run', () => {
  it('folds the tempo into 80–160 BPM, so the speed stays between 8 and 16 units/s', () => {
    expect(runSpeed(120)).toBeCloseTo(12, 6);
    expect(runSpeed(170)).toBeCloseTo(runSpeed(85), 6);
    expect(runSpeed(60)).toBeCloseTo(runSpeed(120), 6);
    for (const bpm of [55, 70, 99, 128, 159, 181, 240]) {
      expect(runSpeed(bpm)).toBeGreaterThanOrEqual(8);
      expect(runSpeed(bpm)).toBeLessThan(16);
    }
  });

  it('follows the tempo map, easing to each segment’s speed over its first beat', () => {
    const map = buildLevelMap(
      randomAnalysis(5, { duration: 60, tempo: 120, changes: [{ time: 30, tempo: 150 }] }),
    );
    const run = runFor(map);
    const change = map.segments[1]!;
    const period = change.beatPeriod;
    expect(speedAt({ run }, change.start - 0.01)).toBeCloseTo(runSpeed(map.segments[0]!.tempo), 6);
    expect(speedAt({ run }, change.start + period + 0.01)).toBeCloseTo(runSpeed(change.tempo), 6);
    const mid = speedAt({ run }, change.start + period / 2);
    expect(mid).toBeGreaterThan(runSpeed(map.segments[0]!.tempo));
    expect(mid).toBeLessThan(runSpeed(change.tempo));
    // Continuous, and timeAtZ inverts it.
    for (let t = 0; t < 60; t += 0.37) {
      expect(zAtTime({ run }, t + 1e-6) - zAtTime({ run }, t)).toBeLessThan(1e-3);
      expect(timeAtZ({ run }, zAtTime({ run }, t))).toBeCloseTo(t, 6);
    }
  });

  it('keeps the speed through a switch to half time', () => {
    const map = buildLevelMap(
      randomAnalysis(6, { duration: 40, tempo: 160, changes: [{ time: 20, tempo: 80 }] }),
    );
    expect(runFor(map)).toHaveLength(1);
  });
});

/** A map whose melody is given beat by beat. */
function withMelody(melody: number[], melodyMove: MelodyMove[]): LevelMap {
  const map = buildLevelMap(randomAnalysis(7, { duration: 60, tempo: 120 }));
  const n = map.beats.length;
  const fill = <T>(values: T[]) => Array.from({ length: n }, (_, i) => values[i] ?? values.at(-1)!);
  return { ...map, mood: { ...map.mood, melody: fill(melody), melodyMove: fill(melodyMove) } };
}

describe('the path', () => {
  const run = steadyRun(12);

  it('climbs with the melody’s height, a capped step a beat', () => {
    const beats = 120;
    const melody = Array.from({ length: beats }, (_, i) => (i < 40 ? 0 : i < 80 ? 1 : 0.5));
    const map = withMelody(melody, ['held']);
    const path = pathFor(map, run);
    const at = (beat: number) => path.find((p) => p.time >= map.beats[beat]!)!;
    expect(at(39).y).toBeCloseTo(0, 3);
    expect(at(79).y).toBeCloseTo(CLIMB_RANGE, 1);
    expect(at(119).y).toBeCloseTo(CLIMB_RANGE / 2, 1);
    for (let i = 1; i < path.length; i++)
      expect(Math.abs(path[i]!.y - path[i - 1]!.y)).toBeLessThanOrEqual(MAX_CLIMB + 1e-9);
  });

  it('turns right on a rising line, left on a falling one, capped, and straightens when held', () => {
    const moves: MelodyMove[] = [
      ...Array<MelodyMove>(30).fill('rising'),
      ...Array<MelodyMove>(30).fill('held'),
      ...Array<MelodyMove>(30).fill('falling'),
      ...Array<MelodyMove>(30).fill('none'),
    ];
    const path = pathFor(withMelody([0.5], moves), run);
    const offset = path.length - withMelody([0.5], ['held']).beats.length;
    const heading = (beat: number) => path[beat + offset]!.heading;
    expect(heading(29)).toBeGreaterThan(0.2);
    expect(Math.abs(heading(59))).toBeLessThan(0.05);
    expect(heading(89)).toBeLessThan(-0.2);
    expect(Math.abs(heading(119))).toBeLessThan(0.05);
    for (const p of path) expect(Math.abs(p.heading)).toBeLessThanOrEqual(MAX_HEADING + 1e-9);
    // Rising moved the centreline right, then falling brought it back left.
    expect(path[60 + offset]!.x).toBeGreaterThan(path[offset]!.x + 1);
  });

  it('holds the last heard height where no melody is heard', () => {
    // Heard high, then not heard, with the filled-in height dropping.
    const melody = Array.from({ length: 100 }, (_, i) => (i < 40 ? 1 : 0.1));
    const moves: MelodyMove[] = Array.from({ length: 100 }, (_, i) => (i < 40 ? 'held' : 'none'));
    const path = pathFor(withMelody(melody, moves), run);
    expect(path[path.length - 1]!.y).toBeCloseTo(CLIMB_RANGE, 1);
  });

  it('reads between its points, and goes straight on past the last', () => {
    const map = withMelody([0.5], ['rising']);
    const track = { path: pathFor(map, run) };
    const [a, b] = [track.path[10]!, track.path[11]!];
    const mid = pathAt(track, (a.z + b.z) / 2);
    expect(mid.x).toBeCloseTo((a.x + b.x) / 2, 6);
    expect(mid.y).toBeCloseTo((a.y + b.y) / 2, 6);
    const last = track.path[track.path.length - 1]!;
    const past = pathAt(track, last.z + 10);
    expect(past.x).toBeCloseTo(last.x + Math.sin(last.heading) * 10, 6);
  });
});

describe('the look of each feel', () => {
  const feels = ['calm', 'breakdown', 'groove', 'chorus', 'build', 'drop'] as const;
  const base = buildLevelMap(
    randomAnalysis(5, {
      sections: feels.map(() => ({ bars: 4, kind: 'main' as const, energy: 0.5 })),
    }),
  );
  const looks = looksFor({
    ...base,
    moods: base.moods.map((m, i) => ({ ...m, feel: feels[i % feels.length]! })),
  });
  const by = Object.fromEntries(looks.map((l) => [l.feel, l]));

  it('thins a calm part or a breakdown to sparse rings with a starfield', () => {
    for (const feel of ['calm', 'breakdown']) {
      expect(by[feel]!.ringBeats).toBeGreaterThanOrEqual(4);
      expect(by[feel]!.stars).toBe(1);
      expect(by[feel]!.radius).toBeGreaterThan(1);
    }
    expect(looks.filter((l) => l.stars > 0).map((l) => l.feel)).toEqual(['calm', 'breakdown']);
  });

  it('turns a chorus’s ring walls with the beat, and bursts the drop open on its downbeats', () => {
    expect(by.chorus!.ringWalls).toBe(true);
    expect(by.chorus!.spin).toBeGreaterThan(0);
    expect(by.groove!.spin).toBe(0);
    expect(by.drop!.burst).toBeGreaterThan(by.chorus!.burst);
    expect(by.groove!.burst).toBe(0);
  });

  it('keeps a feel for every kind of section', () => {
    for (const feel of Object.values(FEEL_OF_KIND)) expect(feels).toContain(feel);
  });
});
