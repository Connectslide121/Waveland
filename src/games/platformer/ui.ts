import type { Bindings } from '../../core';
import {
  createHud as createSharedHud,
  createPauseMenu as createSharedPauseMenu,
  createResultsScreen as createSharedResultsScreen,
  describeRanks,
  formatAccuracy,
  type Hud,
  type HudState,
  type PauseMenu,
  type ResultsScreen,
} from '../shared';
import { el } from '../shared/dom';
import { PLATFORMER_ACTIONS } from './controls';
import type { BoosterKind } from './level';
import { COMBO_STEP, MAX_MULTIPLIER, RANKS, type RunResults } from './run';
import './ui.css';

/**
 * The platformer's HTML over the canvas: the shared HUD, pause menu and results screen
 * (`src/games/shared/`), with what only the platformer has: the booster slots, the
 * first-time hints, its controls and its results breakdown.
 */

export interface HudOptions {
  title: string;
  tempo: number;
  duration: number;
  /** Song times of the drops, marked on the progress bar. */
  drops: number[];
  /** The difficulty's name, after the tempo. */
  difficulty?: string;
}

export interface PlatformerHudState extends HudState {
  /** A one-line hint for an ability met for the first time ("Right click / Shift: dash"), or null. */
  hint: string | null;
  /** Each booster's share of its time left, 0 to 1 (1 until used), or null when off. */
  boosters?: Record<BoosterKind, number | null>;
}

/** The boosters' HUD slots, in order, with their names. */
export const BOOSTER_NAMES: Record<BoosterKind, string> = {
  shield: 'Shield',
  magnet: 'Magnet',
  dash: 'Extra dash',
};
const BOOSTER_SHORT: Record<BoosterKind, string> = {
  shield: 'Shield',
  magnet: 'Magnet',
  dash: 'Dash +1',
};

/** Each booster's icon: a shield with a core, a horseshoe magnet, a double chevron. */
export const BOOSTER_ICONS: Record<BoosterKind, string> = {
  shield:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 19.5 5.6v5.6c0 4.6-3.1 8.2-7.5 10-4.4-1.8-7.5-5.4-7.5-10V5.6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="11.4" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  magnet:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5v8.5a6 6 0 0 0 12 0V3.5" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M4.4 3.5h3.2M16.4 3.5h3.2M4.4 7.6h3.2M16.4 7.6h3.2" stroke="currentColor" stroke-width="2"/></svg>',
  dash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 6 6 6-6 6M12.5 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** The shared HUD with the booster slots after overdrive and the first-time hint. */
export function createHud(options: HudOptions): Hud<PlatformerHudState> {
  const hud = createSharedHud({
    ...options,
    comboStep: COMBO_STEP,
    maxMultiplier: MAX_MULTIPLIER,
    overdriveFills: 'Perfects and gems fill it',
  });

  const boosts = el('div', 'pf-boosts');
  const slotOf = {} as Record<BoosterKind, { box: HTMLElement; bar: HTMLElement }>;
  for (const kind of Object.keys(BOOSTER_NAMES) as BoosterKind[]) {
    const box = el('div', `pf-boost pf-boost--${kind}`);
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', `${BOOSTER_NAMES[kind]}: off`);
    const icon = el('span', 'pf-boost__icon');
    icon.innerHTML = BOOSTER_ICONS[kind];
    const track = el('span', 'pf-boost__track');
    const bar = track.appendChild(el('i', 'pf-boost__bar'));
    box.append(icon, track, el('span', 'pf-boost__name', BOOSTER_SHORT[kind]));
    boosts.append(box);
    slotOf[kind] = { box, bar };
  }
  hud.status.append(boosts);

  // The first-time hint: placed on its own, so it never moves anything when it shows.
  const hint = el('div', 'pf-hint');
  hint.setAttribute('aria-live', 'polite');
  hud.element.append(hint);

  const shown = {
    hint: null as string | null,
    boosts: { shield: -2, magnet: -2, dash: -2 } as Record<BoosterKind, number>,
  };
  return {
    element: hud.element,
    status: hud.status,
    update(state) {
      hud.update(state);
      if (state.boosters)
        for (const kind of Object.keys(slotOf) as BoosterKind[]) {
          const left = state.boosters[kind];
          const percent = left === null ? -1 : Math.round(100 * left);
          if (percent === shown.boosts[kind]) continue;
          const { box, bar } = slotOf[kind];
          box.classList.toggle('on', left !== null);
          bar.style.width = `${Math.max(0, percent)}%`;
          const what = left === null ? 'off' : kind === 'magnet' ? `on, ${percent}% left` : 'ready';
          box.setAttribute('aria-label', `${BOOSTER_NAMES[kind]}: ${what}`);
          shown.boosts[kind] = percent;
        }
      if (state.hint !== shown.hint) {
        // The last text stays while it fades out.
        if (state.hint !== null) hint.textContent = state.hint;
        hint.classList.toggle('on', state.hint !== null);
      }
      shown.hint = state.hint;
    },
  };
}

/** The shared pause menu, listing the platformer's controls. */
export function createPauseMenu(handlers: {
  onResume: () => void;
  onRestart: () => void;
  onSettings: () => void;
  onQuit: () => void;
  /** The controls as bound now, shown on the menu. */
  bindings: () => Bindings;
}): PauseMenu {
  return createSharedPauseMenu({ ...handlers, actions: PLATFORMER_ACTIONS });
}

/**
 * The ranks' thresholds in words, from `RANKS`: "S: timing 85%+, no deaths · A: timing
 * 70%+, at most 2 deaths · B: timing 50%+ · C: finished". Timing counts a good as half a perfect.
 */
export function rankRules(): string {
  return describeRanks(RANKS, 'deaths');
}

/** The shared results screen with the platformer's breakdown and rank rules. */
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
    show(r) {
      screen.show({
        score: r.score,
        rank: r.rank,
        columns: [
          [
            { name: 'Perfect', value: String(r.perfect), highlight: true },
            { name: 'Good', value: String(r.good) },
            { name: 'Miss', value: String(r.miss) },
            { name: 'Timing', value: formatAccuracy(r.timing) },
            { name: 'Deaths', value: String(r.deaths) },
          ],
          [
            { name: 'Best combo', value: String(r.bestCombo) },
            { name: 'Overdrives', value: String(r.overdrives) },
            { name: 'Clean sections', value: `${r.clean} / ${r.sections}` },
            {
              name: 'Pickups',
              value: r.totalPickups > 0 ? `${r.pickups} / ${r.totalPickups}` : '—',
            },
            { name: 'Shield saves', value: String(r.saves) },
          ],
        ],
      });
    },
  };
}
