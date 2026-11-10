/** The player's settings, kept in localStorage: music volume, effects and audio latency. */

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
