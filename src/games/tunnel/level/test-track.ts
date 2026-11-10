/** Hand-built tracks for the physics and validator tests. */
import { BLOCK_DEPTH } from '../physics';
import { steadyRun, TrackWorld, zAtTime, type Obstacle, type TunnelTrack } from './track';

export const SPEED = 12;

/** A hand-built track (from z 0, at `SPEED` units/s) at one speed with these obstacles. */
export function testTrack(obstacles: Partial<Obstacle>[] = [], lanes = 5, duration = 6) {
  const run = steadyRun(SPEED);
  const track: TunnelTrack = {
    seed: 1,
    difficulty: 'normal',
    duration,
    tempo: 120,
    grid: { segments: [], beats: [], downbeats: [] },
    lanes,
    run,
    path: [{ time: 0, z: 0, x: 0, y: 0, heading: 0 }],
    looks: [],
    pulse: { bass: [], kicks: [] },
    obstacles: [],
    pickups: [],
    holds: [],
    dark: [],
    chunks: [],
    startLane: Math.floor(lanes / 2),
    finishZ: zAtTime({ run }, duration),
  };
  const world = new TrackWorld(track);
  world.add(
    obstacles.map((o) => {
      const time = o.time ?? 1;
      const z0 = zAtTime(track, time);
      return {
        kind: 'kick',
        label: 'Block',
        reason: 'test',
        lanes: [2],
        ...o,
        time,
        z0,
        z1: z0 + BLOCK_DEPTH,
      };
    }),
  );
  return { track, world };
}
