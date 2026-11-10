import { describe, expect, it } from 'vitest';
import { ground, testLevel } from './level/test-level';
import {
  COYOTE_TIME,
  GRAVITY,
  JUMP_CUT_VELOCITY,
  JUMP_VELOCITY,
  PHYSICS_DT,
  PLAYER_WIDTH,
  RUN_SPEED,
  scrollSpeed,
  startState,
  stepPlayer,
  type PhysicsWorld,
  type PlayerInput,
  type PlayerState,
} from './physics';

const RIGHT: PlayerInput = { dir: 1, jump: false };
const STAND: PlayerInput = { dir: 0, jump: false };

/** Run `steps` physics steps from song time `t0`, with the input chosen per step. */
function run(
  world: PhysicsWorld,
  p: PlayerState,
  steps: number,
  input: (i: number, p: PlayerState) => PlayerInput,
  t0 = 0,
): PlayerState[] {
  const trace = [p];
  for (let i = 1; i <= steps && p.alive; i++) {
    p = stepPlayer(p, input(i, p), world, t0 + i * PHYSICS_DT);
    trace.push(p);
  }
  return trace;
}

describe('scrollSpeed', () => {
  it('follows the tempo, folded into a range the player can outrun', () => {
    expect(scrollSpeed(120)).toBeCloseTo(220);
    expect(scrollSpeed(140)).toBeGreaterThan(scrollSpeed(120));
    for (const bpm of [60, 75, 90, 128, 159, 160, 174, 200, 0])
      expect(scrollSpeed(bpm)).toBeLessThan(RUN_SPEED * 0.8);
    expect(scrollSpeed(170)).toBeCloseTo(scrollSpeed(85));
  });
});

describe('stepPlayer', () => {
  it('jumps as high and as long as the constants say', () => {
    const { world } = testLevel([ground(0, 2000)], { speed: 0 });
    const trace = run(world, { ...startState(300, 0), surface: 0 }, 120, (i) => ({
      dir: 0,
      jump: i === 1,
    }));
    const peak = Math.max(...trace.map((p) => p.y));
    expect(peak).toBeGreaterThan(0.95 * (JUMP_VELOCITY ** 2 / (2 * GRAVITY)));
    expect(peak).toBeLessThan(1.02 * (JUMP_VELOCITY ** 2 / (2 * GRAVITY)));
    const landed = trace.findIndex((p, i) => i > 1 && p.grounded);
    expect(landed * PHYSICS_DT).toBeCloseTo((2 * JUMP_VELOCITY) / GRAVITY, 1);
  });

  it('cuts a jump short when jump is let go on the way up, and never lengthens one', () => {
    const { world } = testLevel([ground(0, 2000)], { speed: 0 });
    const tap = run(world, { ...startState(300, 0), surface: 0 }, 120, (i) => ({
      dir: 0,
      jump: i === 1,
      release: i > 4,
    }));
    const peak = Math.max(...tap.map((p) => p.y));
    expect(peak).toBeLessThan(0.5 * (JUMP_VELOCITY ** 2 / (2 * GRAVITY)));
    expect(peak).toBeGreaterThan(JUMP_CUT_VELOCITY ** 2 / (2 * GRAVITY));
    // Letting go on the way down changes nothing.
    const held = run(world, { ...startState(300, 0), surface: 0 }, 120, (i) => ({
      dir: 0,
      jump: i === 1,
    }));
    const late = run(world, { ...startState(300, 0), surface: 0 }, 120, (i) => ({
      dir: 0,
      jump: i === 1,
      release: i > 30,
    }));
    expect(late.map((p) => p.y)).toEqual(held.map((p) => p.y));
  });

  it('clears a gap a running jump reaches, and falls into one it does not', () => {
    const across = (width: number) => {
      const { world } = testLevel([ground(0, 400), ground(400 + width, 2000)], { speed: 0 });
      const trace = run(world, { ...startState(300, 0), surface: 0 }, 150, (_, p) => ({
        dir: 1,
        // Jump at the very edge.
        jump: p.grounded && p.x + RUN_SPEED * PHYSICS_DT >= 400,
      }));
      return trace[trace.length - 1]!;
    };
    expect(across(200).alive).toBe(true);
    const fell = across(320);
    expect(fell.alive).toBe(false);
    expect(fell.death).toBe('pit');
  });

  it('allows a jump just after running off an edge, but not later', () => {
    const { world } = testLevel([ground(0, 400)], { speed: 0 });
    const offEdge = run(world, { ...startState(360, 0), surface: 0 }, 30, () => RIGHT).find(
      (p) => !p.grounded,
    )!;
    const soon = stepPlayer(offEdge, { dir: 1, jump: true }, world, 1);
    expect(soon.vy).toBe(JUMP_VELOCITY - GRAVITY * PHYSICS_DT);
    const late = run(world, offEdge, Math.ceil(COYOTE_TIME / PHYSICS_DT) + 1, () => RIGHT).pop()!;
    expect(stepPlayer(late, { dir: 1, jump: true }, world, 2).vy).toBeLessThan(0);
  });

  it('stops at the side of a taller column', () => {
    const { world } = testLevel([ground(0, 500), ground(500, 900, 100)], { speed: 0 });
    const end = run(world, { ...startState(300, 0), surface: 0 }, 60, () => RIGHT).pop()!;
    expect(end.x).toBeCloseTo(500 - PLAYER_WIDTH);
    expect(end.y).toBe(0);
  });

  it('drops the player when a bridge goes, and holds them while it is there', () => {
    const bridge = {
      kind: 'bridge' as const,
      x0: 0,
      x1: 1000,
      top: 0,
      windows: [[0, 1] as [number, number]],
    };
    const { world } = testLevel([bridge], { speed: 0 });
    const trace = run(world, { ...startState(300, 0), surface: 0 }, 120, () => STAND);
    expect(trace[50]!.y).toBe(0);
    expect(trace[trace.length - 1]!.alive).toBe(false);
  });

  it('is cut by spikes when they are out, not when they are in', () => {
    const spikes = [{ x0: 320, x1: 360, top: 0 }];
    const { world } = testLevel([ground(0, 2000)], { speed: 0, spikes });
    const standing = { ...startState(320, 0), surface: 0 };
    // The grid: beats every 0.5 s, spikes out from each off-beat to the next beat.
    expect(stepPlayer(standing, STAND, world, 0.1).alive).toBe(true);
    const cut = stepPlayer(standing, STAND, world, 0.3);
    expect(cut.alive).toBe(false);
    expect(cut.death).toBe('spikes');
  });

  it('carries the player up and down on an equaliser', () => {
    const eq = {
      kind: 'eq' as const,
      x0: 0,
      x1: 1000,
      top: 0,
      keys: { times: [0.5, 1], tops: [80, 20] },
    };
    const { world } = testLevel([eq], { speed: 0 });
    const trace = run(world, { ...startState(300, 0), surface: 0 }, 90, () => STAND);
    expect(trace[45]!.y).toBeCloseTo(80); // 0.75 s
    expect(trace[90]!.y).toBeCloseTo(20); // 1.5 s
    expect(trace.every((p) => p.grounded)).toBe(true);
  });

  it('loses the player who falls behind the camera', () => {
    const { world } = testLevel([ground(-100, 3000)], { speed: 250 });
    const trace = run(world, { ...startState(100, 0), surface: 0 }, 60, () => STAND);
    const end = trace[trace.length - 1]!;
    expect(end.alive).toBe(false);
    expect(end.death).toBe('behind');
  });
});
