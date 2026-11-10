/** Hand-built levels for the physics and validator tests. */
import { ANCHOR_X } from '../physics';
import { LevelWorld, type PlatformerLevel, type Solid, type SpikeStrip } from './level';

export function testLevel(
  solids: Solid[],
  {
    spikes = [],
    speed = 200,
    duration = 6,
    start = { x: ANCHOR_X, y: 0 },
  }: {
    spikes?: SpikeStrip[];
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
    gridStart: 0,
    beatPeriod: 0.5,
    speed,
    solids: [],
    spikes: [],
    pickups: [],
    chunks: [],
    start,
    finishX: speed * duration + ANCHOR_X,
  };
  const world = new LevelWorld(level);
  world.add(solids, spikes);
  return { level, world };
}

export const ground = (x0: number, x1: number, top = 0): Solid => ({ kind: 'ground', x0, x1, top });
