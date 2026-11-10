import { describe, expect, it, vi } from 'vitest';
import { createHud, createPauseMenu, createResultsScreen, formatAccuracy, formatScore } from './ui';

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

  it('lights the beat, counts the score and combo, and fills the progress', () => {
    hud.update({ time: 50, beatInBar: 2, score: 48210, combo: 9, multiplier: 2, countIn: null });
    const dots = [...hud.element.querySelectorAll('.pf-hud__beats i')];
    expect(dots.map((d) => d.classList.contains('on'))).toEqual([false, false, true, false]);
    expect(hud.element.querySelector('.pf-hud__score')!.textContent).toBe('048 210');
    expect(hud.element.querySelector('.pf-hud__combo')!.textContent).toBe('9 combo · ×2');
    expect(hud.element.querySelector<HTMLElement>('.pf-hud__fill')!.style.width).toBe('25%');
    expect(hud.element.querySelector('.pf-hud__count')!.classList.contains('on')).toBe(false);
  });

  it('shows the count-in', () => {
    hud.update({ time: -1, beatInBar: 0, score: 0, combo: 0, multiplier: 1, countIn: 3 });
    const count = hud.element.querySelector('.pf-hud__count')!;
    expect(count.textContent).toBe('3');
    expect(count.classList.contains('on')).toBe(true);
  });
});

describe('createPauseMenu', () => {
  it('resumes on Escape, restarts and quits from its buttons, and ignores the backdrop', () => {
    const handlers = { onResume: vi.fn(), onRestart: vi.fn(), onQuit: vi.fn() };
    const menu = createPauseMenu(handlers);
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
    expect(buttons.map((b) => b.textContent)).toEqual(['ResumeEsc', 'Restart', 'Quit']);
    buttons[1]!.click();
    buttons[2]!.click();
    expect(handlers.onRestart).toHaveBeenCalledOnce();
    expect(handlers.onQuit).toHaveBeenCalledOnce();
    menu.destroy();
  });
});

describe('createResultsScreen', () => {
  it('shows the score, accuracy, deaths and pickups, with Retry and Back to menu', () => {
    const handlers = { onRetry: vi.fn(), onBack: vi.fn() };
    const results = createResultsScreen('Midnight Drive', handlers);
    document.body.append(results.element);
    results.show({
      score: 12345,
      accuracy: 0.5,
      deaths: 3,
      pickups: 40,
      totalPickups: 52,
      bestCombo: 17,
    });
    expect(results.element.querySelector('.pf-results__score')!.textContent).toBe('012 345');
    const stats = [...results.element.querySelectorAll('.pf-results__stat')].map((s) => [
      s.querySelector('dt')!.textContent,
      s.querySelector('dd')!.textContent,
    ]);
    expect(stats).toEqual([
      ['Accuracy', '50%'],
      ['Deaths', '3'],
      ['Pickups', '40 / 52'],
      ['Best combo', '17'],
    ]);
    const [retry, back] = [...results.element.querySelectorAll('button')];
    retry!.click();
    back!.click();
    expect(handlers.onRetry).toHaveBeenCalledOnce();
    expect(handlers.onBack).toHaveBeenCalledOnce();
    results.destroy();
  });
});
