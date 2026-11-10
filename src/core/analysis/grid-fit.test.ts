import { describe, expect, it } from 'vitest';
import { fitGrid } from './grid-fit';

const period = 60 / 128;
const grid = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => 0.3 + (from + i) * period);

describe('fitGrid', () => {
  it('finds the period from a guess half a percent off', () => {
    const fit = fitGrid(grid(0, 300), period * 1.005);
    expect(fit.period).toBeCloseTo(period, 6);
    expect(Math.abs(((fit.at - 0.3) / period) % 1)).toBeLessThan(1e-6);
  });

  it('keeps to the beat through a stretch tracked on the off-beats and a skipped beat', () => {
    const beats = [
      ...grid(0, 140),
      // Thirty beats tracked half a beat late, then one skipped.
      ...grid(140, 170).map((t) => t + period / 2),
      ...grid(171, 300),
    ];
    const fit = fitGrid(beats, period * 1.004);
    expect(fit.period).toBeCloseTo(period, 6);
    const k = Math.round((299 * period + 0.3 - fit.at) / fit.period);
    expect(Math.abs(fit.at + k * fit.period - (0.3 + 299 * period))).toBeLessThan(0.001);
  });
});
