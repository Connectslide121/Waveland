/** Hand-built levels for the physics and validator tests. */
import { steadyGrid } from '../../../core';
import { ANCHOR_X } from '../physics';
import {
  LevelWorld,
  steadyScroll,
  type Gate,
  type PlatformerLevel,
  type Solid,
  type SpikeStrip,
} from './level';

export function testLevel(
  solids: Solid[],
  {
    spikes = [],
    gates = [],
    speed = 200,
    duration = 6,
    start = { x: ANCHOR_X, y: 0 },
  }: {
    spikes?: SpikeStrip[];
    gates?: Gate[];
    speed?: number;
    duration?: number;
    start?: { x: number; y: number };
  } = {},
): { level: PlatformerLevel; world: LevelWorld } {
  const level: PlatformerLevel = {
    seed: 1,
    difficulty: 'normal',
    duration,
    tempo: 120,
    // 120 BPM from 0.
    grid: steadyGrid(0, 0.5, duration),
    scroll: steadyScroll(speed),
    solids: [],
    spikes: [],
    gates: [],
    pickups: [],
    chunks: [],
    lessons: [],
    start,
    finishX: speed * duration + ANCHOR_X,
  };
  const world = new LevelWorld(level);
  world.add(solids, spikes, gates);
  return { level, world };
}

export const ground = (x0: number, x1: number, top = 0): Solid => ({ kind: 'ground', x0, x1, top });

/** A wall hanging from the sky down to `bottom`. */
export const overhang = (x0: number, x1: number, bottom: number): Solid => ({
  kind: 'overhang',
  x0,
  x1,
  top: 2000,
  bottom,
});
