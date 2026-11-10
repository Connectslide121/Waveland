import type { RunResults } from './run';
import './ui.css';

/**
 * The platformer's HTML over the canvas: the HUD (song, beat dots, score, progress with
 * the drops marked, the count-in), the pause menu and the results screen. Menus are
 * modals: they take the keys, keep focus inside and never close on a backdrop click.
 */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The score as six digits in two groups, like an arcade counter: 048 210. */
export function formatScore(score: number): string {
  const digits = String(Math.max(0, Math.floor(score))).padStart(6, '0');
  return digits.replace(/\B(?=(\d{3})+$)/g, ' ');
}

/** Accuracy as a whole percentage, or a dash when there were no landings to judge. */
export function formatAccuracy(accuracy: number | null): string {
  return accuracy === null ? '—' : `${Math.round(accuracy * 100)}%`;
}

export interface HudOptions {
  title: string;
  tempo: number;
  duration: number;
  /** Song times of the drops, marked on the progress bar. */
  drops: number[];
}

export interface HudState {
  time: number;
  /** Which beat of the bar is playing, 0–3, or -1 before the first. */
  beatInBar: number;
  score: number;
  combo: number;
  multiplier: number;
  /** Beats left in the count-in, or null when not counting in. */
  countIn: number | null;
}

export interface Hud {
  element: HTMLElement;
  update(state: HudState): void;
}

export function createHud({ title, tempo, duration, drops }: HudOptions): Hud {
  const element = el('div', 'pf-hud');
  const top = el('div', 'pf-hud__top');

  const song = el('div', 'pf-hud__song');
  song.append(el('b', undefined, title), ` · ${Math.round(tempo)} BPM`);

  const beats = el('div', 'pf-hud__beats');
  beats.setAttribute('aria-hidden', 'true');
  const dots = Array.from({ length: 4 }, () => beats.appendChild(el('i')));

  const scoreBox = el('div', 'pf-hud__score-box');
  const score = el('div', 'pf-hud__score', formatScore(0));
  score.setAttribute('aria-label', 'Score');
  // The combo line is always there, so the score never moves when it appears.
  const combo = el('div', 'pf-hud__combo', ' ');
  scoreBox.append(score, combo);
  top.append(song, beats, scoreBox);

  const progress = el('div', 'pf-hud__progress');
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', 'Song progress');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  const fill = el('div', 'pf-hud__fill');
  progress.append(fill);
  for (const drop of drops) {
    const mark = el('i', 'pf-hud__drop');
    mark.style.left = `${(100 * drop) / duration}%`;
    mark.title = 'Drop';
    progress.append(mark);
  }

  const count = el('div', 'pf-hud__count');
  count.setAttribute('aria-live', 'polite');

  element.append(top, progress, count);

  let shown = { beat: -2, score: -1, combo: -1, count: -2 as number | null, percent: -1 };
  return {
    element,
    update(state) {
      if (state.beatInBar !== shown.beat)
        dots.forEach((dot, i) => dot.classList.toggle('on', i === state.beatInBar));
      if (state.score !== shown.score) score.textContent = formatScore(state.score);
      if (state.combo !== shown.combo)
        combo.textContent = state.combo > 1 ? `${state.combo} combo · ×${state.multiplier}` : ' ';
      if (state.countIn !== shown.count) {
        count.textContent = state.countIn === null ? '' : String(state.countIn);
        count.classList.toggle('on', state.countIn !== null);
      }
      const percent = Math.round((1000 * Math.max(0, state.time)) / duration) / 10;
      if (percent !== shown.percent) {
        fill.style.width = `${Math.min(100, percent)}%`;
        progress.setAttribute('aria-valuenow', String(Math.round(percent)));
      }
      shown = {
        beat: state.beatInBar,
        score: state.score,
        combo: state.combo,
        count: state.countIn,
        percent,
      };
    },
  };
}

interface MenuAction {
  label: string;
  /** A short key hint shown on the button. */
  hint?: string;
  primary?: boolean;
  run: () => void;
}

export interface Modal {
  element: HTMLElement;
  readonly open: boolean;
  close(): void;
  /** Stop listening for keys; the element goes with the session's container. */
  destroy(): void;
}

/** A modal panel with a heading, some content and a row of actions. */
function modal(
  heading: string,
  actions: MenuAction[],
  onEscape: (() => void) | null,
): Modal & { body: HTMLElement; show(): void } {
  const element = el('div', 'pf-modal');
  element.hidden = true;
  const panel = el('div', 'pf-modal__panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  const title = el('h2', 'pf-modal__title', heading);
  title.id = `pf-modal-${heading.toLowerCase().replace(/\W+/g, '-')}`;
  panel.setAttribute('aria-labelledby', title.id);
  const body = el('div', 'pf-modal__body');
  const row = el('div', 'pf-modal__actions');
  const buttons = actions.map((action) => {
    const button = el('button', `pf-button${action.primary ? ' pf-button--primary' : ''}`);
    button.type = 'button';
    button.append(el('span', undefined, action.label));
    if (action.hint) button.append(el('kbd', undefined, action.hint));
    button.addEventListener('click', action.run);
    return row.appendChild(button);
  });
  panel.append(title, body, row);
  element.append(panel);

  const keys = (event: KeyboardEvent) => {
    if (element.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onEscape?.();
    } else if (event.key === 'Tab') {
      // Keep focus on the menu's buttons.
      event.preventDefault();
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = (at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      buttons[at < 0 ? 0 : next]!.focus();
    }
  };
  window.addEventListener('keydown', keys);

  return {
    element,
    body,
    get open() {
      return !element.hidden;
    },
    show() {
      element.hidden = false;
      buttons[0]?.focus();
    },
    close() {
      element.hidden = true;
    },
    destroy() {
      window.removeEventListener('keydown', keys);
    },
  };
}

export interface PauseMenu extends Modal {
  show(): void;
}

export function createPauseMenu(handlers: {
  onResume: () => void;
  onRestart: () => void;
  onSettings: () => void;
  onQuit: () => void;
}): PauseMenu {
  const menu = modal(
    'Paused',
    [
      { label: 'Resume', hint: 'Esc', primary: true, run: handlers.onResume },
      { label: 'Restart', run: handlers.onRestart },
      { label: 'Settings', run: handlers.onSettings },
      { label: 'Quit', run: handlers.onQuit },
    ],
    handlers.onResume,
  );
  menu.body.append(el('p', 'pf-modal__note', 'The music waits for you.'));
  return menu;
}

export interface ResultsScreen extends Modal {
  show(results: RunResults): void;
}

export function createResultsScreen(
  title: string,
  handlers: { onRetry: () => void; onBack: () => void },
): ResultsScreen {
  const menu = modal(
    'Song complete',
    [
      { label: 'Retry', primary: true, run: handlers.onRetry },
      { label: 'Back to menu', run: handlers.onBack },
    ],
    null,
  );
  menu.element.classList.add('pf-modal--results');
  const song = el('p', 'pf-results__song', title);
  const score = el('p', 'pf-results__score');
  const stats = el('dl', 'pf-results__stats');
  menu.body.append(song, score, stats);

  const stat = (name: string, value: string) => {
    const box = el('div', 'pf-results__stat');
    box.append(el('dt', undefined, name), el('dd', undefined, value));
    return box;
  };

  return {
    element: menu.element,
    get open() {
      return menu.open;
    },
    close: () => menu.close(),
    destroy: () => menu.destroy(),
    show(results: RunResults) {
      score.textContent = formatScore(results.score);
      stats.replaceChildren(
        stat('Accuracy', formatAccuracy(results.accuracy)),
        stat('Deaths', String(results.deaths)),
        stat(
          'Pickups',
          results.totalPickups > 0 ? `${results.pickups} / ${results.totalPickups}` : '—',
        ),
        stat('Best combo', String(results.bestCombo)),
      );
      menu.show();
    },
  };
}
