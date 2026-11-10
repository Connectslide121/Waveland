import { describe, expect, it } from 'vitest';
import { formatAccuracy, formatPerf, formatScore } from './format';
import { createHud } from './hud';

describe('formatting', () => {
  it('shows the score as six digits in two groups, and grows past them', () => {
    expect(formatScore(48210)).toBe('048 210');
    expect(formatScore(0)).toBe('000 000');
    expect(formatScore(1234567)).toBe('1 234 567');
  });

  it('shows a dash for accuracy when nothing was judged', () => {
    expect(formatAccuracy(null)).toBe('—');
    expect(formatAccuracy(0.876)).toBe('88%');
  });

  it('shows dashes for the frame rate before it is measured', () => {
    expect(formatPerf(0, 0)).toBe('— FPS · — MS');
    expect(formatPerf(59.6, 4.24)).toBe('60 FPS · 4.2 MS');
  });
});

describe('createHud', () => {
  const hud = createHud({
    title: 'Midnight Drive',
    tempo: 119.6,
    duration: 200,
    drops: [60, 140],
    comboStep: 8,
    maxMultiplier: 4,
    overdriveFills: 'Pickups fill it',
  });
  document.body.append(hud.element);
  const base = { time: 50, beatInBar: 0, score: 0, combo: 0, multiplier: 1, countIn: null };

  it('shows the song and tempo, and marks the drops on the progress bar', () => {
    expect(hud.element.querySelector('.game-hud__song')!.textContent).toBe(
      'Midnight Drive · 120 BPM',
    );
    const marks = [...hud.element.querySelectorAll<HTMLElement>('.game-hud__drop')];
    expect(marks.map((m) => m.style.left)).toEqual(['30%', '70%']);
  });

  it('shows the tempo of the moment when the song changes tempo', () => {
    const song = () => hud.element.querySelector('.game-hud__song')!.textContent;
    hud.update({ ...base, time: 10, perf: null, tempo: 150.2 });
    expect(song()).toBe('Midnight Drive · 150 BPM');
    hud.update({ ...base, time: 10, perf: null });
    expect(song()).toBe('Midnight Drive · 120 BPM');
  });

  it('lights the beat, counts the score and combo, and fills the progress', () => {
    hud.update({ ...base, beatInBar: 2, score: 48210, combo: 9, multiplier: 2, perf: null });
    const dots = [...hud.element.querySelectorAll('.game-hud__beats i')];
    expect(dots.map((d) => d.classList.contains('on'))).toEqual([false, false, true, false]);
    expect(hud.element.querySelector('.game-hud__score')!.textContent).toBe('048 210');
    // ×2, one of eight steps to ×3, and the count.
    expect(hud.element.querySelector('.game-hud__mult')!.textContent).toBe('×2');
    expect(hud.element.querySelectorAll('.game-hud__steps i')).toHaveLength(8);
    expect(hud.element.querySelectorAll('.game-hud__steps i.on')).toHaveLength(1);
    expect(hud.element.querySelector('.game-hud__combo-count')!.textContent).toBe('9');
    expect(hud.element.querySelector<HTMLElement>('.game-hud__fill')!.style.width).toBe('25%');
    expect(hud.element.querySelector('.game-hud__count')!.classList.contains('on')).toBe(false);
  });

  it('shows the overdrive meter with its key and what fills it', () => {
    const state = { ...base, perf: null, overdriveKey: 'E' };
    const od = hud.element.querySelector('.game-od')!;
    const fill = hud.element.querySelector<HTMLElement>('.game-od__fill')!;
    const text = () => hud.element.querySelector('.game-od__state')!.textContent;
    hud.update({ ...state, meter: 0.5, overdrive: null });
    expect(fill.style.width).toBe('50%');
    expect(text()).toBe('Pickups fill it');
    expect(hud.element.querySelector('.game-od__key')!.textContent).toBe('E');
    hud.update({ ...state, meter: 1, overdrive: null });
    expect(text()).toBe('Ready · press E');
    expect(od.classList.contains('ready')).toBe(true);
    hud.update({ ...state, meter: 0, overdrive: 0.25 });
    expect(text()).toBe('Score ×2');
    expect(fill.style.width).toBe('25%');
    expect(od.classList.contains('on')).toBe(true);
    // A game's own slots go after it.
    expect(hud.status.firstElementChild).toBe(od);
  });

  it('shows the count-in', () => {
    hud.update({ ...base, time: -1, countIn: 3, perf: null });
    const count = hud.element.querySelector('.game-hud__count')!;
    expect(count.textContent).toBe('3');
    expect(count.classList.contains('on')).toBe(true);
  });

  it('shows the frame rate only when asked', () => {
    const perf = hud.element.querySelector<HTMLElement>('.game-hud__perf')!;
    hud.update({ ...base, time: 1, perf: null });
    expect(perf.hidden).toBe(true);
    hud.update({ ...base, time: 1, perf: { fps: 59.6, cpuMs: 4.24 } });
    expect(perf.hidden).toBe(false);
    expect(perf.textContent).toBe('60 FPS · 4.2 MS');
    hud.update({ ...base, time: 1, perf: null });
    expect(perf.hidden).toBe(true);
  });
});
