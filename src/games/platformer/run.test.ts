import { describe, expect, it } from 'vitest';
import { steadyGrid, type Section } from '../../core';
import type { Chunk } from './level';
import { ground, testLevel } from './level/test-level';
import { ANCHOR_X, JUMP_AIR, PHYSICS_DT, PLAYER_WIDTH } from './physics';
import { stepAt } from './level/validate';
import {
  ACCENT_FACTOR,
  checkpointsOf,
  CLEAN_BONUS,
  COMBO_STEP,
  DEATH_TIME,
  DOWNBEAT_BONUS,
  GOOD_WINDOW,
  judgeAt,
  MAGNET_BEATS,
  METER_GEM,
  multiplierOf,
  offBeat,
  OVERDRIVE_BEATS,
  OVERDRIVE_FACTOR,
  PERFECT_WINDOW,
  PlatformerRun,
  POINTS,
  rankOf,
  RESUME_BEATS,
  STREAK_BONUS,
  STREAK_PERFECTS,
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
  style: 'contour',
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
    expect(from).toBeCloseTo(run.resumeAt - RESUME_BEATS * 0.5);
    expect(run.countInBeats).toBe(RESUME_BEATS);
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

    // A bar at 120 BPM before the start.
    expect(run.respawn()).toBeCloseTo(-2);
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
    expect(events).toContainEqual({
      type: 'pickup',
      index: 0,
      points: POINTS.coin,
      pulled: false,
    });
    expect(run.score).toBe(POINTS.coin);
    expect(run.isCollected(0)).toBe(true);

    play(run, 0.32, 2, NOTHING);
    expect(run.phase).toBe('dying');
    expect(run.score).toBe(0);
    expect(run.isCollected(0)).toBe(false);
    expect(run.results().bestCombo).toBe(1);
  });

  it('rates takeoffs and landings by how close to a beat or an eighth they are', () => {
    // Beats every 0.5 s. A jump on the beat at 1 s lands about 0.683 s later: 0.067 s
    // before the eighth at 1.75 s, good. One at 1.11 s is off both the beat and the eighth.
    const { level } = testLevel([ground(-40, 5000)], { speed: 0, duration: 10 });
    const run = new PlatformerRun(level, []);
    run.update(0, NOTHING);
    play(run, PHYSICS_DT, 1 - PHYSICS_DT, NOTHING);
    let events = run.update(1, JUMP).events.concat(play(run, 1 + PHYSICS_DT, 2, HOLD));
    let beats = events.filter((e) => e.type === 'beat');
    expect(beats[0]).toMatchObject({ type: 'beat', action: 'takeoff', quality: 'perfect' });
    expect(beats[1]).toMatchObject({ type: 'beat', action: 'land', quality: 'good' });
    expect(run.combo).toBe(2);
    play(run, 2 + PHYSICS_DT, 3.1, NOTHING);
    events = run.update(3.1 + PHYSICS_DT, JUMP).events;
    beats = events.filter((e) => e.type === 'beat');
    expect(beats[0]).toMatchObject({ action: 'takeoff', quality: 'miss', points: 0 });
    expect(run.combo).toBe(0);
    expect(run.results()).toMatchObject({ perfect: 1, good: 1, miss: 1 });
    expect(run.results().accuracy).toBeCloseTo(2 / 3);
  });

  it('judges a takeoff at the song time it was pressed at, the input lead before it acts', () => {
    // Moved on 80 ms ahead of the heard song: a jump acting at 1.08 s was pressed on the
    // beat at 1 s.
    const { level } = testLevel([ground(-40, 5000)], { speed: 0, duration: 10 });
    const run = new PlatformerRun(level, []);
    run.inputLead = 0.08;
    run.update(0, NOTHING);
    play(run, PHYSICS_DT, 1.08 - PHYSICS_DT, NOTHING);
    const beats = run.update(1.08, JUMP).events.filter((e) => e.type === 'beat');
    expect(beats[0]).toMatchObject({ action: 'takeoff', quality: 'perfect' });
  });

  it('breaks a slam plate the player slams through, and mends it on a death before it', () => {
    // Standing on a plate 60 px over the ground from the start; a slam an instant after a
    // jump starts just above it and goes through on its first step.
    const { level } = testLevel(
      [{ kind: 'plate', x0: -40, x1: 5000, top: 60 }, ground(-40, 5000)],
      { speed: 0, duration: 10, start: { x: ANCHOR_X, y: 60 } },
    );
    const run = new PlatformerRun(level, []);
    run.update(0, NOTHING);
    play(run, PHYSICS_DT, 1, NOTHING);
    run.update(1 + PHYSICS_DT, JUMP);
    const events = run.update(1 + 2 * PHYSICS_DT, { ...HOLD, slamPressed: true }).events;
    events.push(...play(run, 1 + 3 * PHYSICS_DT, 1.5, NOTHING));
    expect(events.some((e) => e.type === 'plate')).toBe(true);
    expect([...run.brokenAt.keys()]).toHaveLength(1);
    expect(run.player.y).toBe(0);
    // Back at the checkpoint (the start), the plate is whole again.
    run.respawn();
    expect(run.brokenAt.size).toBe(0);
  });

  it('leaves a landing off the grid unjudged, so it never breaks the combo', () => {
    // A jump at 1.2 s, near the beat at 1.25 s, lands about 1.883 s: an eighth from the grid.
    const { level } = testLevel([ground(-40, 5000)], { speed: 0, duration: 10 });
    const run = new PlatformerRun(level, []);
    run.update(0, NOTHING);
    play(run, PHYSICS_DT, 1.2 - PHYSICS_DT, NOTHING);
    const events = run.update(1.2, JUMP).events.concat(play(run, 1.2 + PHYSICS_DT, 2.2, HOLD));
    const beats = events.filter((e) => e.type === 'beat');
    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({ action: 'takeoff' });
    expect(run.player.grounded).toBe(true);
    expect(run.combo).toBe(1);
    expect(run.results().miss).toBe(0);
  });

  it('scores a slam landing on a kick as an accent', () => {
    const { level } = testLevel([ground(-40, 5000)], { speed: 0, duration: 10 });
    const run = new PlatformerRun(level, [], { kicks: [0.5], snares: [] });
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
    expect(slam).toMatchObject({ accent: true });
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

/** Run step by step from `from` to `to`, pressing what `at(t)` says on each step. */
function drive(
  run: PlatformerRun,
  from: number,
  to: number,
  at: (t: number) => Partial<RunInput> = () => ({}),
) {
  const events: RunEvent[] = [];
  for (let k = stepAt(from); k * PHYSICS_DT <= to + 1e-9; k++) {
    const t = k * PHYSICS_DT;
    events.push(...run.update(t, { ...NOTHING, ...at(t) }).events);
  }
  return events;
}

/** True on the step nearest to one of `times`. */
const on = (t: number, times: number[]) => times.some((x) => Math.abs(x - t) < PHYSICS_DT / 2);
/** Dash on the ground on each of `times`. */
const dashOn = (times: number[]) => (t: number) => ({ dashPressed: on(t, times) });
/** The beats from `from` to `to`, every 0.5 s. */
const beatsFrom = (from: number, to: number) =>
  Array.from({ length: Math.round((to - from) / 0.5) + 1 }, (_, i) => from + i * 0.5);
const flat = (duration = 30, speed = 0) =>
  testLevel([ground(-40, 20000)], { speed, duration }).level;

describe('PlatformerRun: judging, combo and overdrive', () => {
  it('judges against the nearest beat or eighth, with tighter windows on fast songs', () => {
    const grid = steadyGrid(0, 0.5, 10);
    expect(judgeAt(grid, 1.04)).toBe('perfect');
    expect(judgeAt(grid, 0.96)).toBe('perfect');
    expect(judgeAt(grid, 1.07)).toBe('good');
    expect(judgeAt(grid, 1.11)).toBe('miss');
    // The eighth between two beats counts too.
    expect(judgeAt(grid, 1.27)).toBe('perfect');
    expect(judgeAt(grid, 1.18)).toBe('good');
    // At 171 BPM an eighth is 0.175 s: the windows shrink to a share of it.
    const fast = steadyGrid(0, 0.35, 10);
    expect(judgeAt(fast, 0.7 + 0.04)).toBe('good');
    expect(judgeAt(fast, 0.7 + 0.07)).toBe('miss');
    expect(PERFECT_WINDOW).toBeLessThan(GOOD_WINDOW);
  });

  it('chains the combo with judged actions and pickups, and an off-beat action breaks it', () => {
    const level = flat();
    level.pickups.push({ kind: 'coin', x: ANCHOR_X + 14, y: 20, time: 0 });
    const run = new PlatformerRun(level, []);
    const events = drive(run, 0, 2.2, dashOn([0.5, 1, 1.5, 2]));
    expect(
      events.filter((e) => e.type === 'beat').map((e) => e.type === 'beat' && e.quality),
    ).toEqual(['perfect', 'perfect', 'perfect', 'perfect']);
    expect(run.combo).toBe(5);
    // A dash 0.12 s after the beat is a miss: the combo breaks.
    const miss = drive(run, 2.2 + PHYSICS_DT, 2.8, dashOn([2.62]));
    expect(miss).toContainEqual(expect.objectContaining({ type: 'beat', quality: 'miss' }));
    expect(run.combo).toBe(0);
    expect(run.results().bestCombo).toBe(5);
  });

  it('doubles a dash on a snare as an accent', () => {
    const run = new PlatformerRun(flat(), [], { kicks: [], snares: [1] });
    const events = drive(run, 0, 1.6, dashOn([0.5, 1, 1.5]));
    const dashes = events.filter((e) => e.type === 'beat');
    expect(dashes.map((e) => e.type === 'beat' && e.accent)).toEqual([false, true, false]);
    expect(dashes[1]).toMatchObject({ points: POINTS.perfect * ACCENT_FACTOR });
  });

  it('bursts for a bonus after a streak of perfects', () => {
    const run = new PlatformerRun(flat(), []);
    const events = drive(run, 0, 5.2, dashOn(beatsFrom(0.5, 5)));
    const streak = events.find((e) => e.type === 'streak');
    expect(streak).toMatchObject({
      count: STREAK_PERFECTS,
      points: STREAK_BONUS * multiplierOf(STREAK_PERFECTS),
    });
  });

  it('fills the meter with perfects and gems, and runs overdrive for 4 bars at double score', () => {
    const level = flat();
    level.pickups.push({ kind: 'gem', x: ANCHOR_X + 14, y: 20, time: 0 });
    const run = new PlatformerRun(level, []);
    // Not full: pressing does nothing.
    drive(run, 0, 0.2, (t) => ({ overdrivePressed: on(t, [0.1]) }));
    expect(run.meter).toBeCloseTo(METER_GEM);
    expect(run.overdriveAt(0.2)).toBe(false);
    // A gem and nine perfects fill it.
    drive(run, 0.2 + PHYSICS_DT, 4.7, dashOn(beatsFrom(0.5, 4.5)));
    expect(run.meter).toBe(1);

    // Off the downbeat: no bonus. The downbeats are every 2 s.
    const score = run.score;
    const events = drive(run, 4.7 + PHYSICS_DT, 5.2, (t) => ({
      overdrivePressed: on(t, [4.75]),
      dashPressed: on(t, [5]),
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'overdrive', downbeat: false }));
    expect(run.meter).toBe(0);
    const until = 4.75 + OVERDRIVE_BEATS * 0.5;
    expect(run.overdrive.until).toBeCloseTo(until);
    const dash = events.find((e) => e.type === 'beat');
    const mult = multiplierOf(run.combo);
    expect(dash).toMatchObject({ points: POINTS.perfect * mult * OVERDRIVE_FACTOR });
    // Everything scored in the meantime: the dash and its streak's bonus, both doubled.
    const scored = events.reduce((sum, e) => sum + ('points' in e ? e.points : 0), 0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'streak', points: STREAK_BONUS * mult * OVERDRIVE_FACTOR }),
    );
    expect(run.score).toBe(score + scored);
    // The meter doesn't fill while it runs; after 4 bars it's over.
    drive(run, 5.2 + PHYSICS_DT, until + 0.6, dashOn(beatsFrom(5.5, 12.5)));
    expect(run.meter).toBe(0);
    expect(run.overdriveAt(until - 0.01)).toBe(true);
    expect(run.overdriveAt(until + 0.01)).toBe(false);
    expect(run.results().overdrives).toBe(1);
  });

  it('gives a bonus for overdrive on a downbeat', () => {
    const run = new PlatformerRun(flat(), []);
    drive(run, 0, 6.2, dashOn(beatsFrom(0.5, 6)));
    expect(run.meter).toBe(1);
    const score = run.score;
    const events = drive(run, 6.2 + PHYSICS_DT, 8.1, (t) => ({ overdrivePressed: on(t, [8.03]) }));
    const points = DOWNBEAT_BONUS * run.multiplier;
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'overdrive', downbeat: true, points }),
    );
    expect(run.score).toBe(score + points);
  });

  it('gives a clean section bonus at the section change, unless there was a hit', () => {
    const level = flat(10, 100);
    level.chunks.push(chunk(0, 3), chunk(3, 6), chunk(6, 10));
    const run = new PlatformerRun(level, [section(0, 3), section(3, 6), section(6, 10)]);
    const events = drive(run, 0, 3.2);
    expect(events).toContainEqual({ type: 'clean', points: CLEAN_BONUS });
    expect(run.score).toBe(CLEAN_BONUS);
    expect(run.results()).toMatchObject({ clean: 1, sections: 3 });
  });
});

describe('PlatformerRun: boosters', () => {
  /** Ground, a pit the player falls into at about 0.95 s, then ground from x 700. */
  const pitLevel = () =>
    testLevel([ground(-40, 400), ground(700, 20000)], { speed: 200, duration: 10 }).level;
  const shieldAtStart = { kind: 'shield', x: ANCHOR_X + 14, y: 20, time: 0 } as const;

  it('survives a pit fall with a shield, bouncing onto the nearest safe ground', () => {
    const level = pitLevel();
    level.pickups.push(shieldAtStart);
    const run = new PlatformerRun(level, []);
    drive(run, 0, 0.1);
    expect(run.boosters.shield).toBe(true);
    expect(run.combo).toBe(1);
    const events = drive(run, 0.1 + PHYSICS_DT, 2.5);
    expect(events.some((e) => e.type === 'death')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'shield' }));
    expect(run.phase).toBe('playing');
    expect(run.deaths).toBe(0);
    expect(run.boosters.shield).toBe(false);
    // A hit breaks the combo.
    expect(run.combo).toBe(0);
    // Back on the ground past the pit, running on.
    expect(run.player).toMatchObject({ alive: true, grounded: true, y: 0 });
    expect(run.player.x).toBeGreaterThan(700);
    expect(run.rescue).toBeNull();
    expect(run.results().saves).toBe(1);
  });

  it('bounces up onto a wall it would have run into', () => {
    const { level } = testLevel([ground(-40, 500), ground(500, 20000, 80)], { speed: 200 });
    level.pickups.push(shieldAtStart);
    const run = new PlatformerRun(level, []);
    drive(run, 0, 2);
    expect(run.deaths).toBe(0);
    expect(run.player).toMatchObject({ alive: true, grounded: true, y: 80 });
  });

  it('dies after all when there is no safe ground within reach', () => {
    const { level } = testLevel([ground(-40, 400)], { speed: 200, duration: 10 });
    level.pickups.push(shieldAtStart);
    const run = new PlatformerRun(level, []);
    const events = drive(run, 0, 2);
    expect(events.some((e) => e.type === 'death')).toBe(true);
  });

  it('pulls coins from afar while the magnet lasts', () => {
    const level = flat(30, 100);
    level.pickups.push(
      { kind: 'magnet', x: ANCHOR_X + 14, y: 20, time: 0 },
      // 60 px over the head at 1 s: out of reach without the magnet.
      { kind: 'coin', x: ANCHOR_X + 100 + 14, y: 100, time: 1 },
      // Long after the magnet's 4 bars.
      { kind: 'coin', x: ANCHOR_X + 1200 + 14, y: 100, time: 12 },
    );
    const run = new PlatformerRun(level, []);
    const events = drive(run, 0, 13);
    expect(run.boosters.magnetUntil).toBeCloseTo(MAGNET_BEATS * 0.5, 1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'pickup', index: 1, pulled: true }),
    );
    expect(run.isCollected(2)).toBe(false);
  });

  it('gives a second dash in the air until the next landing', () => {
    const tryTwice = (extra: boolean) => {
      const level = flat();
      if (extra) level.pickups.push({ kind: 'dash', x: ANCHOR_X + 14, y: 20, time: 0 });
      const run = new PlatformerRun(level, []);
      drive(run, 0, 0.5, (t) => ({
        jumpPressed: on(t, [0.1]),
        jumpHeld: true,
        dashPressed: on(t, [0.15]),
      }));
      const first = run.dashedAt;
      drive(run, 0.5 + PHYSICS_DT, 0.55, (t) => ({ dashPressed: on(t, [0.55]) }));
      return { run, first, second: run.dashedAt };
    };
    const without = tryTwice(false);
    expect(without.second).toBe(without.first);
    const withIt = tryTwice(true);
    expect(withIt.second).toBeCloseTo(0.55);
    // Used up.
    expect(withIt.run.boosters.extraDash).toBe(false);
  });

  it('loses an unused extra dash on landing', () => {
    const level = flat();
    level.pickups.push({ kind: 'dash', x: ANCHOR_X + 14, y: 20, time: 0 });
    const run = new PlatformerRun(level, []);
    drive(run, 0, 0.3, (t) => ({ jumpPressed: on(t, [0.1]), jumpHeld: true }));
    expect(run.boosters.extraDash).toBe(true);
    drive(run, 0.3 + PHYSICS_DT, 1.2);
    expect(run.player.grounded).toBe(true);
    expect(run.boosters.extraDash).toBe(false);
  });
});

describe('PlatformerRun: checkpoints', () => {
  it('puts the score, combo, meter and boosters back as they were at the checkpoint', () => {
    // Ground to x 1000, a checkpoint at 2 s (x 688), the pit at about 3.6 s.
    const { level } = testLevel([ground(-40, 1000)], { speed: 200, duration: 10 });
    level.chunks.push(chunk(0, 2), chunk(2, 10));
    level.pickups.push(
      { kind: 'magnet', x: ANCHOR_X + 100 + 14, y: 20, time: 0.5 },
      { kind: 'dash', x: ANCHOR_X + 500 + 14, y: 20, time: 2.5 },
    );
    const run = new PlatformerRun(level, [section(0, 2), section(2, 10)]);
    drive(run, 0, 1.9, dashOn([0.5, 1, 1.5]));
    const at = {
      score: run.score + CLEAN_BONUS,
      combo: run.combo,
      meter: run.meter,
      boosters: run.boosters,
    };
    expect(at.combo).toBe(4);
    expect(at.boosters.magnetUntil).toBeGreaterThan(2);
    drive(run, 1.9 + PHYSICS_DT, 3, dashOn([2.5, 3]));
    expect(run.boosters.extraDash).toBe(true);
    expect(run.combo).toBe(7);
    drive(run, 3 + PHYSICS_DT, 5);
    expect(run.phase).toBe('dying');
    expect(run.score).toBe(at.score);
    expect(run.combo).toBe(at.combo);
    expect(run.meter).toBeCloseTo(at.meter);
    expect(run.boosters).toEqual(at.boosters);
    expect(run.isCollected(0)).toBe(true);
    expect(run.isCollected(1)).toBe(false);
    expect(run.results().bestCombo).toBe(7);
    run.respawn();
    expect(run.player.x).toBeCloseTo(400 + ANCHOR_X);
  });
});

describe('rankOf', () => {
  it('ranks by timing and deaths, with clear thresholds', () => {
    expect(rankOf(0.9, 0)).toBe('S');
    expect(rankOf(0.9, 1)).toBe('A');
    expect(rankOf(0.72, 2)).toBe('A');
    expect(rankOf(0.72, 3)).toBe('B');
    expect(rankOf(0.5, 9)).toBe('B');
    expect(rankOf(0.49, 0)).toBe('C');
    expect(rankOf(null, 0)).toBe('C');
  });
});

describe('checkpointsOf', () => {
  it('puts one at the start and one where each section’s stretch starts, on its ground', () => {
    // At 3 s the anchored player is at 100 · 3 + ANCHOR_X; the box reaches over the step
    // 12 px past that, so they stand on the higher ground.
    const step = 300 + ANCHOR_X + 12;
    const { level } = testLevel([ground(-40, step, 10), ground(step, 2000, 50)], { speed: 100 });
    level.chunks.push(chunk(0, 3, 'run-in'), chunk(3, 5), chunk(5, 7));
    const points = checkpointsOf(level, [section(0, 4), section(4, 6), section(6, 9)]);
    expect(points.map((p) => p.time)).toEqual([0, 3, 5]);
    expect(points[1]).toMatchObject({ x: 300 + ANCHOR_X, y: 50 });
  });
});

describe('scoring helpers', () => {
  it('measures how far a moment is from the nearest beat', () => {
    const grid = steadyGrid(0.1, 0.5, 10);
    expect(offBeat(grid, 1.1)).toBeCloseTo(0);
    expect(offBeat(grid, 1.2)).toBeCloseTo(0.1);
    expect(offBeat(grid, 1.0)).toBeCloseTo(0.1);
  });

  it('measures it at the tempo of the moment when the tempo changes', () => {
    // 120 BPM until 4 s, then 150 BPM.
    const grid = {
      segments: [
        { start: 0, end: 4, tempo: 120, beatPeriod: 0.5 },
        { start: 4, end: 10, tempo: 150, beatPeriod: 0.4 },
      ],
      beats: [...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], ...[4, 4.4, 4.8, 5.2, 5.6, 6]],
      downbeats: [0, 2, 4, 5.6],
    };
    expect(offBeat(grid, 3.6)).toBeCloseTo(0.1);
    expect(offBeat(grid, 4.45)).toBeCloseTo(0.05);
    expect(offBeat(grid, 4.6)).toBeCloseTo(0.2);
  });

  it('raises the multiplier with the combo, up to its most', () => {
    expect(multiplierOf(0)).toBe(1);
    expect(multiplierOf(COMBO_STEP)).toBe(2);
    expect(multiplierOf(100)).toBe(4);
  });
});
