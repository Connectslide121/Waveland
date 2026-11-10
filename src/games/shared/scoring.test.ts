import { describe, expect, it } from 'vitest';
import { describeRanks, rankAgainst, timingOf, type RankRule } from './scoring';

const RULES: RankRule[] = [
  { rank: 'S', timing: 0.8, faults: 0, pickups: 0.9 },
  { rank: 'A', timing: 0.6, faults: 3, pickups: 0.7 },
  { rank: 'B', timing: 0.4, faults: Infinity },
  { rank: 'C', timing: 0, faults: Infinity },
];

describe('ranks', () => {
  it('ranks by timing, faults and, when a rule asks, pickups taken', () => {
    expect(rankAgainst(RULES, 0.9, 0, 0.95)).toBe('S');
    expect(rankAgainst(RULES, 0.9, 0, 0.8)).toBe('A');
    expect(rankAgainst(RULES, 0.9, 4, 1)).toBe('B');
    expect(rankAgainst(RULES, 0.5, 0, 0)).toBe('B');
    expect(rankAgainst(RULES, null, 0, 1)).toBe('C');
  });

  it('says the thresholds in words, each rank on one line', () => {
    const text = describeRanks(RULES, 'crashes').replaceAll(String.fromCharCode(160), ' ');
    expect(text).toBe(
      'S: timing 80%+, pickups 90%+, no crashes · A: timing 60%+, pickups 70%+, at most 3 crashes · ' +
        'B: timing 40%+ · C: finished. Timing counts a good as half a perfect.',
    );
  });

  it('counts a good as half a perfect', () => {
    expect(timingOf(1, 2, 1)).toBe(0.5);
    expect(timingOf(0, 0, 0)).toBeNull();
  });
});
