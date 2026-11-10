import { describe, expect, it } from 'vitest';
import { ground, overhang, testLevel } from './level/test-level';
import {
  ANCHOR_X,
  COYOTE_TIME,
  DASH_TIME,
  GRAVITY,
  JUMP_CUT_VELOCITY,
  JUMP_VELOCITY,
  PHYSICS_DT,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  scrollSpeed,
  SLAM_SPEED,
  startState,
  stepPlayer,
  type PhysicsWorld,
  type PlayerInput,
  type PlayerState,
} from './physics';

const NOTHING: PlayerInput = { jump: false };

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

/** A player standing at the anchor at song time 0, on solid `surface`. */
const standing = (y = 0, surface = 0) => ({ ...startState(ANCHOR_X, y), surface });
const peakOf = (trace: PlayerState[]) => Math.max(...trace.map((p) => p.y));

describe('scrollSpeed', () => {
  it('follows the tempo, folded into 80–160 BPM', () => {
    expect(scrollSpeed(120)).toBeCloseTo(220);
    expect(scrollSpeed(140)).toBeGreaterThan(scrollSpeed(120));
    for (const bpm of [60, 75, 90, 128, 159, 160, 174, 200, 0]) {
      expect(scrollSpeed(bpm)).toBeGreaterThanOrEqual(146);
      expect(scrollSpeed(bpm)).toBeLessThan(294);
    }
    expect(scrollSpeed(170)).toBeCloseTo(scrollSpeed(85));
  });
});

describe('stepPlayer', () => {
  it('takes the player’s x from song time only', () => {
    const { world } = testLevel([ground(0, 4000)], { speed: 200 });
    const trace = run(world, standing(), 60, (i) => ({ jump: i === 10, dash: i === 30 }));
    trace
      .slice(1)
      .forEach((p, i) => expect(p.x).toBeCloseTo(ANCHOR_X + 200 * (i + 1) * PHYSICS_DT));
  });

  it('jumps as high and as long as the constants say', () => {
    const { world } = testLevel([ground(0, 4000)], { speed: 0 });
    const trace = run(world, standing(), 120, (i) => ({ jump: i === 1 }));
    const peak = peakOf(trace);
    expect(peak).toBeGreaterThan(0.95 * (JUMP_VELOCITY ** 2 / (2 * GRAVITY)));
    expect(peak).toBeLessThan(1.02 * (JUMP_VELOCITY ** 2 / (2 * GRAVITY)));
    const landed = trace.findIndex((p, i) => i > 1 && p.grounded);
    expect(landed * PHYSICS_DT).toBeCloseTo((2 * JUMP_VELOCITY) / GRAVITY, 1);
  });

  it('cuts a jump short when jump is let go on the way up, and never lengthens one', () => {
    const { world } = testLevel([ground(0, 4000)], { speed: 0 });
    const tap = run(world, standing(), 120, (i) => ({ jump: i === 1, release: i > 4 }));
    expect(peakOf(tap)).toBeLessThan(0.5 * (JUMP_VELOCITY ** 2 / (2 * GRAVITY)));
    expect(peakOf(tap)).toBeGreaterThan(JUMP_CUT_VELOCITY ** 2 / (2 * GRAVITY));
    // Letting go on the way down changes nothing.
    const held = run(world, standing(), 120, (i) => ({ jump: i === 1 }));
    const late = run(world, standing(), 120, (i) => ({ jump: i === 1, release: i > 30 }));
    expect(late.map((p) => p.y)).toEqual(held.map((p) => p.y));
  });

  it('allows a jump just after running off an edge, but not later', () => {
    const { world } = testLevel([ground(0, ANCHOR_X + 60)], { speed: 200 });
    const offEdge = run(world, standing(), 60, () => NOTHING).find((p) => !p.grounded)!;
    const t = (offEdge.x - ANCHOR_X) / 200;
    const soon = stepPlayer(offEdge, { jump: true }, world, t + PHYSICS_DT);
    expect(soon.vy).toBe(JUMP_VELOCITY - GRAVITY * PHYSICS_DT);
    const steps = Math.ceil(COYOTE_TIME / PHYSICS_DT) + 1;
    const late = run(world, offEdge, steps, () => NOTHING, t).pop()!;
    const after = t + (steps + 1) * PHYSICS_DT;
    expect(stepPlayer(late, { jump: true }, world, after).vy).toBeLessThan(0);
  });

  it('holds the cube level for the dash’s time, once per time in the air', () => {
    const { world } = testLevel([ground(0, 4000)], { speed: 0 });
    // Jump, dash near the top, try dashing again.
    const trace = run(world, standing(), 90, (i) => ({
      jump: i === 1,
      dash: i === 15 || i === 40,
    }));
    const dashed = trace[15]!;
    const steps = Math.round(DASH_TIME / PHYSICS_DT);
    for (let i = 15; i < 15 + steps; i++) {
      expect(trace[i]!.y).toBeCloseTo(dashed.y, 6);
      expect(trace[i]!.vy).toBe(0);
    }
    // Then gravity again, and the second press in the air does nothing.
    expect(trace[15 + steps + 1]!.y).toBeLessThan(dashed.y);
    expect(trace[40]!.dashReady).toBe(false);
    expect(trace[41]!.y).toBeLessThan(trace[40]!.y);
  });

  it('refills the dash on landing, and dashes on the ground too', () => {
    const { world } = testLevel([ground(0, 4000)], { speed: 0 });
    const trace = run(world, standing(), 120, (i) => ({ jump: i === 1, dash: i === 10 }));
    const landed = trace.findIndex((p, i) => i > 10 && p.grounded);
    expect(trace[landed]!.dashReady).toBe(true);
    const onGround = stepPlayer(trace[landed]!, { jump: false, dash: true }, world, 3);
    expect(onGround.dashLeft).toBeGreaterThan(0);
    expect(onGround.grounded).toBe(true);
  });

  it('dashes level across a pit from the ground', () => {
    // Off the edge mid-dash: the cube holds its height until the dash runs out.
    const { world } = testLevel([ground(0, ANCHOR_X + 30), ground(ANCHOR_X + 30 + 40, 4000)], {
      speed: 200,
    });
    const trace = run(world, standing(), 60, (i) => ({ jump: false, dash: i === 2 }));
    expect(trace.every((p) => p.alive)).toBe(true);
    expect(trace.every((p) => p.y === 0)).toBe(true);
  });

  it('slams down fast from the air, and lands', () => {
    const { world } = testLevel([ground(0, 4000)], { speed: 0 });
    const trace = run(world, standing(), 60, (i) => ({ jump: i === 1, slam: i === 12 }));
    expect(trace[12]!.slamming).toBe(true);
    expect(trace[12]!.vy).toBe(-SLAM_SPEED);
    const landed = trace.findIndex((p, i) => i > 12 && p.grounded);
    // From about 110 px up at 1600 px/s: four or five steps.
    expect(landed - 12).toBeLessThanOrEqual(6);
    expect(trace[landed]!.slamming).toBe(false);
    // On the ground, a slam does nothing.
    expect(stepPlayer(trace[landed]!, { jump: false, slam: true }, world, 2).slamming).toBe(false);
  });

  it('dies running into the side of a taller column', () => {
    const { world } = testLevel([ground(0, ANCHOR_X + 100), ground(ANCHOR_X + 100, 4000, 60)], {
      speed: 200,
    });
    const end = run(world, standing(), 60, () => NOTHING).pop()!;
    expect(end.alive).toBe(false);
    expect(end.death).toBe('wall');
    // Stepping up a few px is fine.
    const low = testLevel([ground(0, ANCHOR_X + 100), ground(ANCHOR_X + 100, 4000, 5)], {
      speed: 200,
    });
    expect(run(low.world, standing(), 60, () => NOTHING).pop()!.y).toBe(5);
  });

  it('dies into an overhang that is too low, and passes under one on the ground', () => {
    const level = (bottom: number) =>
      testLevel([ground(0, 4000), overhang(ANCHOR_X + 120, ANCHOR_X + 300, bottom)], {
        speed: 200,
      }).world;
    const under = run(level(PLAYER_HEIGHT + 10), standing(), 120, () => NOTHING);
    expect(under.every((p) => p.alive)).toBe(true);
    // A full jump just before it is still high when it comes.
    const jumped = run(level(PLAYER_HEIGHT + 10), standing(), 120, (i) => ({ jump: i === 20 }));
    expect(jumped.pop()!.death).toBe('wall');
    // A slam brings the cube back under in time.
    const slammed = run(level(PLAYER_HEIGHT + 10), standing(), 120, (i) => ({
      jump: i === 20,
      slam: i === 23,
    }));
    expect(slammed.every((p) => p.alive)).toBe(true);
  });

  it('bumps its head under an overhang', () => {
    const { world } = testLevel([ground(0, 4000), overhang(0, 4000, PLAYER_HEIGHT + 30)], {
      speed: 0,
    });
    const trace = run(world, standing(), 40, (i) => ({ jump: i === 1 }));
    expect(peakOf(trace)).toBeCloseTo(30, 6);
    expect(trace.every((p) => p.alive)).toBe(true);
  });

  it('dies at a dash gate unless dashing through it', () => {
    const gate = { x: ANCHOR_X + PLAYER_WIDTH + 100, time: 0.5, at: 0.5, top: 0 };
    const { world } = testLevel([ground(0, 4000)], { speed: 200, gates: [gate] });
    const walked = run(world, standing(), 60, () => NOTHING).pop()!;
    expect(walked.death).toBe('gate');
    // Dashing from a little before the gate's time.
    const dashed = run(world, standing(), 60, (i) => ({ jump: false, dash: i === 25 }));
    expect(dashed.every((p) => p.alive)).toBe(true);
    // A dash that ran out before it is no use.
    const early = run(world, standing(), 60, (i) => ({ jump: false, dash: i === 5 }));
    expect(early.pop()!.death).toBe('gate');
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
    const trace = run(world, standing(), 120, () => NOTHING);
    expect(trace[50]!.y).toBe(0);
    expect(trace[trace.length - 1]!.alive).toBe(false);
  });

  it('is cut by spikes when they are out, not when they are in', () => {
    const spikes = [{ x0: ANCHOR_X, x1: ANCHOR_X + 40, top: 0 }];
    const { world } = testLevel([ground(0, 2000)], { speed: 0, spikes });
    // The grid: beats every 0.5 s, spikes out from each off-beat to the next beat.
    expect(stepPlayer(standing(), NOTHING, world, 0.1).alive).toBe(true);
    const cut = stepPlayer(standing(), NOTHING, world, 0.3);
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
    const trace = run(world, standing(), 90, () => NOTHING);
    expect(trace[45]!.y).toBeCloseTo(80); // 0.75 s
    expect(trace[90]!.y).toBeCloseTo(20); // 1.5 s
    expect(trace.every((p) => p.grounded)).toBe(true);
  });
});
