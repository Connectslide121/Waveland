import { describe, expect, it } from 'vitest';
import { ground, testLevel } from './test-level';
import { validateLevel } from './validate';

/** Ground with one pit, starting where the camera's player starts. */
const withPit = (from: number, width: number) => [ground(-40, from), ground(from + width, 4000)];

describe('validateLevel', () => {
  it('passes plain ground', () => {
    expect(validateLevel(testLevel([ground(-40, 4000)]).level).ok).toBe(true);
  });

  it('passes a gap a running jump clears, and fails one it does not', () => {
    expect(validateLevel(testLevel(withPit(700, 200)).level).ok).toBe(true);
    const check = validateLevel(testLevel(withPit(700, 360)).level);
    expect(check.ok).toBe(false);
    // It got as far as the gap, not further.
    expect(check.furthestX).toBeLessThan(1060);
    expect(check.furthestX).toBeGreaterThan(600);
  });

  it('fails a ledge too high to jump onto', () => {
    const wall = [ground(-40, 700), ground(700, 4000, 170)];
    expect(validateLevel(testLevel(wall).level).ok).toBe(false);
    const step = [ground(-40, 700), ground(700, 4000, 110)];
    expect(validateLevel(testLevel(step).level).ok).toBe(true);
  });

  it('crosses a bridge only while it is there', () => {
    // A pit too wide to jump, spanned by a bridge.
    const pit = (windows: [number, number][]) =>
      testLevel([
        ground(-40, 700),
        { kind: 'bridge', x0: 700, x1: 1100, top: 0, windows },
        ground(1100, 4000),
      ]).level;
    // The camera pushes the player onto it from about 1.5 s; out from 2 to 4 s is plenty.
    expect(validateLevel(pit([[2, 4]])).ok).toBe(true);
    // Too short to get across, even running.
    expect(validateLevel(pit([[2, 2.6]])).ok).toBe(false);
    // Out only before the player can be there.
    expect(validateLevel(pit([[0, 0.5]])).ok).toBe(false);
  });

  it('gets past spikes, while they are in or over them', () => {
    const strip = (x0: number, length: number) =>
      testLevel([ground(-40, 4000)], { spikes: [{ x0, x1: x0 + length, top: 0 }] }).level;
    expect(validateLevel(strip(700, 60)).ok).toBe(true);
    expect(validateLevel(strip(700, 200)).ok).toBe(true);
    // Under the player's feet at the start, coming out at the first off-beat.
    expect(validateLevel(strip(0, 4000)).ok).toBe(false);
  });
});
