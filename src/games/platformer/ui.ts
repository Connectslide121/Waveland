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
import type { BoosterKind } from './level';
import { COMBO_STEP, MAX_MULTIPLIER, RANKS, type RunResults } from './run';
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
  /** The difficulty's name, after the tempo. */
  difficulty?: string;
}

export interface HudState {
  time: number;
  /** The tempo at `time`, following the song's tempo map; the song's main tempo when left out. */
  tempo?: number;
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
  /** The overdrive meter, 0 to 1. */
  meter?: number;
  /** While overdrive runs, the share of it left, 0 to 1; null otherwise. */
  overdrive?: number | null;
  /** What overdrive is bound to, as a key chip shows it ("E"). */
  overdriveKey?: string;
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

/** The frame rate readout: 60 FPS · 4.2 MS, or dashes before the first half second. */
export function formatPerf(fps: number, cpuMs: number): string {
  if (fps <= 0) return '— FPS · — MS';
  return `${Math.round(fps)} FPS · ${cpuMs.toFixed(1)} MS`;
}

export interface Hud {
  element: HTMLElement;
  update(state: HudState): void;
}

export function createHud({ title, tempo, duration, drops, difficulty }: HudOptions): Hud {
  const element = el('div', 'pf-hud');
  const top = el('div', 'pf-hud__top');

  const song = el('div', 'pf-hud__song');
  const bpm = document.createTextNode(` · ${Math.round(tempo)} BPM`);
  song.append(el('b', undefined, title), bpm);
  if (difficulty) song.append(` · ${difficulty}`);

  const beats = el('div', 'pf-hud__beats');
  beats.setAttribute('aria-hidden', 'true');
  const dots = Array.from({ length: 4 }, () => beats.appendChild(el('i')));

  const scoreBox = el('div', 'pf-hud__score-box');
  const score = el('div', 'pf-hud__score', formatScore(0));
  score.setAttribute('aria-label', 'Score');
  // The combo meter is always there, so the score never moves: the multiplier, the steps
  // to the next one, and the combo count.
  const combo = el('div', 'pf-hud__combo none');
  combo.setAttribute('role', 'status');
  const mult = el('b', 'pf-hud__mult', '×1');
  const steps = el('span', 'pf-hud__steps');
  const ticks = Array.from({ length: COMBO_STEP }, () => steps.appendChild(el('i')));
  const comboCount = el('span', 'pf-hud__combo-count', '0');
  combo.append(mult, steps, comboCount);
  scoreBox.append(score, combo);
  top.append(song, beats, scoreBox);

  // Overdrive and the boosters, bottom left over the progress bar, in fixed places.
  const status = el('div', 'pf-hud__status');
  const od = el('div', 'pf-od');
  const odHead = el('div', 'pf-od__head');
  const odState = el('span', 'pf-od__state', 'Perfects and gems fill it');
  odHead.append(el('span', 'pf-od__name', 'Overdrive'), odState);
  const odRow = el('div', 'pf-od__row');
  const odBar = el('div', 'pf-od__bar');
  odBar.setAttribute('role', 'meter');
  odBar.setAttribute('aria-label', 'Overdrive');
  odBar.setAttribute('aria-valuemin', '0');
  odBar.setAttribute('aria-valuemax', '100');
  odBar.setAttribute('aria-valuenow', '0');
  const odFill = el('div', 'pf-od__fill');
  odBar.append(odFill);
  const odKey = el('kbd', 'pf-od__key', '');
  odRow.append(odBar, odKey);
  od.append(odHead, odRow);
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
  status.append(od, boosts);

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

  element.append(top, status, progress, count, perf, hint);

  // What is on screen, so each frame only touches what changed.
  const shown = {
    beat: -2,
    score: -1,
    combo: -1,
    count: -2 as number | null,
    percent: -1,
    perf: '',
    hint: null as string | null,
    tempo: Math.round(tempo),
    mult: 0,
    od: '',
    boosts: { shield: -2, magnet: -2, dash: -2 } as Record<BoosterKind, number>,
  };
  return {
    element,
    update(state) {
      const now = Math.round(state.tempo ?? tempo);
      if (now !== shown.tempo) {
        bpm.textContent = ` · ${now} BPM`;
        shown.tempo = now;
      }
      if (state.beatInBar !== shown.beat)
        dots.forEach((dot, i) => dot.classList.toggle('on', i === state.beatInBar));
      if (state.score !== shown.score) score.textContent = formatScore(state.score);
      if (state.combo !== shown.combo || state.multiplier !== shown.mult) {
        mult.textContent = `×${state.multiplier}`;
        const maxed = state.multiplier >= MAX_MULTIPLIER;
        const filled = maxed ? COMBO_STEP : state.combo % COMBO_STEP;
        ticks.forEach((tick, i) => tick.classList.toggle('on', i < filled));
        combo.classList.toggle('max', maxed);
        combo.classList.toggle('none', state.combo === 0);
        comboCount.textContent = String(state.combo);
        combo.setAttribute('aria-label', `Combo ${state.combo}, ×${state.multiplier}`);
        shown.mult = state.multiplier;
      }
      // Overdrive: filling, ready (with the key to press), or running down.
      const meter = state.meter ?? 0;
      const running = state.overdrive ?? null;
      const key = state.overdriveKey ?? '';
      const share = Math.round(100 * (running ?? meter));
      const ready = running === null && meter >= 1;
      const odText =
        running !== null
          ? 'Score ×2'
          : ready
            ? `Ready · press ${key}`
            : 'Perfects and gems fill it';
      const odShown = `${share}|${odText}|${key}`;
      if (odShown !== shown.od) {
        odFill.style.width = `${share}%`;
        odBar.setAttribute('aria-valuenow', String(share));
        odState.textContent = odText;
        odKey.textContent = key;
        od.classList.toggle('ready', ready);
        od.classList.toggle('on', running !== null);
        shown.od = odShown;
      }
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
  overdrive: 'Overdrive',
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

/**
 * The ranks' thresholds in words, from `RANKS`: "S: timing 85%+, no deaths · A: 70%+, at
 * most 2 deaths · B: 50%+ · C: finished". Timing counts a good as half a perfect.
 */
const NBSP = String.fromCharCode(160);

export function rankRules(): string {
  const parts = RANKS.map(({ rank, timing, deaths }) => {
    if (timing === 0) return `${rank}: finished`;
    const t = `${Math.round(timing * 100)}%+`;
    const d =
      deaths === 0 ? ', no deaths' : Number.isFinite(deaths) ? `, at most ${deaths} deaths` : '';
    return `${rank}: timing ${t}${d}`;
  });
  // Each rank's rule stays on one line.
  const whole = parts.map((p) => p.replace(/ /g, NBSP));
  return `${whole.join(' · ')}. Timing counts a good as half a perfect.`;
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
  // The score with the rank beside it.
  const head = el('div', 'pf-results__head');
  const score = el('p', 'pf-results__score');
  const rank = el('p', 'pf-results__rank');
  head.append(score, rank);
  // Two columns of rows, names left and numbers right-aligned.
  const stats = el('div', 'pf-results__stats');
  const columns = [el('dl', 'pf-results__col'), el('dl', 'pf-results__col')];
  stats.append(...columns);
  const thresholds = el('p', 'pf-results__ranks', rankRules());
  menu.body.append(song, head, stats, thresholds);

  const row = (name: string, value: string, kind = '') => {
    const item = el('div', `pf-results__row${kind ? ` pf-results__row--${kind}` : ''}`);
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
    show(results: RunResults) {
      score.textContent = formatScore(results.score);
      rank.textContent = results.rank;
      rank.dataset.rank = results.rank;
      rank.setAttribute('aria-label', `Rank ${results.rank}`);
      const r = results;
      columns[0]!.replaceChildren(
        row('Perfect', String(r.perfect), 'perfect'),
        row('Good', String(r.good)),
        row('Miss', String(r.miss)),
        row('Timing', formatAccuracy(r.timing)),
        row('Deaths', String(r.deaths)),
      );
      columns[1]!.replaceChildren(
        row('Best combo', String(r.bestCombo)),
        row('Overdrives', String(r.overdrives)),
        row('Clean sections', `${r.clean} / ${r.sections}`),
        row('Pickups', r.totalPickups > 0 ? `${r.pickups} / ${r.totalPickups}` : '—'),
        row('Shield saves', String(r.saves)),
      );
      menu.show();
    },
  };
}
