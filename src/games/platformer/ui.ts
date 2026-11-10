import {
  bindingLabel,
  CONTROL_ACTIONS,
  CONTROL_DEVICES,
  keyLabel,
  padLabel,
  PAUSE_KEY,
  PAUSE_PAD_BUTTON,
  type Bindings,
  type ControlAction,
} from '../../core';
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
  /** Frames per second and CPU ms per frame, or null when the readout is off. */
  perf: { fps: number; cpuMs: number } | null;
  /** A one-line hint for an ability met for the first time ("Right click / Shift: dash"), or null. */
  hint: string | null;
}

/** The frame rate readout: 60 FPS · 4.2 MS, or dashes before the first half second. */
export function formatPerf(fps: number, cpuMs: number): string {
  if (fps <= 0) return '— FPS · — MS';
  return `${Math.round(fps)} FPS · ${cpuMs.toFixed(1)} MS`;
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

  // Frame rate and frame time, bottom right over the progress bar, when Settings asks.
  const perf = el('div', 'pf-hud__perf');
  perf.hidden = true;

  // The first-time hint: placed on its own, so it never moves anything when it shows.
  const hint = el('div', 'pf-hud__hint');
  hint.setAttribute('aria-live', 'polite');

  element.append(top, progress, count, perf, hint);

  // What is on screen, so each frame only touches what changed.
  const shown = {
    beat: -2,
    score: -1,
    combo: -1,
    count: -2 as number | null,
    percent: -1,
    perf: '',
    hint: null as string | null,
  };
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
      const perfText = state.perf ? formatPerf(state.perf.fps, state.perf.cpuMs) : '';
      if (perfText !== shown.perf) {
        perf.textContent = perfText;
        perf.hidden = perfText === '';
      }
      if (state.hint !== shown.hint) {
        // The last text stays while it fades out.
        if (state.hint !== null) hint.textContent = state.hint;
        hint.classList.toggle('on', state.hint !== null);
      }
      shown.hint = state.hint;
      shown.beat = state.beatInBar;
      shown.score = state.score;
      shown.combo = state.combo;
      shown.count = state.countIn;
      shown.percent = percent;
      shown.perf = perfText;
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
  /** Show the controls as they are bound now (after a change in Settings). */
  refresh(): void;
}

const ACTION_NAMES: Record<ControlAction, string> = {
  jump: 'Jump',
  dash: 'Dash',
  slam: 'Slam',
};

/** A gamepad button in a list next to keys: "Pad X", so it isn't read as the X key. */
const padName = (label: string) => (label.startsWith('D-pad') ? label : `Pad ${label}`);

/** Everything an action is bound to, as the player reads it: "Space · W · ↑ · Pad A". */
export function bindingsText(bindings: Bindings, action: ControlAction): string {
  const parts: string[] = [];
  for (const device of CONTROL_DEVICES)
    for (const value of bindings[action][device]) {
      if (value === null) continue;
      const label = bindingLabel(device, value as never);
      parts.push(device === 'pad' ? padName(label) : label);
    }
  return parts.length > 0 ? parts.join(' · ') : 'Not bound';
}

/** The controls as a list: each action with what it is bound to, and pause. */
export function controlsList(bindings: Bindings): HTMLElement {
  const list = el('dl', 'pf-controls');
  const row = (name: string, value: string) => {
    const item = el('div', 'pf-controls__row');
    item.append(el('dt', undefined, name), el('dd', undefined, value));
    list.append(item);
  };
  for (const action of CONTROL_ACTIONS) row(ACTION_NAMES[action], bindingsText(bindings, action));
  row('Pause', `${keyLabel(PAUSE_KEY)} · ${padName(padLabel(PAUSE_PAD_BUTTON))}`);
  return list;
}

export function createPauseMenu(handlers: {
  onResume: () => void;
  onRestart: () => void;
  onSettings: () => void;
  onQuit: () => void;
  /** The controls as bound now, shown on the menu. */
  bindings: () => Bindings;
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
  const controls = el('div');
  const refresh = () => controls.replaceChildren(controlsList(handlers.bindings()));
  menu.body.append(
    el('p', 'pf-modal__note', 'The music waits for you.'),
    controls,
    el('p', 'pf-modal__note pf-modal__note--small', 'Change the controls in Settings.'),
  );
  refresh();
  return {
    element: menu.element,
    get open() {
      return menu.open;
    },
    close: () => menu.close(),
    destroy: () => menu.destroy(),
    show() {
      refresh();
      menu.show();
    },
    refresh,
  };
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
