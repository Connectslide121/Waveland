import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BINDINGS } from '../../core';
import { createHud, createPauseMenu, createResultsScreen } from './ui';

describe('createHud', () => {
  const hud = createHud({ title: 'Midnight Drive', tempo: 119.6, duration: 200, drops: [60, 140] });
  document.body.append(hud.element);
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

  it('shows the shared HUD with the platformer’s combo steps and overdrive line', () => {
    hud.update({ ...base, combo: 9, multiplier: 2, meter: 0.5, overdrive: null });
    expect(hud.element.querySelector('.game-hud__song')!.textContent).toBe(
      'Midnight Drive · 120 BPM',
    );
    expect(hud.element.querySelectorAll('.game-hud__steps i')).toHaveLength(8);
    expect(hud.element.querySelectorAll('.game-hud__steps i.on')).toHaveLength(1);
    expect(hud.element.querySelector('.game-od__state')!.textContent).toBe(
      'Perfects and gems fill it',
    );
  });

  it('shows the boosters in fixed slots after overdrive', () => {
    const slots = [...hud.element.querySelectorAll('.pf-boost')];
    expect(slots).toHaveLength(4);
    expect(hud.element.querySelector('.game-hud__status .game-od + .pf-boosts')).not.toBeNull();
    hud.update({ ...base, boosters: { shield: 1, magnet: 0.4, dash: null, rush: 0.5 } });
    expect(slots.map((s) => s.classList.contains('on'))).toEqual([true, true, false, true]);
    expect(slots.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Shield: ready',
      'Magnet: on, 40% left',
      'Extra dash: off',
      'Coin rush: on, 50% left',
    ]);
    expect(slots[1]!.querySelector<HTMLElement>('.pf-boost__bar')!.style.width).toBe('40%');
  });

  it('shows a first-time hint, keeping its text while it fades', () => {
    const hint = hud.element.querySelector<HTMLElement>('.pf-hint')!;
    hud.update({ ...base, hint: 'Right click / Shift: dash' });
    expect(hint.textContent).toBe('Right click / Shift: dash');
    expect(hint.classList.contains('on')).toBe(true);
    hud.update({ ...base, hint: null });
    expect(hint.classList.contains('on')).toBe(false);
    expect(hint.textContent).toBe('Right click / Shift: dash');
  });
});

describe('createPauseMenu', () => {
  it('lists the platformer’s controls and pause', () => {
    const menu = createPauseMenu({
      onResume: vi.fn(),
      onRestart: vi.fn(),
      onSettings: vi.fn(),
      onQuit: vi.fn(),
      bindings: () => DEFAULT_BINDINGS,
    });
    const rows = [...menu.element.querySelectorAll('.game-controls__row')].map((r) => [
      r.querySelector('dt')!.textContent,
      r.querySelector('dd')!.textContent,
    ]);
    expect(rows).toEqual([
      ['Jump', 'Space · W · ↑ · Pad A'],
      ['Dash', 'Shift · J · X · Right click · Pad X · Pad RB'],
      ['Slam', 'S · ↓ · Left click · Pad B · D-pad ↓'],
      ['Overdrive', 'E · L · Pad Y'],
      ['Pause', 'Esc · Pad Start'],
    ]);
    menu.destroy();
  });
});

describe('createResultsScreen', () => {
  it('shows the score, rank and the platformer’s breakdown, with Retry and Back to menu', () => {
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
    expect(results.element.querySelector('.game-results__score')!.textContent).toBe('012 345');
    expect(results.element.querySelector('.game-results__rank')!.textContent).toBe('B');
    const stats = [...results.element.querySelectorAll('.game-results__row')].map((s) => [
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
        .querySelector('.game-results__ranks')!
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
