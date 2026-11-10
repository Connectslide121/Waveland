import { describe, expect, it } from 'vitest';
import { createHud, createResultsScreen, JUDGEMENT_TIME, type TunnelHudState } from './ui';

const STATE: TunnelHudState = {
  time: 1,
  beatInBar: 0,
  score: 0,
  combo: 0,
  multiplier: 1,
  countIn: null,
  perf: null,
  shield: false,
  judgement: null,
};

describe('tunnel HUD', () => {
  it('shows the shield once earned, saying what it does', () => {
    const hud = createHud({ title: 'Song', tempo: 120, duration: 60, drops: [] });
    const shield = hud.element.querySelector<HTMLElement>('.tn-shield')!;
    hud.update(STATE);
    expect(shield.classList.contains('on')).toBe(false);
    expect(shield.getAttribute('aria-label')).toMatch(/clean section earns/);
    hud.update({ ...STATE, shield: true });
    expect(shield.classList.contains('on')).toBe(true);
    expect(shield.getAttribute('aria-label')).toMatch(/next crash/);
  });

  it('shows the last judgement in its own place and fades it out', () => {
    const hud = createHud({ title: 'Song', tempo: 120, duration: 60, drops: [] });
    const word = hud.element.querySelector<HTMLElement>('.tn-judge')!;
    hud.update({ ...STATE, judgement: { word: 'perfect', age: 0 } });
    expect(word.textContent).toBe('Perfect');
    expect(word.style.opacity).toBe('1');
    hud.update({ ...STATE, judgement: { word: 'perfect', age: JUDGEMENT_TIME / 2 } });
    expect(Number(word.style.opacity)).toBeCloseTo(0.5, 1);
    hud.update({ ...STATE, judgement: { word: 'crash', age: 0 } });
    expect(word.dataset.word).toBe('crash');
    hud.update(STATE);
    expect(word.style.opacity).toBe('0');
  });
});

describe('tunnel results', () => {
  it('lists crashes, pickups and shield saves', () => {
    const screen = createResultsScreen('Song · Normal', { onRetry() {}, onBack() {} });
    screen.show({
      score: 12000,
      rank: 'A',
      timing: 0.7,
      perfect: 10,
      good: 4,
      miss: 2,
      crashes: 1,
      saves: 1,
      pickups: 30,
      totalPickups: 40,
      bestCombo: 22,
      overdrives: 1,
      clean: 3,
      sections: 5,
    });
    const text = screen.element.textContent!;
    expect(text).toContain('Crashes');
    expect(text).toContain('30 / 40');
    expect(text).toContain('Shield saves');
    expect(text).toMatch(/crashes/);
    screen.destroy();
  });
});
