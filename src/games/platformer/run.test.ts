import { describe, expect, it } from 'vitest';
import type { Section } from '../../core';
import type { Chunk } from './level';
import { ground, testLevel } from './level/test-level';
import { JUMP_VELOCITY, PHYSICS_DT, RUN_SPEED } from './physics';
import {
  checkpointsOf,
  COMBO_STEP,
  DEATH_TIME,
  RESUME_BEATS,
  multiplierOf,
  offBeat,
  PlatformerRun,
  POINTS,
  type RunInput,
} from './run';

const RIGHT: RunInput = { dir: 1, jumpHeld: false, jumpPressed: false };
const STAND: RunInput = { dir: 0, jumpHeld: false, jumpPressed: false };

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
  const events = [];
  for (let t = from; t <= to + 1e-9; t += frame) events.push(...run.update(t, input).events);
  return events;
}

describe('PlatformerRun', () => {
  it('counts in again after a pause, holding the player where they stopped', () => {
    const { level } = testLevel([ground(-40, 5000)], { speed: 100, duration: 10 });
    const run = new PlatformerRun(level, []);
    play(run, 0, 1, RIGHT);
    const stopped = run.player.x;
    const from = run.holdForResume();
    expect(run.phase).toBe('countin');
    expect(from).toBeCloseTo(run.resumeAt - RESUME_BEATS * level.beatPeriod);
    expect(run.resumeAt).toBeCloseTo(1, 1);

    // The music plays the beats before; the player waits, then runs on from there.
    play(run, from, run.resumeAt - 0.01, RIGHT);
    expect(run.player.x).toBe(stopped);
    play(run, run.resumeAt, run.resumeAt + 0.2, RIGHT);
    expect(run.phase).toBe('playing');
    expect(run.player.x).toBeCloseTo(stopped + RUN_SPEED * 0.2, -1);
  });

  it('holds the player through the count-in, then steps the physics on song time', () => {
    const { level } = testLevel([ground(-40, 5000)], { speed: 100, duration: 10 });
    const run = new PlatformerRun(level, []);
    expect(run.countInFrom).toBeCloseTo(-2);
    run.update(-1, RIGHT);
    expect(run.phase).toBe('countin');
    expect(run.player.x).toBe(level.start.x);

    run.update(0, RIGHT);
    expect(run.phase).toBe('playing');
    // Uneven frames, even one long stall, give the same place as smooth ones.
    run.update(0.37, RIGHT);
    run.update(1, RIGHT);
    expect(run.player.x).toBeCloseTo(level.start.x + RUN_SPEED * 1, 0);
  });

  it('jumps on landing when jump was pressed just before it', () => {
    const { level } = testLevel([ground(-40, 5000)], { speed: 0, duration: 10 });
    const run = new PlatformerRun(level, []);
    run.update(0, STAND);
    run.update(PHYSICS_DT, { dir: 0, jumpHeld: true, jumpPressed: true });
    expect(run.player.vy).toBeGreaterThan(0);
    expect(run.jumpedAt).toBeCloseTo(PHYSICS_DT);
    // Up and down: a jump lasts 2 · v / g seconds. Press again 3 steps before landing.
    const air = (2 * JUMP_VELOCITY) / 2400;
    play(run, 2 * PHYSICS_DT, air - 3 * PHYSICS_DT, { dir: 0, jumpHeld: true, jumpPressed: false });
    expect(run.player.grounded).toBe(false);
    run.update(air - 2 * PHYSICS_DT, { dir: 0, jumpHeld: true, jumpPressed: true });
    play(run, air, air + 0.1, { dir: 0, jumpHeld: true, jumpPressed: false });
    expect(run.player.grounded).toBe(false);
    expect(run.player.y).toBeGreaterThan(20);
  });

  it('dies into a pit, plays the death, then counts in again from the checkpoint', () => {
    const { level } = testLevel([ground(-40, 400)], { speed: 0, duration: 10 });
    const run = new PlatformerRun(level, []);
    const events = play(run, 0, 1, RIGHT);
    expect(events.some((e) => e.type === 'death')).toBe(true);
    expect(run.phase).toBe('dying');
    expect(run.deaths).toBe(1);
    expect(run.update(run.diedAt + DEATH_TIME / 2, STAND).respawn).toBe(false);
    expect(run.update(run.diedAt + DEATH_TIME, STAND).respawn).toBe(true);

    expect(run.respawn()).toBeCloseTo(-run.bar);
    expect(run.phase).toBe('countin');
    expect(run.player.x).toBe(level.start.x);
    expect(run.player.alive).toBe(true);
  });

  it('scores pickups with the combo, and gives them back after a death', () => {
    const { level } = testLevel([ground(-40, 420)], { speed: 0, duration: 10 });
    level.pickups.push({ kind: 'coin', x: 360, y: 20, time: 0.2 });
    const run = new PlatformerRun(level, []);
    const events = play(run, 0, 0.3, RIGHT);
    expect(events).toContainEqual({ type: 'pickup', index: 0, points: POINTS.coin });
    expect(run.score).toBe(POINTS.coin);
    expect(run.isCollected(0)).toBe(true);

    play(run, 0.32, 1.5, RIGHT);
    expect(run.phase).toBe('dying');
    expect(run.score).toBe(0);
    expect(run.isCollected(0)).toBe(false);
    expect(run.results().bestCombo).toBe(1);
  });

  it('rates landings by how close to a beat they are', () => {
    // Beats every 0.5 s. A jump from rest lands 2 · 820 / 2400 ≈ 0.683 s later.
    const { level } = testLevel([ground(-40, 5000)], { speed: 0, duration: 10 });
    const run = new PlatformerRun(level, []);
    const air = (2 * JUMP_VELOCITY) / 2400;
    const takeoff = 1.5 - air;
    run.update(0, STAND);
    play(run, PHYSICS_DT, takeoff - PHYSICS_DT, STAND);
    run.update(takeoff, { dir: 0, jumpHeld: true, jumpPressed: true });
    const events = play(run, takeoff + PHYSICS_DT, 2, {
      dir: 0,
      jumpHeld: true,
      jumpPressed: false,
    });
    const land = events.find((e) => e.type === 'land');
    expect(land).toMatchObject({ type: 'land', quality: 'perfect', points: POINTS.perfect });
    expect(run.results().accuracy).toBe(1);
  });

  it('finishes when the song ends', () => {
    const { level } = testLevel([ground(-40, 5000)], { speed: 0, duration: 2 });
    const run = new PlatformerRun(level, []);
    play(run, 0, 1.9, STAND);
    expect(run.phase).toBe('playing');
    run.update(2, STAND);
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
