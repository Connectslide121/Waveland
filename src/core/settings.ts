/** The player's settings that the core needs, kept in localStorage. */

const LATENCY_KEY = 'waveland.latencyMs';
/** The widest latency offset the settings take, either way. */
export const MAX_LATENCY_MS = 500;

/**
 * How much later than the browser reports the player hears the sound, in ms: positive for
 * Bluetooth headphones or a TV, negative when visuals feel late. 0 until calibrated.
 */
export function getLatencyMs(): number {
  try {
    const value = Number(localStorage.getItem(LATENCY_KEY));
    return Number.isFinite(value) ? clampLatency(value) : 0;
  } catch {
    return 0;
  }
}

export function setLatencyMs(ms: number): void {
  try {
    localStorage.setItem(LATENCY_KEY, String(clampLatency(ms)));
  } catch {
    // No storage (some private windows): the offset can't be kept and stays at 0.
  }
}

function clampLatency(ms: number): number {
  return Math.round(Math.max(-MAX_LATENCY_MS, Math.min(MAX_LATENCY_MS, ms)));
}
