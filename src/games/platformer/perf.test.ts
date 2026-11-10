import { describe, expect, it } from 'vitest';
import { QUALITY } from './perf';

describe('QUALITY', () => {
  it('cheapens every effect from one level to the next', () => {
    for (let i = 1; i < QUALITY.length; i++) {
      const [a, b] = [QUALITY[i - 1]!, QUALITY[i]!];
      expect(b.bloomScale * b.bloomScale * b.blurSteps).toBeLessThan(
        a.bloomScale * a.bloomScale * a.blurSteps,
      );
      expect(b.particles).toBeLessThan(a.particles);
      expect(b.wavePoints).toBeLessThan(a.wavePoints);
      expect(b.dropWavePoints).toBeLessThan(a.dropWavePoints);
    }
  });
});
