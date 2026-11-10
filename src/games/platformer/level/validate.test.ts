import { describe, expect, it } from 'vitest';
import { ANCHOR_X, PLAYER_HEIGHT, PLAYER_WIDTH } from '../physics';
import { dashPitAir, DASH_REACH, JUMP_REACH, pitAt } from './generate';
import { xAtTime } from './level';
import { ground, overhang, testLevel } from './test-level';
import { validateLevel } from './validate';

const SPEED = 200;
const x = (t: number) => xAtTime({ speed: SPEED }, t);

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
    const check = validateLevel(withPit(DASH_REACH + 0.15).level);
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
    const gates = [1, 1.5, 2.5].map((t) => ({ x: x(t) + PLAYER_WIDTH, time: t, top: 0 }));
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
