import {
  bindingKey,
  bindingLabel,
  bindInput,
  BINDING_SLOTS,
  CONTROL_ACTIONS,
  CONTROL_DEVICES,
  getBindings,
  keyLabel,
  MOUSE_BUTTONS,
  padLabel,
  PAUSE_KEY,
  PAUSE_PAD_BUTTON,
  resetBindings,
  setBindings,
  type ActionBindings,
  type ControlAction,
  type ControlDevice,
  type MouseButton,
} from '../core';

/**
 * The Settings modal's Controls section: jump, dash and slam, each with its key, mouse
 * and gamepad slots in aligned columns. Click a slot, then press what to use; Escape
 * cancels, Backspace clears. An input another action had moves here, and the row says
 * so. Pause is fixed (Escape and Start) and says so.
 */

export interface ControlsSection {
  element: HTMLElement;
  /** Show the bindings as stored now. */
  render(): void;
  /** The modal's keys go here first; true when the section took the key. */
  handleKey(event: KeyboardEvent): boolean;
  /** Stop waiting for an input (the modal closes). */
  stop(): void;
}

const ACTION_NAMES: Record<ControlAction, string> = { jump: 'Jump', dash: 'Dash', slam: 'Slam' };
const DEVICE_NAMES: Record<ControlDevice, string> = {
  keys: 'Keyboard',
  mouse: 'Mouse',
  pad: 'Gamepad',
};
/** What a waiting slot asks for. */
const WAIT_TEXT: Record<ControlDevice, string> = {
  keys: 'Press a key',
  mouse: 'Click a button',
  pad: 'Press a button',
};
/** Short names for the slots, so they fit a phone's column; the full name is the label. */
const MOUSE_SHORT: Record<MouseButton, string> = {
  left: 'Left',
  right: 'Right',
  middle: 'Middle',
  back: 'Back',
  forward: 'Fwd',
};
const PAD_SHORT: Record<number, string> = { 12: 'D ↑', 13: 'D ↓', 14: 'D ←', 15: 'D →' };

const RESET_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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

type Value = NonNullable<ActionBindings[ControlDevice][number]>;

function shortLabel(device: ControlDevice, value: Value): string {
  if (device === 'keys') return keyLabel(value as string);
  if (device === 'mouse') return MOUSE_SHORT[value as MouseButton];
  return PAD_SHORT[value as number] ?? padLabel(value as number);
}

const mouseName = (button: number) =>
  (Object.keys(MOUSE_BUTTONS) as MouseButton[]).find((m) => MOUSE_BUTTONS[m] === button);

/** Where to read gamepads from; tests pass their own. */
export type PadSource = () => readonly (Gamepad | null)[];
const browserPads: PadSource = () =>
  typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];

export function createControlsSection(pads: PadSource = browserPads): ControlsSection {
  const element = el('section', 'controls');
  element.setAttribute('aria-labelledby', 'settings-controls');
  const head = el('div', 'controls__top');
  const title = el('h3', 'settings__label', 'Controls');
  title.id = 'settings-controls';
  const resetAll = el('button', 'controls__reset-all', 'Reset all');
  resetAll.type = 'button';
  head.append(title, resetAll);

  const grid = el('div', 'controls__grid');
  grid.setAttribute('role', 'table');
  grid.setAttribute('aria-labelledby', title.id);
  const header = el('div', 'controls__row controls__row--head');
  header.setAttribute('role', 'row');
  for (const name of ['Action', ...CONTROL_DEVICES.map((d) => DEVICE_NAMES[d])]) {
    const cell = el('span', 'controls__head', name);
    cell.setAttribute('role', 'columnheader');
    header.append(cell);
  }
  grid.append(header);

  // What each action's note says: a conflict moved, or why an input can't be used.
  const notes = new Map<ControlAction, string>();
  let waiting: { action: ControlAction; device: ControlDevice; slot: number } | null = null;
  /** Gamepad buttons already down when waiting started, so only a new press binds. */
  let padsDown = new Set<number>();
  let frame = 0;

  const rows = CONTROL_ACTIONS.map((action) => {
    const row = el('div', 'controls__row');
    row.setAttribute('role', 'row');
    const name = el('div', 'controls__action');
    name.setAttribute('role', 'rowheader');
    const reset = el('button', 'controls__reset');
    reset.type = 'button';
    reset.innerHTML = RESET_ICON;
    reset.setAttribute('aria-label', `Reset ${ACTION_NAMES[action].toLowerCase()} to its defaults`);
    reset.title = 'Reset to defaults';
    reset.addEventListener('click', () => {
      cancel();
      resetBindings(action);
      notes.set(action, `${ACTION_NAMES[action]} is back to its defaults.`);
      render();
    });
    name.append(el('span', undefined, ACTION_NAMES[action]), reset);
    row.append(name);
    const slots = new Map<ControlDevice, HTMLButtonElement[]>();
    for (const device of CONTROL_DEVICES) {
      const cell = el('div', 'controls__slots');
      cell.setAttribute('role', 'cell');
      const buttons = Array.from({ length: BINDING_SLOTS[device] }, (_, slot) => {
        const button = el('button', 'controls__slot');
        button.type = 'button';
        button.addEventListener('click', (event) => {
          // A click that starts waiting for a mouse button isn't the button itself.
          event.stopPropagation();
          start(action, device, slot);
        });
        return cell.appendChild(button);
      });
      slots.set(device, buttons);
      row.append(cell);
    }
    const note = el('p', 'controls__note');
    note.setAttribute('aria-live', 'polite');
    row.append(note);
    grid.append(row);
    return { action, slots, note };
  });

  // Pause: fixed, said plainly.
  const pause = el('div', 'controls__row controls__row--fixed');
  pause.setAttribute('role', 'row');
  const pauseName = el('div', 'controls__action');
  pauseName.setAttribute('role', 'rowheader');
  pauseName.append(el('span', undefined, 'Pause'));
  pause.append(pauseName);
  for (const text of [keyLabel(PAUSE_KEY), '—', padLabel(PAUSE_PAD_BUTTON)]) {
    const cell = el('div', 'controls__slots');
    cell.setAttribute('role', 'cell');
    cell.append(el('span', 'controls__slot controls__slot--fixed', text));
    pause.append(cell);
  }
  pause.append(el('p', 'controls__note', 'Esc and Start always pause; they can’t be changed.'));
  grid.append(pause);

  // What Reset all did, on a line of its own that is always there.
  const foot = el('p', 'controls__foot');
  foot.setAttribute('aria-live', 'polite');
  element.append(head, grid, foot);

  function render(): void {
    const bindings = getBindings();
    for (const { action, slots, note } of rows) {
      for (const device of CONTROL_DEVICES)
        slots.get(device)!.forEach((button, slot) => {
          const value = bindings[action][device][slot] ?? null;
          const isWaiting =
            waiting?.action === action && waiting.device === device && waiting.slot === slot;
          button.classList.toggle('waiting', isWaiting);
          button.classList.toggle('empty', value === null && !isWaiting);
          button.textContent = isWaiting
            ? 'Press…'
            : value === null
              ? '—'
              : shortLabel(device, value);
          const what = value === null ? 'nothing' : bindingLabel(device, value as never);
          button.setAttribute(
            'aria-label',
            isWaiting
              ? `${ACTION_NAMES[action]}, ${DEVICE_NAMES[device]} slot ${slot + 1}: ${WAIT_TEXT[device].toLowerCase()}, Escape cancels`
              : `${ACTION_NAMES[action]}, ${DEVICE_NAMES[device]} slot ${slot + 1}: ${what}. Change`,
          );
          button.title = value === null ? 'Not bound' : bindingLabel(device, value as never);
        });
      const isWaiting = waiting?.action === action;
      note.textContent = isWaiting
        ? `${WAIT_TEXT[waiting!.device]} for ${ACTION_NAMES[action].toLowerCase()} · Esc cancels · Backspace clears`
        : (notes.get(action) ?? '');
      note.classList.toggle('waiting', isWaiting);
    }
  }

  function start(action: ControlAction, device: ControlDevice, slot: number): void {
    cancel();
    foot.textContent = '';
    waiting = { action, device, slot };
    notes.delete(action);
    if (device === 'pad') {
      padsDown = pressedPadButtons();
      frame = requestAnimationFrame(pollPads);
    }
    render();
  }

  function cancel(): void {
    waiting = null;
    cancelAnimationFrame(frame);
    render();
  }

  /** Bind `value` to the slot being waited on; null clears it. */
  function bind(value: Value | null): void {
    if (!waiting) return;
    const { action, device, slot } = waiting;
    const result = bindInput(getBindings(), action, device, slot, value as never);
    waiting = null;
    cancelAnimationFrame(frame);
    if (!result.ok) {
      notes.set(
        action,
        `${device === 'keys' ? keyLabel(PAUSE_KEY) : padLabel(PAUSE_PAD_BUTTON)} always pauses; pick another.`,
      );
    } else {
      notes.delete(action);
      if (result.movedFrom && value !== null) {
        const label = bindingLabel(device, value as never);
        const from = ACTION_NAMES[result.movedFrom].toLowerCase();
        notes.set(action, `${label} was ${from}; now ${action}.`);
        notes.set(result.movedFrom, `${label} moved to ${action}.`);
      }
      setBindings(result.bindings);
    }
    render();
    rows
      .find((r) => r.action === action)
      ?.slots.get(device)
      ?.[slot]?.focus();
  }

  function pressedPadButtons(): Set<number> {
    const down = new Set<number>();
    for (const pad of pads()) {
      if (!pad?.connected) continue;
      pad.buttons.forEach((b, i) => b.pressed && down.add(i));
    }
    return down;
  }

  function pollPads(): void {
    if (waiting?.device !== 'pad') return;
    const down = pressedPadButtons();
    for (const button of down)
      if (!padsDown.has(button)) {
        bind(button);
        return;
      }
    padsDown = down;
    frame = requestAnimationFrame(pollPads);
  }

  // A mouse button anywhere binds it while a mouse slot waits; it presses nothing else
  // (its click, its menu), even once bound.
  /** The button just bound: its own release, click and menu are eaten, until the next press. */
  let eating: number | null = null;
  const mouseDown = (event: MouseEvent) => {
    eating = null;
    if (waiting?.device !== 'mouse') return;
    const name = mouseName(event.button);
    if (!name) return;
    event.preventDefault();
    event.stopPropagation();
    eating = event.button;
    bind(name);
  };
  const swallow = (event: Event) => {
    const button = (event as MouseEvent).button;
    if (waiting?.device === 'mouse' || (eating !== null && button === eating)) {
      event.preventDefault();
      event.stopPropagation();
      // A click is the last of a press: what comes after is the player's again.
      if (event.type === 'click' || event.type === 'auxclick') eating = null;
    }
  };
  const swallowed = ['mouseup', 'click', 'auxclick', 'contextmenu'];
  window.addEventListener('mousedown', mouseDown, true);
  for (const type of swallowed) window.addEventListener(type, swallow, true);

  resetAll.addEventListener('click', () => {
    cancel();
    resetBindings();
    notes.clear();
    foot.textContent = 'Every control is back to its defaults.';
    render();
  });

  render();
  return {
    element,
    render,
    handleKey(event) {
      if (!waiting) return false;
      event.preventDefault();
      if (event.repeat) return true;
      if (event.code === 'Escape') cancel();
      else if (event.code === 'Backspace' || event.code === 'Delete') bind(null);
      else if (waiting.device === 'keys') bind(bindingKey(event.code));
      // Other devices ignore keys, but Tab and the like stay with the wait.
      return true;
    },
    stop() {
      cancelAnimationFrame(frame);
      waiting = null;
      window.removeEventListener('mousedown', mouseDown, true);
      for (const type of swallowed) window.removeEventListener(type, swallow, true);
    },
  };
}
