import { describe, expect, it } from 'vitest';
import {
  ANCHOR_X,
  PHYSICS_DT,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  startState,
  stepPlayer,
  STEP_UP,
} from '../physics';
import {
  clearFrom,
  dashPitAir,
  DASH_REACH,
  gateAt,
  JUMP_REACH,
  pitAt,
  PRESS_GRACE,
  riseTime,
  spikesAt,
} from './generate';
import { steadyScroll, xAtTime, type LevelWorld } from './level';
import { ground, overhang, testLevel } from './test-level';
import { validateLevel } from './validate';

const SPEED = 200;
const x = (t: number) => xAtTime({ scroll: steadyScroll(SPEED) }, t);

/** Ground with one pit the player takes off over at 1 s, needing `air` seconds over it. */
function withPit(air: number, landing = 0) {
  const pit = pitAt(x, 1, air);
  return testLevel([ground(-40, pit.x0), ground(pit.x1, 4000, landing)], { speed: SPEED });
}

describe('validateLevel', () => {
  it('passes plain ground', () => {
    expect(validateLevel(testLevel([ground(-40, 4000)]).level).ok).toBe(true);
  });

  it('passes a pit a jump clears, and stops at one too wide even with a dash', () => {
    expect(validateLevel(withPit(0.5).level).ok).toBe(true);
    const check = validateLevel(withPit(DASH_REACH + 0.3).level);
    expect(check.ok).toBe(false);
    // It got as far as the pit, not further.
    expect(check.reached).toBeGreaterThan(1);
    expect(check.reached).toBeLessThan(1 + DASH_REACH + 0.5);
  });

  it('finds a jump and a dash over a pit too wide to jump', () => {
    const air = dashPitAir(0.6);
    expect(air).toBeGreaterThan(JUMP_REACH);
    expect(validateLevel(withPit(air).level).ok).toBe(true);
  });

  it('fails a ledge too high to jump onto, and passes one a jump reaches', () => {
    const wall = [ground(-40, x(1)), ground(x(1), 4000, 170)];
    expect(validateLevel(testLevel(wall, { speed: SPEED }).level).ok).toBe(false);
    const step = [ground(-40, x(1)), ground(x(1), 4000, 110)];
    expect(validateLevel(testLevel(step, { speed: SPEED }).level).ok).toBe(true);
  });

  it('dashes through gates, one after another', () => {
    const gates = [1, 1.5, 2.5].map((t) => gateAt(x, t, 0));
    expect(validateLevel(testLevel([ground(-40, 4000)], { speed: SPEED, gates }).level).ok).toBe(
      true,
    );
  });

  it('slams under an overhang right after a hop', () => {
    const pit = pitAt(x, 1, 0.2);
    const level = testLevel(
      [
        ground(-40, pit.x0),
        ground(pit.x1, 4000),
        overhang(x(1.45) + PLAYER_WIDTH, x(2.2), PLAYER_HEIGHT + 20),
      ],
      { speed: SPEED },
    ).level;
    expect(validateLevel(level).ok).toBe(true);
    // Not if the overhang is lower than the cube.
    for (const s of level.solids) if (s.kind === 'overhang') s.bottom = PLAYER_HEIGHT - 4;
    expect(validateLevel(level).ok).toBe(false);
  });

  it('crosses a bridge only while it is there', () => {
    // A pit too wide to jump, spanned by a bridge from 1.5 to 3.5 s.
    const pit = (windows: [number, number][]) =>
      testLevel(
        [
          ground(-40, x(1.5)),
          { kind: 'bridge', x0: x(1.5), x1: x(3.5), top: 0, windows },
          ground(x(3.5), 4000),
        ],
        { speed: SPEED },
      ).level;
    expect(validateLevel(pit([[1.4, 3.6]])).ok).toBe(true);
    // Gone while the player is over it.
    expect(validateLevel(pit([[1.4, 2.2]])).ok).toBe(false);
    expect(validateLevel(pit([[0, 0.5]])).ok).toBe(false);
  });

  it('gets past spikes, while they are in or over them', () => {
    const strip = (x0: number, length: number) =>
      testLevel([ground(-40, 4000)], { spikes: [{ x0, x1: x0 + length, top: 0 }] }).level;
    expect(validateLevel(strip(700, 60)).ok).toBe(true);
    // Too long to cross between an off-beat and the next beat: hop along it.
    expect(validateLevel(strip(700, 400)).ok).toBe(true);
  });

  it('starts the search where the player starts', () => {
    expect(testLevel([ground(-40, 4000)]).level.start.x).toBe(ANCHOR_X);
  });
});

/** Run the plain physics from the start with one jump pressed at `pressAt`; alive at `until`? */
function survives(world: LevelWorld, pressAt: number | null, until: number): boolean {
  let p = startState(world.xAt(0), 0);
  // The press acts on the first step at or after it.
  const press = pressAt === null ? -1 : Math.ceil(pressAt / PHYSICS_DT - 1e-9);
  for (let k = 1; k * PHYSICS_DT <= until; k++)
    p = stepPlayer(p, { jump: k === press, release: false }, world, k * PHYSICS_DT);
  return p.alive;
}

describe('obstacles a press on their moment clears', () => {
  const late = PRESS_GRACE + 0.12;

  it('spikes: a jump on the hit, or a grace after it, clears them; one later does not', () => {
    // The hit on the "and" at 1.25 s, so the spikes are out when the player gets there.
    const strip = spikesAt(x, 1.25, 40, 0);
    const { world } = testLevel([ground(-40, 4000)], { speed: SPEED, spikes: [strip] });
    expect(survives(world, null, 2.5)).toBe(false);
    expect(survives(world, 1.25, 2.5)).toBe(true);
    expect(survives(world, 1.25 + PRESS_GRACE, 2.5)).toBe(true);
    expect(survives(world, 1.25 + late, 2.5)).toBe(false);
  });

  it('pits: a jump on the kick is at the edge, and one a little late still makes it', () => {
    const pit = pitAt(x, 1, 0.5);
    // The ground ends under the player's middle on the kick.
    expect(pit.x0).toBeCloseTo(x(1) + PLAYER_WIDTH / 2);
    const { world } = withPit(0.5);
    expect(survives(world, 1, 3)).toBe(true);
    expect(survives(world, 1 + PRESS_GRACE, 3)).toBe(true);
    expect(survives(world, 1 + late + 0.1, 3)).toBe(false);
  });

  it('a step: a jump on its beat is over its riser when the player gets there', () => {
    const rise = 52;
    const riser = clearFrom(x, 1, rise - STEP_UP);
    const { world } = testLevel([ground(-40, riser), ground(riser, 4000, rise)], {
      speed: SPEED,
    });
    expect(survives(world, null, 2.5)).toBe(false);
    expect(survives(world, 1, 2.5)).toBe(true);
    expect(survives(world, 1 + PRESS_GRACE, 2.5)).toBe(true);
    expect(riseTime(rise - STEP_UP)).toBeGreaterThan(0);
  });
});
