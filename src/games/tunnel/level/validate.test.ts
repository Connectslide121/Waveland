import { describe, expect, it } from 'vitest';
import { buildLevelMap } from '../../../core';
import { randomAnalysis } from '../../../core/test-analysis';
import { PHYSICS_DT, startRacer, stepRacer } from '../physics';
import { generateLevel } from './generate';
import { testTrack } from './test-track';
import { TrackWorld, type Obstacle, type TunnelTrack } from './track';
import { solveLevel, stepAt, validateLevel } from './validate';

const ALL = [0, 1, 2, 3, 4];

/** Plays the presses through the game's own step and counts the crashes. */
function replay(track: TunnelTrack, presses: Map<number, object>) {
  const world = new TrackWorld(track);
  let p = startRacer(track.startLane);
  let crashes = 0;
  for (let step = 1; step <= stepAt(track.duration); step++) {
    p = stepRacer(p, presses.get(step) ?? {}, world, step * PHYSICS_DT);
    if (p.crash >= 0) crashes++;
  }
  return crashes;
}

describe('validateLevel', () => {
  it('passes an empty track', () => {
    expect(validateLevel(testTrack().track).ok).toBe(true);
  });

  it('stops at a wall across every lane, at its time', () => {
    const check = validateLevel(testTrack([{ time: 2, lanes: ALL }]).track);
    expect(check.ok).toBe(false);
    expect(check.reached).toBeGreaterThan(1.9);
    expect(check.reached).toBeLessThan(2.2);
  });

  it('steers to a gap at the far side when there is time, and not when there isn’t', () => {
    const wall = (time: number): Partial<Obstacle> => ({ time, lanes: [1, 2, 3, 4] });
    expect(validateLevel(testTrack([wall(1)]).track).ok).toBe(true);
    // Two lanes away, from the start: two hops in 0.15 s is too fast.
    expect(validateLevel(testTrack([wall(0.15)]).track).ok).toBe(false);
  });

  it('jumps low walls, and weaves a slalom', () => {
    const low: Partial<Obstacle> = { time: 1, lanes: ALL, low: true };
    const slalom: Partial<Obstacle>[] = [
      { time: 2, lanes: [0, 1, 2] },
      { time: 2.5, lanes: [2, 3, 4] },
      { time: 3, lanes: [0, 1, 2] },
    ];
    expect(validateLevel(testTrack([low, ...slalom]).track).ok).toBe(true);
    // A low wall right after another: still jumpable once back down.
    expect(validateLevel(testTrack([low, { ...low, time: 1.5 }]).track).ok).toBe(true);
  });

  it('can’t get through a slalom faster than a lane can be crossed', () => {
    const slalom: Partial<Obstacle>[] = [
      { time: 2, lanes: [0, 1, 2] },
      { time: 2.12, lanes: [2, 3, 4] },
    ];
    expect(validateLevel(testTrack(slalom).track).ok).toBe(false);
  });
});

describe('solveLevel', () => {
  it('returns presses that race a hand-built track without a crash', () => {
    const { track } = testTrack([
      { time: 1, lanes: [1, 2, 3, 4] },
      { time: 2, lanes: ALL, low: true },
      { time: 3, lanes: [0, 1, 2, 3] },
    ]);
    const presses = solveLevel(track)!;
    expect(presses.size).toBeGreaterThan(2);
    expect(replay(track, presses)).toBe(0);
  });

  it('returns null when there is no clean way', () => {
    expect(solveLevel(testTrack([{ time: 2, lanes: ALL }]).track)).toBeNull();
  });

  it('races a generated track to the end without a crash', () => {
    const map = buildLevelMap(randomAnalysis(3, { duration: 45, tempo: 140 }));
    const track = generateLevel(map, 'hard');
    expect(track.obstacles.length).toBeGreaterThan(20);
    const presses = solveLevel(track)!;
    expect(presses).not.toBeNull();
    expect(replay(track, presses)).toBe(0);
  }, 30_000);
});
