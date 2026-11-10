/** The player's settings, kept in localStorage: music volume, effects and audio latency. */

import { DIFFICULTIES, type Difficulty } from './types';

const LATENCY_KEY = 'waveland.latencyMs';
const VOLUME_KEY = 'waveland.musicVolume';
const EFFECTS_KEY = 'waveland.effects';
/** The widest latency offset the settings take, either way. */
export const MAX_LATENCY_MS = 500;

/**
 * full: every effect. reduced: no flashes and no screen shake, for players sensitive to
 * them; the default when the system asks for reduced motion.
 */
export type EffectsLevel = 'full' | 'reduced';

type Listener = () => void;
const listeners = new Set<Listener>();

/** Call `listener` whenever a setting changes; returns a function that stops it. */
export function onSettingsChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    memory.delete(key);
  } catch {
    // No storage (some private windows): the setting holds until the page closes.
    memory.set(key, value);
  }
  for (const listener of listeners) listener();
}

/** Settings kept for this page only, when storage can't be written. */
const memory = new Map<string, string | null>();

function get(key: string): string | null {
  return memory.has(key) ? memory.get(key)! : read(key);
}

/**
 * How much later than the browser reports the player hears the sound, in ms: positive for
 * Bluetooth headphones or a TV, negative when visuals feel late. 0 until calibrated.
 */
export function getLatencyMs(): number {
  const value = Number(get(LATENCY_KEY));
  return Number.isFinite(value) ? clampLatency(value) : 0;
}

export function setLatencyMs(ms: number): void {
  write(LATENCY_KEY, String(clampLatency(ms)));
}

function clampLatency(ms: number): number {
  return Math.round(Math.max(-MAX_LATENCY_MS, Math.min(MAX_LATENCY_MS, ms)));
}

/** Music volume, 0 to 1; full until changed. */
export function getMusicVolume(): number {
  const stored = get(VOLUME_KEY);
  const value = stored === null ? 1 : Number(stored);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

export function setMusicVolume(volume: number): void {
  write(VOLUME_KEY, String(Math.round(Math.max(0, Math.min(1, volume)) * 100) / 100));
}

/** True when the system asks for reduced motion. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The effects level the player picked, or the system's preference when they never did. */
export function getEffects(): EffectsLevel {
  const stored = get(EFFECTS_KEY);
  if (stored === 'full' || stored === 'reduced') return stored;
  return prefersReducedMotion() ? 'reduced' : 'full';
}

/** Pick an effects level, or null to follow the system's preference again. */
export function setEffects(level: EffectsLevel | null): void {
  write(EFFECTS_KEY, level);
}

/** True when the player picked an effects level rather than following the system. */
export function hasChosenEffects(): boolean {
  const stored = get(EFFECTS_KEY);
  return stored === 'full' || stored === 'reduced';
}

const SHOW_FPS_KEY = 'waveland.showFps';

/** True when the HUD shows the frame rate and frame time; off until the player turns it on. */
export function getShowFps(): boolean {
  return get(SHOW_FPS_KEY) === 'on';
}

export function setShowFps(show: boolean): void {
  write(SHOW_FPS_KEY, show ? 'on' : null);
}

const DIFFICULTY_KEY = 'waveland.difficulty';

/** The difficulty the games build their levels at: the last one picked, normal until then. */
export function getDifficulty(): Difficulty {
  const stored = get(DIFFICULTY_KEY);
  return DIFFICULTIES.includes(stored as Difficulty) ? (stored as Difficulty) : 'normal';
}

export function setDifficulty(difficulty: Difficulty): void {
  write(DIFFICULTY_KEY, difficulty);
}

// Controls: which keys, mouse buttons and gamepad buttons do what.

const BINDINGS_KEY = 'waveland.controls';

/** What the player can bind. Pause is fixed: Escape and a gamepad's Start. */
export type ControlAction = 'jump' | 'dash' | 'slam' | 'overdrive';
export const CONTROL_ACTIONS: readonly ControlAction[] = ['jump', 'dash', 'slam', 'overdrive'];

export type MouseButton = 'left' | 'right' | 'middle' | 'back' | 'forward';
/** `MouseEvent.button` numbers, by name. */
export const MOUSE_BUTTONS: Record<MouseButton, number> = {
  left: 0,
  middle: 1,
  right: 2,
  back: 3,
  forward: 4,
};

export type ControlDevice = 'keys' | 'mouse' | 'pad';
export const CONTROL_DEVICES: readonly ControlDevice[] = ['keys', 'mouse', 'pad'];

/**
 * What one action is bound to. Keys are `KeyboardEvent.code`s, with the two Shift, Control,
 * Alt and Meta keys as one (`Shift`); pad buttons are standard-mapping button numbers.
 * Keys have three slots, so the arrows fit next to letters; mouse and gamepad two.
 */
export interface ActionBindings {
  keys: (string | null)[];
  mouse: (MouseButton | null)[];
  pad: (number | null)[];
}

export type Bindings = Record<ControlAction, ActionBindings>;

export const BINDING_SLOTS: Record<ControlDevice, number> = { keys: 3, mouse: 2, pad: 2 };

/** Standard gamepad buttons the defaults use. */
export const PAD_BUTTONS = { a: 0, b: 1, x: 2, y: 3, rb: 5, start: 9, up: 12, down: 13 } as const;

/** What can't be bound: they always pause. */
export const PAUSE_KEY = 'Escape';
export const PAUSE_PAD_BUTTON = PAD_BUTTONS.start;

export const DEFAULT_BINDINGS: Bindings = {
  jump: { keys: ['Space', 'KeyW', 'ArrowUp'], mouse: [null, null], pad: [PAD_BUTTONS.a, null] },
  dash: {
    keys: ['Shift', 'KeyJ', 'KeyX'],
    mouse: ['right', null],
    pad: [PAD_BUTTONS.x, PAD_BUTTONS.rb],
  },
  slam: {
    keys: ['KeyS', 'ArrowDown', null],
    mouse: ['left', null],
    pad: [PAD_BUTTONS.b, PAD_BUTTONS.down],
  },
  overdrive: { keys: ['KeyE', 'KeyL', null], mouse: [null, null], pad: [PAD_BUTTONS.y, null] },
};

/** A key's code as bindings keep it: either Shift (Control, Alt, Meta) is just `Shift`. */
export function bindingKey(code: string): string {
  const side = /^(Shift|Control|Alt|Meta)(Left|Right)$/.exec(code);
  return side ? side[1]! : code;
}

const copyBindings = (b: Bindings): Bindings =>
  Object.fromEntries(
    CONTROL_ACTIONS.map((a) => [
      a,
      { keys: [...b[a].keys], mouse: [...b[a].mouse], pad: [...b[a].pad] },
    ]),
  ) as Bindings;

const validSlot: Record<ControlDevice, (v: unknown) => boolean> = {
  keys: (v) => typeof v === 'string' && v.length > 0 && v !== PAUSE_KEY,
  mouse: (v) => typeof v === 'string' && v in MOUSE_BUTTONS,
  pad: (v) => Number.isInteger(v) && (v as number) >= 0 && v !== PAUSE_PAD_BUTTON,
};

/** The player's bindings; each action's device falls back to the defaults when unreadable. */
export function getBindings(): Bindings {
  const out = copyBindings(DEFAULT_BINDINGS);
  let stored: unknown;
  try {
    stored = JSON.parse(get(BINDINGS_KEY) ?? 'null');
  } catch {
    stored = null;
  }
  if (!stored || typeof stored !== 'object') return out;
  const fresh: ControlAction[] = [];
  for (const action of CONTROL_ACTIONS) {
    const saved = (stored as Record<string, unknown>)[action];
    if (!saved || typeof saved !== 'object') {
      fresh.push(action);
      continue;
    }
    for (const device of CONTROL_DEVICES) {
      const slots = (saved as Record<string, unknown>)[device];
      if (!Array.isArray(slots)) continue;
      const n = BINDING_SLOTS[device];
      const clean = Array.from({ length: n }, (_, i) =>
        validSlot[device](slots[i]) ? slots[i] : null,
      );
      Object.assign(out[action], { [device]: clean });
    }
  }
  // An action added since the bindings were saved (overdrive) gets its defaults, less any
  // the player already gave another action.
  for (const action of fresh)
    for (const device of CONTROL_DEVICES) {
      const slots = out[action][device] as unknown[];
      slots.forEach((v, i) => {
        const taken = CONTROL_ACTIONS.some(
          (a) => a !== action && !fresh.includes(a) && (out[a][device] as unknown[]).includes(v),
        );
        if (v !== null && taken) slots[i] = null;
      });
    }
  return out;
}

export function setBindings(bindings: Bindings): void {
  write(BINDINGS_KEY, JSON.stringify(bindings));
}

/** Put one action (or all, with no action) back to the defaults. */
export function resetBindings(action?: ControlAction): void {
  if (!action) {
    write(BINDINGS_KEY, null);
    return;
  }
  const bindings = getBindings();
  const defaults = copyBindings(DEFAULT_BINDINGS)[action];
  // The defaults win over whatever another action took of them meanwhile.
  for (const device of CONTROL_DEVICES)
    for (const value of defaults[device])
      if (value !== null) unbind(bindings, device, value as never, action);
  bindings[action] = defaults;
  setBindings(bindings);
}

/** Take `value` off every action but `except`; returns the actions it was taken from. */
function unbind<D extends ControlDevice>(
  bindings: Bindings,
  device: D,
  value: ActionBindings[D][number],
  except?: ControlAction,
): ControlAction[] {
  const from: ControlAction[] = [];
  for (const action of CONTROL_ACTIONS) {
    if (action === except) continue;
    const slots = bindings[action][device];
    slots.forEach((v, i) => {
      if (v === value) {
        slots[i] = null;
        if (!from.includes(action)) from.push(action);
      }
    });
  }
  return from;
}

export type BindResult =
  | { ok: true; bindings: Bindings; movedFrom: ControlAction | null }
  | { ok: false; reason: 'pause' };

/**
 * Bind `value` to slot `slot` of `action`'s `device`. An input bound to another action
 * moves here (`movedFrom` says which), one in another slot of this action moves to this
 * slot, and the pause inputs can't be bound. Pure: returns the new bindings.
 */
export function bindInput<D extends ControlDevice>(
  bindings: Bindings,
  action: ControlAction,
  device: D,
  slot: number,
  value: ActionBindings[D][number],
): BindResult {
  if (
    (device === 'keys' && value === PAUSE_KEY) ||
    (device === 'pad' && value === PAUSE_PAD_BUTTON)
  )
    return { ok: false, reason: 'pause' };
  const next = copyBindings(bindings);
  const movedFrom = value === null ? [] : unbind(next, device, value, action);
  const slots = next[action][device];
  if (value !== null) slots.forEach((v, i) => v === value && (slots[i] = null));
  slots[slot] = value;
  return { ok: true, bindings: next, movedFrom: movedFrom[0] ?? null };
}

const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  CapsLock: 'Caps Lock',
  Control: 'Ctrl',
  Meta: 'Meta',
};

/** A bound key as the player reads it: `KeyW` is W, `Digit1` is 1, `ArrowUp` is ↑. */
export function keyLabel(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (digit) return digit[1]!;
  return code.replace(/^Numpad/, 'Num ');
}

const MOUSE_NAMES: Record<MouseButton, string> = {
  left: 'Left click',
  right: 'Right click',
  middle: 'Middle click',
  back: 'Back button',
  forward: 'Forward button',
};

export function mouseLabel(button: MouseButton): string {
  return MOUSE_NAMES[button];
}

/** Standard-mapping gamepad buttons, Xbox names. */
const PAD_NAMES = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'View',
  'Start',
  'L stick',
  'R stick',
  'D-pad ↑',
  'D-pad ↓',
  'D-pad ←',
  'D-pad →',
];

export function padLabel(button: number): string {
  return PAD_NAMES[button] ?? `Button ${button}`;
}

/** A binding as the player reads it. */
export function bindingLabel<D extends ControlDevice>(
  device: D,
  value: NonNullable<ActionBindings[D][number]>,
): string {
  if (device === 'keys') return keyLabel(value as string);
  if (device === 'mouse') return mouseLabel(value as MouseButton);
  return padLabel(value as number);
}

/** The first bound mouse button and key of an action, for a hint: "Right click / Shift". */
export function shortBinding(bindings: ActionBindings): string {
  const parts: string[] = [];
  const mouse = bindings.mouse.find((b) => b !== null);
  const key = bindings.keys.find((b) => b !== null);
  if (mouse) parts.push(mouseLabel(mouse));
  if (key) parts.push(keyLabel(key));
  if (parts.length === 0) {
    const pad = bindings.pad.find((b) => b !== null);
    if (pad !== undefined && pad !== null) parts.push(padLabel(pad));
  }
  return parts.length > 0 ? parts.join(' / ') : 'Unbound';
}

/** True while a running game has lowered its effects on its own to keep frames smooth. */
let effectsLowered = false;

export function getEffectsLowered(): boolean {
  return effectsLowered;
}

/** Set by a running game when it lowers its effects, and cleared when it stops. Not kept. */
export function setEffectsLowered(lowered: boolean): void {
  if (lowered === effectsLowered) return;
  effectsLowered = lowered;
  for (const listener of listeners) listener();
}
