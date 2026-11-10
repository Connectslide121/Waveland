import { describe, expect, it } from 'vitest';
import { recordingName, RunRecorder } from './recording';
import type { PlatformerRun } from './run';

const NONE = { jump: false, dash: false, slam: false, overdrive: false };

/** A run with nothing marked yet, for `update`. */
function quietRun(marks: Partial<Record<string, number>> = {}): PlatformerRun {
  return {
    jumpedAt: -Infinity,
    landedAt: -Infinity,
    dashedAt: -Infinity,
    slammedAt: -Infinity,
    slamLandedAt: -Infinity,
    diedAt: 0,
    ...marks,
  } as unknown as PlatformerRun;
}

function recorder() {
  const surface = document.createElement('div');
  const r = new RunRecorder(window, surface);
  r.begin(-2);
  return { r, surface };
}

/** The presses recorded so far. */
const presses = (r: RunRecorder) =>
  (r.toRecording({ title: 't', hash: 'h' }, {} as never, {} as never) as { presses: unknown[] })
    .presses;

describe('RunRecorder', () => {
  it('times a key press by its own event, not the frame that reads it', () => {
    const { r } = recorder();
    const key = new KeyboardEvent('keydown', { code: 'Space' });
    window.dispatchEvent(key);
    // Read 12 ms after the key went down, when 10 s of the song was heard.
    const now = key.timeStamp + 12;
    r.frame({ ...NONE, jump: true }, true, 10, 10.025, now, 0.025, 1 / 60);
    expect(presses(r)).toEqual([
      { action: 'jump', heard: expect.closeTo(9.988, 6), frame: 10, run: 10.025, attempt: 0 },
    ]);
    r.destroy();
  });

  it('records a gamepad press at the frame, and a release when the jump is let go', () => {
    const { r } = recorder();
    r.frame({ ...NONE, dash: true }, false, 5, 5.02, performance.now(), 0.02, 1 / 60);
    r.frame({ ...NONE, jump: true }, true, 5.1, 5.12, performance.now(), 0.02, 1 / 60);
    r.frame(NONE, false, 5.3, 5.32, performance.now(), 0.02, 1 / 60);
    expect(presses(r)).toMatchObject([
      { action: 'dash', heard: null, frame: 5 },
      { action: 'jump', heard: null, frame: 5.1 },
      { action: 'release', heard: null, frame: 5.3 },
    ]);
    r.destroy();
  });

  it('ignores key repeats and stops listening when destroyed', () => {
    const { r } = recorder();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', repeat: true }));
    r.frame({ ...NONE, jump: true }, true, 2, 2.02, performance.now(), 0.02, 1 / 60);
    r.destroy();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    r.frame({ ...NONE, jump: true }, true, 3, 3.02, performance.now(), 0.02, 1 / 60);
    expect(presses(r)).toMatchObject([
      { action: 'jump', heard: null },
      { action: 'jump', heard: null },
    ]);
  });

  it('turns the run’s marks and events into timed events, per attempt', () => {
    const { r } = recorder();
    r.update(quietRun({ jumpedAt: 3.5 }), [], 3.52);
    r.update(quietRun({ jumpedAt: 3.5 }), [], 3.54);
    r.update(
      quietRun({ jumpedAt: 3.5, diedAt: 4 }),
      [{ type: 'death', cause: 'pit', x: 0, y: 0 }],
      4.01,
    );
    r.begin(-2);
    r.update(quietRun({ jumpedAt: 1 }), [], 1.02);
    const { events, seeks } = r.toRecording({ title: 't', hash: 'h' }, {} as never, {} as never);
    expect(events).toEqual([
      { t: 3.5, attempt: 0, type: 'takeoff' },
      { t: 4, attempt: 0, type: 'death', cause: 'pit' },
      { t: 1, attempt: 1, type: 'takeoff' },
    ]);
    expect(seeks.map((s) => [s.why, s.attempt])).toEqual([
      ['begin', 0],
      ['begin', 1],
    ]);
    r.destroy();
  });
});

describe('recordingName', () => {
  it('names the file after the song and the time, safely', () => {
    expect(recordingName('Midnight: Drive (live)', new Date(2026, 10, 11, 9, 5))).toBe(
      'waveland-run-Midnight-Drive-live-20261111-0905.json',
    );
  });
});
