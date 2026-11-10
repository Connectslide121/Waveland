import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BINDINGS } from '../../core';
import {
  controlsList,
  createHud,
  createPauseMenu,
  createResultsScreen,
  formatAccuracy,
  formatScore,
} from './ui';

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
});

describe('createHud', () => {
  const hud = createHud({ title: 'Midnight Drive', tempo: 119.6, duration: 200, drops: [60, 140] });
  document.body.append(hud.element);

  it('shows the song and tempo, and marks the drops on the progress bar', () => {
    expect(hud.element.querySelector('.pf-hud__song')!.textContent).toBe(
      'Midnight Drive · 120 BPM',
    );
    const marks = [...hud.element.querySelectorAll<HTMLElement>('.pf-hud__drop')];
    expect(marks.map((m) => m.style.left)).toEqual(['30%', '70%']);
  });

  it('shows the tempo of the moment when the song changes tempo', () => {
    const song = () => hud.element.querySelector('.pf-hud__song')!.textContent;
    const state = { time: 10, beatInBar: 0, score: 0, combo: 0, multiplier: 1, countIn: null };
    hud.update({ ...state, perf: null, hint: null, tempo: 150.2 });
    expect(song()).toBe('Midnight Drive · 150 BPM');
    hud.update({ ...state, perf: null, hint: null });
    expect(song()).toBe('Midnight Drive · 120 BPM');
  });

  it('lights the beat, counts the score and combo, and fills the progress', () => {
    hud.update({
      time: 50,
      beatInBar: 2,
      score: 48210,
      combo: 9,
      multiplier: 2,
      countIn: null,
      perf: null,
      hint: null,
    });
    const dots = [...hud.element.querySelectorAll('.pf-hud__beats i')];
    expect(dots.map((d) => d.classList.contains('on'))).toEqual([false, false, true, false]);
    expect(hud.element.querySelector('.pf-hud__score')!.textContent).toBe('048 210');
    // ×2, one of eight steps to ×3, and the count.
    expect(hud.element.querySelector('.pf-hud__mult')!.textContent).toBe('×2');
    expect(hud.element.querySelectorAll('.pf-hud__steps i.on')).toHaveLength(1);
    expect(hud.element.querySelector('.pf-hud__combo-count')!.textContent).toBe('9');
    expect(hud.element.querySelector<HTMLElement>('.pf-hud__fill')!.style.width).toBe('25%');
    expect(hud.element.querySelector('.pf-hud__count')!.classList.contains('on')).toBe(false);
  });

  it('shows the overdrive meter with its key, and the boosters in fixed slots', () => {
    const base = {
      time: 50,
      beatInBar: 0,
      score: 0,
      combo: 0,
      multiplier: 1,
      countIn: null,
      perf: null,
      hint: null,
      overdriveKey: 'E',
    };
    const od = hud.element.querySelector('.pf-od')!;
    const fill = hud.element.querySelector<HTMLElement>('.pf-od__fill')!;
    const state = () => hud.element.querySelector('.pf-od__state')!.textContent;
    hud.update({ ...base, meter: 0.5, overdrive: null });
    expect(fill.style.width).toBe('50%');
    expect(state()).toBe('Perfects and gems fill it');
    expect(hud.element.querySelector('.pf-od__key')!.textContent).toBe('E');
    hud.update({ ...base, meter: 1, overdrive: null });
    expect(state()).toBe('Ready · press E');
    expect(od.classList.contains('ready')).toBe(true);
    hud.update({ ...base, meter: 0, overdrive: 0.25 });
    expect(state()).toBe('Score ×2');
    expect(fill.style.width).toBe('25%');
    expect(od.classList.contains('on')).toBe(true);

    const slots = [...hud.element.querySelectorAll('.pf-boost')];
    expect(slots).toHaveLength(3);
    hud.update({ ...base, boosters: { shield: 1, magnet: 0.4, dash: null } });
    expect(slots.map((s) => s.classList.contains('on'))).toEqual([true, true, false]);
    expect(slots.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Shield: ready',
      'Magnet: on, 40% left',
      'Extra dash: off',
    ]);
    expect(slots[1]!.querySelector<HTMLElement>('.pf-boost__bar')!.style.width).toBe('40%');
  });

  it('shows the count-in', () => {
    hud.update({
      time: -1,
      beatInBar: 0,
      score: 0,
      combo: 0,
      multiplier: 1,
      countIn: 3,
      perf: null,
      hint: null,
    });
    const count = hud.element.querySelector('.pf-hud__count')!;
    expect(count.textContent).toBe('3');
    expect(count.classList.contains('on')).toBe(true);
  });

  it('shows the frame rate only when asked', () => {
    const perf = hud.element.querySelector<HTMLElement>('.pf-hud__perf')!;
    expect(perf.hidden).toBe(true);
    const state = {
      time: 1,
      beatInBar: 0,
      score: 0,
      combo: 0,
      multiplier: 1,
      countIn: null,
      hint: null,
    };
    hud.update({ ...state, perf: { fps: 59.6, cpuMs: 4.24 } });
    expect(perf.hidden).toBe(false);
    expect(perf.textContent).toBe('60 FPS · 4.2 MS');
    hud.update({ ...state, perf: null });
    expect(perf.hidden).toBe(true);
  });

  it('shows a first-time hint, keeping its text while it fades', () => {
    const hint = hud.element.querySelector<HTMLElement>('.pf-hud__hint')!;
    const state = { time: 1, beatInBar: 0, score: 0, combo: 0, multiplier: 1, countIn: null };
    hud.update({ ...state, perf: null, hint: 'Right click / Shift: dash' });
    expect(hint.textContent).toBe('Right click / Shift: dash');
    expect(hint.classList.contains('on')).toBe(true);
    hud.update({ ...state, perf: null, hint: null });
    expect(hint.classList.contains('on')).toBe(false);
    expect(hint.textContent).toBe('Right click / Shift: dash');
  });
});

describe('controlsList', () => {
  it('lists every action with its bindings, and the fixed pause', () => {
    const rows = [...controlsList(DEFAULT_BINDINGS).querySelectorAll('.pf-controls__row')].map(
      (r) => [r.querySelector('dt')!.textContent, r.querySelector('dd')!.textContent],
    );
    expect(rows).toEqual([
      ['Jump', 'Space · W · ↑ · Pad A'],
      ['Dash', 'Shift · J · X · Right click · Pad X · Pad RB'],
      ['Slam', 'S · ↓ · Left click · Pad B · D-pad ↓'],
      ['Overdrive', 'E · L · Pad Y'],
      ['Pause', 'Esc · Pad Start'],
    ]);
  });
});

describe('createPauseMenu', () => {
  it('resumes on Escape, restarts and quits from its buttons, and ignores the backdrop', () => {
    const handlers = {
      onResume: vi.fn(),
      onRestart: vi.fn(),
      onSettings: vi.fn(),
      onQuit: vi.fn(),
      bindings: () => DEFAULT_BINDINGS,
    };
    const menu = createPauseMenu(handlers);
    expect(menu.element.querySelector('.pf-controls')!.textContent).toContain('Right click');
    document.body.append(menu.element);
    expect(menu.open).toBe(false);
    menu.show();
    expect(menu.open).toBe(true);
    expect(document.activeElement!.textContent).toContain('Resume');

    menu.element.click();
    expect(menu.open).toBe(true);
    expect(handlers.onResume).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(handlers.onResume).toHaveBeenCalledOnce();

    const buttons = [...menu.element.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['ResumeEsc', 'Restart', 'Settings', 'Quit']);
    buttons[1]!.click();
    buttons[2]!.click();
    buttons[3]!.click();
    expect(handlers.onRestart).toHaveBeenCalledOnce();
    expect(handlers.onSettings).toHaveBeenCalledOnce();
    expect(handlers.onQuit).toHaveBeenCalledOnce();
    menu.destroy();
  });
});

describe('createResultsScreen', () => {
  it('shows the score, rank and breakdown, with Retry and Back to menu', () => {
    const handlers = { onRetry: vi.fn(), onBack: vi.fn() };
    const results = createResultsScreen('Midnight Drive', handlers);
    document.body.append(results.element);
    results.show({
      score: 12345,
      rank: 'B',
      timing: 0.55,
      accuracy: 0.5,
      perfect: 30,
      good: 20,
      miss: 50,
      deaths: 3,
      saves: 1,
      pickups: 40,
      totalPickups: 52,
      bestCombo: 17,
      overdrives: 2,
      clean: 4,
      sections: 9,
    });
    expect(results.element.querySelector('.pf-results__score')!.textContent).toBe('012 345');
    expect(results.element.querySelector('.pf-results__rank')!.textContent).toBe('B');
    const stats = [...results.element.querySelectorAll('.pf-results__row')].map((s) => [
      s.querySelector('dt')!.textContent,
      s.querySelector('dd')!.textContent,
    ]);
    expect(stats).toEqual([
      ['Perfect', '30'],
      ['Good', '20'],
      ['Miss', '50'],
      ['Timing', '55%'],
      ['Deaths', '3'],
      ['Best combo', '17'],
      ['Overdrives', '2'],
      ['Clean sections', '4 / 9'],
      ['Pickups', '40 / 52'],
      ['Shield saves', '1'],
    ]);
    expect(
      results.element
        .querySelector('.pf-results__ranks')!
        .textContent!.replaceAll(String.fromCharCode(160), ' '),
    ).toBe(
      'S: timing 85%+, no deaths · A: timing 70%+, at most 2 deaths · B: timing 50%+ · C: finished. Timing counts a good as half a perfect.',
    );
    const [retry, back] = [...results.element.querySelectorAll('button')];
    retry!.click();
    back!.click();
    expect(handlers.onRetry).toHaveBeenCalledOnce();
    expect(handlers.onBack).toHaveBeenCalledOnce();
    results.destroy();
  });
});
