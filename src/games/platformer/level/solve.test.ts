import { describe, expect, it } from 'vitest';
import { buildLevelMap } from '../../../core';
import { randomAnalysis } from '../../../core/test-analysis';
import { musicOf, PlatformerRun } from '../run';
import { generateLevel } from './generate';
import { solveLevel } from './validate';

describe('solveLevel', () => {
  it('finds presses the game plays through to the end without a death', () => {
    const map = buildLevelMap(randomAnalysis(3, { duration: 60, tempo: 128 }));
    const level = generateLevel(map, 'hard');
    const presses = solveLevel(level)!;
    expect(presses.size).toBeGreaterThan(10);
    const run = new PlatformerRun(level, map.sections, musicOf(map.events));
    run.autoplay = presses;
    const idle = {
      jumpPressed: false,
      jumpHeld: false,
      dashPressed: false,
      slamPressed: false,
      overdrivePressed: false,
    };
    for (
      let t = run.countInFrom;
      run.phase !== 'finished' && t <= level.duration + 0.1;
      t += 1 / 60
    )
      run.update(t, idle);
    expect(run.deaths).toBe(0);
    expect(run.phase).toBe('finished');
  }, 30_000);
});
