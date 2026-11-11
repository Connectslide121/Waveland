import type { Bindings } from '../../core';
import {
  createHud as createSharedHud,
  createPauseMenu as createSharedPauseMenu,
  createResultsScreen as createSharedResultsScreen,
  type Hud,
  type HudState,
  type PauseMenu,
  type ResultsScreen,
} from '../shared';
import { el } from '../shared/dom';
import { COMBO_STEP, MAX_MULTIPLIER } from '../shared/scoring';
import { TUNNEL_ACTIONS } from './actions';
import { rankRules, summaryOf, type RunResults } from './run';

export { TUNNEL_ACTIONS };
import './ui.css';

/**
 * The tunnel's HTML over the canvas: the shared HUD, pause menu and results screen
 * (`src/games/shared/`), with what only the tunnel has: the booster slots (shield,
 * magnet, surge) after the overdrive meter and the word a hop or jump was judged, in a
 * place of its own.
 */

export interface HudOptions {
  title: string;
  tempo: number;
  duration: number;
  drops: number[];
  difficulty?: string;
}

/** What a hop or jump was judged, as the HUD shows it. */
export type Judgement =
  | 'perfect'
  | 'good'
  | 'miss'
  | 'crash'
  | 'saved'
  | 'hoop'
  | 'streak'
  | 'magnet'
  | 'surge'
  | 'shield';

export interface TunnelHudState extends HudState {
  /** The racer has a shield: the next crash costs it instead of points. */
  shield: boolean;
  /** The last judgement and how long ago it was, in seconds; null for none showing. */
  judgement: { word: Judgement; age: number } | null;
  /** Each timed booster's share of its time left, 0 to 1, or null when off. */
  boosters?: Record<TimedBooster, number | null>;
}

/** The boosters that run for a while (the shield is held until a crash). */
export type TimedBooster = 'magnet' | 'surge';

const TIMED_NAMES: Record<TimedBooster, string> = { magnet: 'Magnet', surge: 'Surge' };

const TIMED_ICONS: Record<TimedBooster, string> = {
  magnet:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5v8.5a6 6 0 0 0 12 0V3.5" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M4.4 3.5h3.2M16.4 3.5h3.2M4.4 7.6h3.2M16.4 7.6h3.2" stroke="currentColor" stroke-width="2"/></svg>',
  surge:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.2 2.5 5.5 13.4h5.3L9.8 21.5l8.7-11.6h-5.4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>',
};

const WORDS: Record<Judgement, string> = {
  perfect: 'Perfect',
  good: 'Good',
  miss: 'Miss',
  crash: 'Crash',
  saved: 'Shield saved',
  hoop: 'Hoop',
  streak: 'Hoop streak',
  magnet: 'Magnet',
  surge: 'Surge',
  shield: 'Shield up',
};

/** How long a judgement word shows, seconds. */
export const JUDGEMENT_TIME = 0.6;

const SHIELD_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 19.5 5.6v5.6c0 4.6-3.1 8.2-7.5 10-4.4-1.8-7.5-5.4-7.5-10V5.6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="11.4" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

export function createHud(options: HudOptions): Hud<TunnelHudState> {
  const hud = createSharedHud({
    ...options,
    comboStep: COMBO_STEP,
    maxMultiplier: MAX_MULTIPLIER,
    overdriveFills: 'Perfects and gems fill it',
  });

  // The shield: always there, dim until a clean section earns it.
  const shield = el('div', 'tn-shield');
  shield.setAttribute('role', 'img');
  shield.setAttribute('aria-label', 'Shield: none, a clean section earns one');
  const icon = el('span', 'tn-shield__icon');
  icon.innerHTML = SHIELD_ICON;
  shield.append(icon, el('span', 'tn-shield__name', 'Shield'));
  hud.status.append(shield);

  // The timed boosters: a slot each, dim when off, with the time left as a bar.
  const timed = {} as Record<TimedBooster, { box: HTMLElement; bar: HTMLElement }>;
  for (const kind of Object.keys(TIMED_NAMES) as TimedBooster[]) {
    const box = el('div', `tn-boost tn-boost--${kind}`);
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', `${TIMED_NAMES[kind]}: off`);
    const boxIcon = el('span', 'tn-boost__icon');
    boxIcon.innerHTML = TIMED_ICONS[kind];
    const track = el('span', 'tn-boost__track');
    const bar = track.appendChild(el('i', 'tn-boost__bar'));
    box.append(boxIcon, track, el('span', 'tn-boost__name', TIMED_NAMES[kind]));
    hud.status.append(box);
    timed[kind] = { box, bar };
  }

  // The judgement word, in a place of its own under the count-in: it fades, nothing moves.
  const word = el('div', 'tn-judge');
  word.setAttribute('aria-hidden', 'true');
  hud.element.append(word);

  const shown = {
    shield: false,
    word: '',
    opacity: -1,
    boosters: { magnet: -2, surge: -2 } as Record<TimedBooster, number>,
  };
  return {
    element: hud.element,
    status: hud.status,
    update(state) {
      hud.update(state);
      if (state.shield !== shown.shield) {
        shield.classList.toggle('on', state.shield);
        shield.setAttribute(
          'aria-label',
          state.shield
            ? 'Shield: ready, takes the next crash'
            : 'Shield: none, a clean section earns one',
        );
        shown.shield = state.shield;
      }
      if (state.boosters)
        for (const kind of Object.keys(timed) as TimedBooster[]) {
          const left = state.boosters[kind];
          const percent = left === null ? -1 : Math.round(100 * left);
          if (percent === shown.boosters[kind]) continue;
          const { box, bar } = timed[kind];
          box.classList.toggle('on', left !== null);
          bar.style.width = `${Math.max(0, percent)}%`;
          box.setAttribute(
            'aria-label',
            `${TIMED_NAMES[kind]}: ${left === null ? 'off' : `on, ${percent}% left`}`,
          );
          shown.boosters[kind] = percent;
        }
      const j = state.judgement;
      const text = j ? WORDS[j.word] : '';
      if (text && text !== shown.word) {
        word.textContent = text;
        word.dataset.word = j!.word;
        shown.word = text;
      }
      const opacity = j ? Math.round(20 * Math.max(0, 1 - j.age / JUDGEMENT_TIME)) / 20 : 0;
      if (opacity !== shown.opacity) {
        word.style.opacity = String(opacity);
        shown.opacity = opacity;
      }
      if (!j) shown.word = '';
    },
  };
}

/** The shared pause menu, listing the tunnel's controls. */
export function createPauseMenu(handlers: {
  onResume: () => void;
  onRestart: () => void;
  onSettings: () => void;
  onQuit: () => void;
  bindings: () => Bindings;
}): PauseMenu {
  return createSharedPauseMenu({ ...handlers, actions: TUNNEL_ACTIONS });
}

/** The shared results screen with the tunnel's breakdown and rank rules. */
export function createResultsScreen(
  title: string,
  handlers: { onRetry: () => void; onBack: () => void },
): ResultsScreen<RunResults> {
  const screen = createSharedResultsScreen(title, { ...handlers, rankRules: rankRules() });
  return {
    element: screen.element,
    get open() {
      return screen.open;
    },
    close: () => screen.close(),
    destroy: () => screen.destroy(),
    show: (r) => screen.show(summaryOf(r)),
  };
}
