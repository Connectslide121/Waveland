import { describe, expect, it } from 'vitest';
import type { Section } from '../../core';
import type { Chunk } from './level';
import { ground, testLevel } from './level/test-level';
import { ANCHOR_X, JUMP_AIR, PHYSICS_DT, PLAYER_WIDTH } from './physics';
import {
  ACCENT_FACTOR,
  checkpointsOf,
  COMBO_STEP,
  DEATH_TIME,
  RESUME_BEATS,
  multiplierOf,
  offBeat,
  PlatformerRun,
  POINTS,
  type RunEvent,
  type RunInput,
} from './run';

const NOTHING: RunInput = {
  jumpHeld: false,
  jumpPressed: false,
  dashPressed: false,
  slamPressed: false,
};
const HOLD: RunInput = { ...NOTHING, jumpHeld: true };
const JUMP: RunInput = { ...HOLD, jumpPressed: true };

const section = (start: number, end: number): Section => ({
  start,
  end,
  kind: 'main',
  energy: 0.5,
});

const chunk = (start: number, end: number, kind: Chunk['kind'] = 'flat'): Chunk => ({
  kind,
  planned: kind,
  start,
  end,
  x0: 0,
  x1: 0,
  section: 'main',
  repairs: 0,
});

/** Feed the run frames of `frame` seconds from `from` to `to`. */
function play(run: PlatformerRun, from: number, to: number, input: RunInput, frame = 1 / 60) {
  const events: RunEvent[] = [];
  for (let t = from; t <= to + 1e-9; t += frame) events.push(...run.update(t, input).events);
  return events;
}

describe('PlatformerRun', () => {
  it('keeps the player where song time puts them, whatever the frames', () => {
    const { level } = testLevel([ground(-40, 5000)], { speed: 100, duration: 10 });
    const run = new PlatformerRun(level, []);
    expect(run.countInFrom).toBeCloseTo(-2);
    run.update(-1, NOTHING);
    expect(run.phase).toBe('countin');
    expect(run.player.x).toBe(level.start.x);

    run.update(0, NOTHING);
    expect(run.phase).toBe('playing');
    // Uneven frames, even one long stall, give the same place as smooth ones.
    run.update(0.37, NOTHING);
    run.update(1, NOTHING);
    expect(run.player.x).toBeCloseTo(ANCHOR_X + 100, 6);
  });

  it('counts in again after a pause, holding the player where they stopped', () => {
    const { level } = testLevel([ground(-40, 5000)], { speed: 100, duration: 10 });
    const run = new PlatformerRun(level, []);
    play(run, 0, 1, NOTHING);
    const stopped = run.player.x;
    const from = run.holdForResume();
    expect(run.phase).toBe('countin');
    expect(from).toBeCloseTo(run.resumeAt - RESUME_BEATS * level.beatPeriod);
    expect(run.resumeAt).toBeCloseTo(1, 1);

    // The music plays the beats before; the player waits, then runs on from there.
    play(run, from, run.resumeAt - 0.01, NOTHING);
    expect(run.player.x).toBe(stopped);
    play(run, run.resumeAt, run.resumeAt + 0.2, NOTHING);
    expect(run.phase).toBe('playing');
    expect(run.player.x).toBeCloseTo(stopped + 100 * 0.2, 0);
  });

  it('jumps on landing when jump was pressed just before it', () => {
    const { level } = testLevel([ground(-40, 5000)], { speed: 0, duration: 10 });
    const run = new PlatformerRun(level, []);
    run.update(0, NOTHING);
    run.update(PHYSICS_DT, JUMP);
    expect(run.player.vy).toBeGreaterThan(0);
    expect(run.jumpedAt).toBeCloseTo(PHYSICS_DT);
    // Up and down: press again 3 steps before landing.
    play(run, 2 * PHYSICS_DT, JUMP_AIR - 3 * PHYSICS_DT, HOLD);
    expect(run.player.grounded).toBe(false);
    run.update(JUMP_AIR - 2 * PHYSICS_DT, JUMP);
    play(run, JUMP_AIR, JUMP_AIR + 0.1, HOLD);
    expect(run.player.grounded).toBe(false);
    expect(run.player.y).toBeGreaterThan(20);
  });

  it('dashes and slams from presses, through the same fixed steps', () => {
    const { level } = testLevel([ground(-40, 5000)], { speed: 0, duration: 10 });
    const run = new PlatformerRun(level, []);
    run.update(0, NOTHING);
    run.update(0.1, JUMP);
    play(run, 0.1 + PHYSICS_DT, 0.3, HOLD);
    run.update(0.3 + PHYSICS_DT, { ...HOLD, dashPressed: true });
    expect(run.player.dashLeft).toBeGreaterThan(0);
    expect(run.dashedAt).toBeCloseTo(0.3 + PHYSICS_DT, 6);
    const held = run.player.y;
    play(run, 0.3 + 2 * PHYSICS_DT, 0.45, HOLD);
    expect(run.player.y).toBeCloseTo(held, 6);
    // Pressed in a frame: it acts on the frame's first step, and is down by its end.
    run.update(0.6, { ...NOTHING, slamPressed: true });
    expect(run.slammedAt).toBeCloseTo(0.45 + PHYSICS_DT, 6);
    // A slam press only counts in its own frame: not held over to cut a later jump.
    play(run, 0.6 + PHYSICS_DT, 0.8, NOTHING);
    expect(run.player.grounded).toBe(true);
    run.update(0.8 + PHYSICS_DT, JUMP);
    play(run, 0.8 + 2 * PHYSICS_DT, 0.95, HOLD);
    expect(run.player.slamming).toBe(false);
    expect(run.player.y).toBeGreaterThan(60);
  });

  it('dies into a pit, plays the death, then counts in again from the checkpoint', () => {
    const { level } = testLevel([ground(-40, 400)], { speed: 200, duration: 10 });
    const run = new PlatformerRun(level, []);
    const events = play(run, 0, 2, NOTHING);
    expect(events.some((e) => e.type === 'death' && e.cause === 'pit')).toBe(true);
    expect(run.phase).toBe('dying');
    expect(run.deaths).toBe(1);
    expect(run.deathCause).toBe('pit');
    expect(run.update(run.diedAt + DEATH_TIME / 2, NOTHING).respawn).toBe(false);
    expect(run.update(run.diedAt + DEATH_TIME, NOTHING).respawn).toBe(true);

    expect(run.respawn()).toBeCloseTo(-run.bar);
    expect(run.phase).toBe('countin');
    expect(run.player.x).toBe(level.start.x);
    expect(run.player.alive).toBe(true);
  });

  it('dies into a wall it can’t stop at', () => {
    const { level } = testLevel([ground(-40, 500), ground(500, 5000, 80)], { speed: 200 });
    const run = new PlatformerRun(level, []);
    const events = play(run, 0, 2, NOTHING);
    expect(events).toContainEqual(expect.objectContaining({ type: 'death', cause: 'wall' }));
  });

  it('scores pickups with the combo, and gives them back after a death', () => {
    const { level } = testLevel([ground(-40, 420)], { speed: 200, duration: 10 });
    level.pickups.push({ kind: 'coin', x: ANCHOR_X + 40 + PLAYER_WIDTH / 2, y: 20, time: 0.2 });
    const run = new PlatformerRun(level, []);
    const events = play(run, 0, 0.3, NOTHING);
    expect(events).toContainEqual({ type: 'pickup', index: 0, points: POINTS.coin });
    expect(run.score).toBe(POINTS.coin);
    expect(run.isCollected(0)).toBe(true);

    play(run, 0.32, 2, NOTHING);
    expect(run.phase).toBe('dying');
    expect(run.score).toBe(0);
    expect(run.isCollected(0)).toBe(false);
    expect(run.results().bestCombo).toBe(1);
  });

  it('rates takeoffs and landings by how close to a beat they are', () => {
    // Beats every 0.5 s. A jump on the beat at 1 s lands about 0.683 s later: off the beat.
    const { level } = testLevel([ground(-40, 5000)], { speed: 0, duration: 10 });
    const run = new PlatformerRun(level, []);
    run.update(0, NOTHING);
    play(run, PHYSICS_DT, 1 - PHYSICS_DT, NOTHING);
    const events = run.update(1, JUMP).events.concat(play(run, 1 + PHYSICS_DT, 2, HOLD));
    const beats = events.filter((e) => e.type === 'beat');
    expect(beats[0]).toMatchObject({ type: 'beat', action: 'takeoff', quality: 'perfect' });
    expect(beats[1]).toMatchObject({ type: 'beat', action: 'land', quality: 'miss' });
    expect(run.results().accuracy).toBe(0.5);
    expect(run.combo).toBe(0);
  });

  it('scores a slam landing on the beat as an accent', () => {
    const { level } = testLevel([ground(-40, 5000)], { speed: 0, duration: 10 });
    const run = new PlatformerRun(level, []);
    run.update(0, NOTHING);
    run.update(0.25, JUMP);
    play(run, 0.25 + PHYSICS_DT, 0.4, HOLD);
    // From about 120 px up, a slam lands in about five steps: press it to land on 0.5 s.
    let events: RunEvent[] = [];
    for (let t = 0.4 + PHYSICS_DT; t < 0.7 && !run.player.grounded; t += PHYSICS_DT) {
      const y = run.player.y;
      const press = !run.player.slamming && y / 1600 >= 0.5 - t - PHYSICS_DT;
      events = events.concat(run.update(t, { ...HOLD, slamPressed: press }).events);
    }
    const slam = events.find((e) => e.type === 'beat' && e.action === 'slam');
    expect(slam).toMatchObject({ quality: expect.stringMatching(/perfect|good/) });
    expect(run.slamLandedAt).toBeGreaterThan(0.4);
    if (slam?.type === 'beat') expect(slam.points % (POINTS.good * ACCENT_FACTOR)).toBe(0);
  });

  it('finishes when the song ends', () => {
    const { level } = testLevel([ground(-40, 5000)], { speed: 0, duration: 2 });
    const run = new PlatformerRun(level, []);
    play(run, 0, 1.9, NOTHING);
    expect(run.phase).toBe('playing');
    run.update(2, NOTHING);
    expect(run.phase).toBe('finished');
    expect(run.results()).toMatchObject({ deaths: 0, accuracy: null, pickups: 0, totalPickups: 0 });
  });
});

describe('checkpointsOf', () => {
  it('puts one at the start and one where each section’s stretch starts, on its ground', () => {
    const { level } = testLevel([ground(-40, 600, 10), ground(600, 2000, 50)], { speed: 100 });
    level.chunks.push(chunk(0, 3, 'run-in'), chunk(3, 5), chunk(5, 7));
    const points = checkpointsOf(level, [section(0, 4), section(4, 6), section(6, 9)]);
    expect(points.map((p) => p.time)).toEqual([0, 3, 5]);
    // At 3 s the anchored player is at 100 · 3 + 288 = 588; the box reaches over the step
    // at 600, so they stand on the higher ground.
    expect(points[1]).toMatchObject({ x: 588, y: 50 });
  });
});

describe('scoring helpers', () => {
  it('measures how far a moment is from the nearest beat', () => {
    const grid = { gridStart: 0.1, beatPeriod: 0.5 };
    expect(offBeat(grid, 1.1)).toBeCloseTo(0);
    expect(offBeat(grid, 1.2)).toBeCloseTo(0.1);
    expect(offBeat(grid, 1.0)).toBeCloseTo(0.1);
  });

  it('raises the multiplier with the combo, up to its most', () => {
    expect(multiplierOf(0)).toBe(1);
    expect(multiplierOf(COMBO_STEP)).toBe(2);
    expect(multiplierOf(100)).toBe(4);
  });
});
