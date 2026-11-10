import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BINDINGS } from '../../core';
import { chipBinding, controlsList, createPauseMenu, createResultsScreen } from './menus';

describe('controlsList', () => {
  it('lists the game’s actions in its order with their bindings, and the fixed pause', () => {
    const rows = [
      ...controlsList(DEFAULT_BINDINGS, ['overdrive', 'jump']).querySelectorAll(
        '.game-controls__row',
      ),
    ].map((r) => [r.querySelector('dt')!.textContent, r.querySelector('dd')!.textContent]);
    expect(rows).toEqual([
      ['Overdrive', 'E · L · Pad Y'],
      ['Jump', 'Space · W · ↑ · Pad A'],
      ['Pause', 'Esc · Pad Start'],
    ]);
  });

  it('puts an action’s first key on its chip, else its gamepad button', () => {
    expect(chipBinding(DEFAULT_BINDINGS, 'overdrive')).toBe('E');
    const padOnly = {
      ...DEFAULT_BINDINGS,
      overdrive: { keys: [null, null, null], mouse: [null, null], pad: [3, null] },
    };
    expect(chipBinding(padOnly, 'overdrive')).toBe('Pad Y');
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
      actions: ['jump', 'dash'] as const,
    };
    const menu = createPauseMenu(handlers);
    expect(menu.element.querySelector('.game-controls')!.textContent).toContain('Right click');
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
  it('shows the score, rank, two columns and the rank rules, with Retry and Back to menu', () => {
    const handlers = { onRetry: vi.fn(), onBack: vi.fn(), rankRules: 'S: no crashes' };
    const results = createResultsScreen('Midnight Drive', handlers);
    document.body.append(results.element);
    results.show({
      score: 12345,
      rank: 'B',
      columns: [
        [{ name: 'Perfect', value: '30', highlight: true }],
        [
          { name: 'Crashes', value: '2' },
          { name: 'Pickups', value: '—' },
        ],
      ],
    });
    expect(results.element.querySelector('.game-results__score')!.textContent).toBe('012 345');
    expect(results.element.querySelector('.game-results__rank')!.textContent).toBe('B');
    const cols = [...results.element.querySelectorAll('.game-results__col')].map((c) =>
      [...c.querySelectorAll('.game-results__row')].map((r) => r.textContent),
    );
    expect(cols).toEqual([['Perfect30'], ['Crashes2', 'Pickups—']]);
    expect(results.element.querySelector('.game-results__row--highlight')!.textContent).toBe(
      'Perfect30',
    );
    expect(results.element.querySelector('.game-results__ranks')!.textContent).toBe(
      'S: no crashes',
    );
    const [retry, back] = [...results.element.querySelectorAll('button')];
    retry!.click();
    back!.click();
    expect(handlers.onRetry).toHaveBeenCalledOnce();
    expect(handlers.onBack).toHaveBeenCalledOnce();
    results.destroy();
  });
});
