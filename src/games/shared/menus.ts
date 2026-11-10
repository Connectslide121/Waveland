import {
  bindingLabel,
  CONTROL_ACTION_NAMES,
  CONTROL_DEVICES,
  keyLabel,
  padLabel,
  PAUSE_KEY,
  PAUSE_PAD_BUTTON,
  type Bindings,
  type ControlAction,
} from '../../core';
import { el } from './dom';
import { formatScore } from './format';
import './menus.css';

/**
 * The menus every game shows over its canvas: the pause menu (with the game's controls)
 * and the results screen. They are modals: they take the keys, keep focus inside and never
 * close on a backdrop click.
 */

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
export function modal(
  heading: string,
  actions: MenuAction[],
  onEscape: (() => void) | null,
): Modal & { body: HTMLElement; show(): void } {
  const element = el('div', 'game-modal');
  element.hidden = true;
  const panel = el('div', 'game-modal__panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  const title = el('h2', 'game-modal__title', heading);
  title.id = `game-modal-${heading.toLowerCase().replace(/\W+/g, '-')}`;
  panel.setAttribute('aria-labelledby', title.id);
  const body = el('div', 'game-modal__body');
  const row = el('div', 'game-modal__actions');
  const buttons = actions.map((action) => {
    const button = el('button', `game-button${action.primary ? ' game-button--primary' : ''}`);
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

/** An action's binding for a key chip: its first key, else its first gamepad or mouse button. */
export function chipBinding(bindings: Bindings, action: ControlAction): string {
  const b = bindings[action];
  const key = b.keys.find((k) => k !== null);
  if (key) return keyLabel(key);
  const pad = b.pad.find((p) => p !== null);
  if (pad !== undefined && pad !== null) return padName(padLabel(pad));
  const mouse = b.mouse.find((m) => m !== null);
  if (mouse) return bindingLabel('mouse', mouse);
  return 'Unbound';
}

/** A game's controls as a list: each of its actions with what it is bound to, and pause. */
export function controlsList(bindings: Bindings, actions: readonly ControlAction[]): HTMLElement {
  const list = el('dl', 'game-controls');
  const row = (name: string, value: string) => {
    const item = el('div', 'game-controls__row');
    // Each binding stays whole: lines break only between them ("Right click", "D-pad ↓").
    const dd = el('dd');
    value.split(' · ').forEach((part, i) => {
      if (i > 0) dd.append(' · ');
      dd.append(el('span', 'game-controls__binding', part));
    });
    item.append(el('dt', undefined, name), dd);
    list.append(item);
  };
  for (const action of actions) row(CONTROL_ACTION_NAMES[action], bindingsText(bindings, action));
  row('Pause', `${keyLabel(PAUSE_KEY)} · ${padName(padLabel(PAUSE_PAD_BUTTON))}`);
  return list;
}

/** The "Save run data" action, when the game records its runs. */
const saveRun = (run?: () => void): MenuAction[] => (run ? [{ label: 'Save run data', run }] : []);

export interface PauseMenu extends Modal {
  show(): void;
  /** Show the controls as they are bound now (after a change in Settings). */
  refresh(): void;
}

export function createPauseMenu(handlers: {
  onResume: () => void;
  onRestart: () => void;
  onSettings: () => void;
  onQuit: () => void;
  /** Save the session's run data as a file, when the game records it. */
  onSaveRun?: () => void;
  /** The controls as bound now, shown on the menu. */
  bindings: () => Bindings;
  /** The game's actions, in the order its controls list shows them. */
  actions: readonly ControlAction[];
}): PauseMenu {
  const menu = modal(
    'Paused',
    [
      { label: 'Resume', hint: 'Esc', primary: true, run: handlers.onResume },
      { label: 'Restart', run: handlers.onRestart },
      { label: 'Settings', run: handlers.onSettings },
      ...saveRun(handlers.onSaveRun),
      { label: 'Quit', run: handlers.onQuit },
    ],
    handlers.onResume,
  );
  const controls = el('div');
  const refresh = () =>
    controls.replaceChildren(controlsList(handlers.bindings(), handlers.actions));
  menu.body.append(
    el('p', 'game-modal__note', 'The music waits for you.'),
    controls,
    el('p', 'game-modal__note game-modal__note--small', 'Change the controls in Settings.'),
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

/** One line of the results breakdown: a name and its number, right-aligned. */
export interface ResultsRow {
  name: string;
  value: string;
  /** Lit in the score colour (perfects). */
  highlight?: boolean;
}

/** What a results screen shows: the score, the rank, and two columns of rows. */
export interface ResultsSummary {
  score: number;
  rank: string;
  columns: [ResultsRow[], ResultsRow[]];
}

export interface ResultsScreen<R = ResultsSummary> extends Modal {
  show(results: R): void;
}

export function createResultsScreen(
  title: string,
  handlers: {
    onRetry: () => void;
    onBack: () => void;
    /** Save the session's run data as a file, when the game records it. */
    onSaveRun?: () => void;
    /** The ranks' thresholds in words, under the breakdown. */
    rankRules: string;
  },
): ResultsScreen {
  const menu = modal(
    'Song complete',
    [
      { label: 'Retry', primary: true, run: handlers.onRetry },
      ...saveRun(handlers.onSaveRun),
      { label: 'Back to menu', run: handlers.onBack },
    ],
    null,
  );
  menu.element.classList.add('game-modal--results');
  const song = el('p', 'game-results__song', title);
  // The score with the rank beside it.
  const head = el('div', 'game-results__head');
  const score = el('p', 'game-results__score');
  const rank = el('p', 'game-results__rank');
  head.append(score, rank);
  // Two columns of rows, names left and numbers right-aligned.
  const stats = el('div', 'game-results__stats');
  const columns = [el('dl', 'game-results__col'), el('dl', 'game-results__col')] as const;
  stats.append(...columns);
  const thresholds = el('p', 'game-results__ranks', handlers.rankRules);
  menu.body.append(song, head, stats, thresholds);

  const row = ({ name, value, highlight }: ResultsRow) => {
    const item = el('div', `game-results__row${highlight ? ' game-results__row--highlight' : ''}`);
    item.append(el('dt', undefined, name), el('dd', undefined, value));
    return item;
  };

  return {
    element: menu.element,
    get open() {
      return menu.open;
    },
    close: () => menu.close(),
    destroy: () => menu.destroy(),
    show(results) {
      score.textContent = formatScore(results.score);
      rank.textContent = results.rank;
      rank.dataset.rank = results.rank;
      rank.setAttribute('aria-label', `Rank ${results.rank}`);
      results.columns.forEach((rows, i) => columns[i]!.replaceChildren(...rows.map(row)));
      menu.show();
    },
  };
}
