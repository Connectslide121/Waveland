import { describe, expect, it } from 'vitest';
import {
  JUMP_AIR,
  JUMP_HEIGHT,
  LANE_HOP_TIME,
  LOW_WALL_HEIGHT,
  obstacleLaneAt,
  PHYSICS_DT,
  startRacer,
  stepRacer,
  type RacerInput,
  type RacerObstacle,
  type RacerState,
} from './physics';
import { SPEED, testTrack } from './level/test-track';
import type { Obstacle, TrackWorld } from './level/track';

/** Runs the racer from song time 0 to `until`, pressing `presses` on their steps. */
function race(
  world: TrackWorld,
  until: number,
  presses: Record<number, RacerInput> = {},
  from: RacerState = startRacer(world.track.startLane),
) {
  let p = from;
  const crashes: number[] = [];
  const states: RacerState[] = [];
  for (let step = 1; step * PHYSICS_DT <= until + 1e-9; step++) {
    p = stepRacer(p, presses[step] ?? {}, world, step * PHYSICS_DT);
    if (p.crash >= 0) crashes.push(p.crash);
    states.push(p);
  }
  return { p, crashes, states };
}

describe('stepRacer', () => {
  it('takes z from song time, never from input', () => {
    const { world } = testTrack();
    const { p } = race(world, 2, { 10: { left: true }, 40: { jump: true } });
    expect(p.z).toBeCloseTo(2 * SPEED, 6);
  });

  it('hops one lane in LANE_HOP_TIME, eased, and stays inside the tunnel', () => {
    const { world } = testTrack();
    const { states } = race(world, 1, { 1: { left: true } });
    const done = Math.ceil(LANE_HOP_TIME / PHYSICS_DT);
    expect(states[done - 2]!.pos).toBeGreaterThan(1);
    expect(states[done - 1]!.pos).toBe(1);
    // Eased: slow at the start.
    expect(2 - states[0]!.pos).toBeLessThan(0.1);
    // At the edge a further hop does nothing.
    const edge = race(world, 1, { 1: { left: true }, 10: { left: true }, 20: { left: true } });
    expect(edge.p.lane).toBe(0);
    expect(edge.p.pos).toBe(0);
  });

  it('turns a hop pressed mid-hop toward the next lane from where the racer is', () => {
    const { world } = testTrack();
    const { states } = race(world, 1, { 1: { right: true }, 4: { right: true } });
    expect(states[3]!.lane).toBe(4);
    expect(states[3]!.hopFrom).toBeGreaterThan(2);
    expect(states[3]!.hopFrom).toBeLessThan(3);
    expect(states[states.length - 1]!.pos).toBe(4);
  });

  it('jumps JUMP_HEIGHT high for JUMP_AIR seconds, and not again in the air', () => {
    const { world } = testTrack();
    const { states } = race(world, 1, { 1: { jump: true }, 5: { jump: true } });
    const air = states.filter((s) => !s.grounded).length * PHYSICS_DT;
    expect(air).toBeGreaterThan(JUMP_AIR - 2 * PHYSICS_DT);
    expect(air).toBeLessThan(JUMP_AIR + 2 * PHYSICS_DT);
    expect(Math.max(...states.map((s) => s.y))).toBeCloseTo(JUMP_HEIGHT, 1);
  });

  it('crashes into a block in its lane once, and passes one in the next lane', () => {
    const { world } = testTrack([
      { time: 1, lanes: [2] },
      { time: 2, lanes: [3] },
    ]);
    const { crashes, p } = race(world, 3);
    expect(crashes).toEqual([0]);
    // The race goes on.
    expect(p.z).toBeCloseTo(3 * SPEED, 6);
  });

  it('crashes when a hop passes through a block, not when it is over before', () => {
    const { world } = testTrack([{ time: 1, lanes: [3] }]);
    expect(race(world, 2, { 57: { right: true } }).crashes).toEqual([0]);
    expect(race(world, 2, { 40: { right: true } }).crashes).toEqual([0]);
    expect(race(world, 2, { 66: { right: true } }).crashes).toEqual([]);
  });

  it('clears a low wall in a jump, and crashes into it on the floor', () => {
    const low: Partial<Obstacle> = { time: 1, lanes: [0, 1, 2, 3, 4], low: true, kind: 'low' };
    const { world } = testTrack([low]);
    expect(race(world, 2).crashes).toEqual([0]);
    // Jumped a little before: high enough over the wall's whole depth.
    expect(race(world, 2, { 54: { jump: true } }).crashes).toEqual([]);
    // Too early: back down before it.
    expect(race(world, 2, { 30: { jump: true } }).crashes).toEqual([0]);
    expect(LOW_WALL_HEIGHT).toBeLessThan(JUMP_HEIGHT);
  });

  it('slides a sliding block from its lane to its last, and hits where it is', () => {
    const slide: RacerObstacle = {
      z0: 0,
      z1: 1,
      lanes: [3],
      slide: { from: 2, start: 0.5, end: 1 },
    };
    expect(obstacleLaneAt(slide, 0, 0.2)).toBe(2);
    expect(obstacleLaneAt(slide, 0, 0.75)).toBeCloseTo(2.5, 6);
    expect(obstacleLaneAt(slide, 0, 1.2)).toBe(3);
    const { world } = testTrack([
      { time: 1, lanes: [3], kind: 'slide', slide: { from: 2, start: 0.5, end: 1 } },
    ]);
    // It slid out of the racer's lane into the next.
    expect(race(world, 2).crashes).toEqual([]);
    expect(race(world, 2, { 30: { right: true } }).crashes).toEqual([0]);
  });
});
