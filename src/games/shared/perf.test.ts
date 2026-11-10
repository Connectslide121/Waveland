import { describe, expect, it } from 'vitest';
import { FrameMonitor } from './perf';

/** Three quality levels, like the games have. */
const LEVELS = 3;

/** Feed `seconds` of frames `intervalMs` apart. */
function play(monitor: FrameMonitor, seconds: number, intervalMs: number, cpuMs = 3) {
  for (let t = 0; t < seconds * 1000; t += intervalMs) monitor.frame(intervalMs, cpuMs);
}

describe('FrameMonitor', () => {
  it('keeps the quality while frames stay within budget', () => {
    const lowered: number[] = [];
    const monitor = new FrameMonitor(LEVELS, (level) => lowered.push(level));
    play(monitor, 10, 1000 / 60);
    expect(monitor.level).toBe(0);
    expect(lowered).toEqual([]);
    expect(monitor.fps).toBeCloseTo(60, 0);
    expect(monitor.cpuMs).toBeCloseTo(3, 6);
  });

  it('steps down after a second over budget, then lets it settle before the next step', () => {
    const lowered: number[] = [];
    const monitor = new FrameMonitor(LEVELS, (level) => lowered.push(level));
    play(monitor, 1.05, 25);
    expect(lowered).toEqual([1]);
    // The next second is the settling one: no step, however slow.
    play(monitor, 1, 25);
    expect(lowered).toEqual([1]);
    play(monitor, 1, 25);
    expect(lowered).toEqual([1, 2]);
    // Never below the cheapest level.
    play(monitor, 5, 25);
    expect(monitor.level).toBe(LEVELS - 1);
    expect(lowered).toEqual([1, 2]);
  });

  it('shrugs off a few slow frames', () => {
    const monitor = new FrameMonitor(LEVELS);
    for (let i = 0; i < 600; i++) monitor.frame(i % 10 === 0 ? 40 : 1000 / 60, 3);
    expect(monitor.level).toBe(0);
  });

  it('takes a long gap for a pause, not a slow frame', () => {
    const monitor = new FrameMonitor(LEVELS);
    for (let i = 0; i < 20; i++) {
      monitor.frame(1000, 3);
      monitor.frame(1000 / 60, 3);
    }
    expect(monitor.level).toBe(0);
  });
});
