import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getEffects,
  getLatencyMs,
  getMusicVolume,
  hasChosenEffects,
  MAX_LATENCY_MS,
  onSettingsChange,
  setEffects,
  setLatencyMs,
  setMusicVolume,
} from './settings';

function reducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({ matches: reduce && query.includes('reduce') }) as MediaQueryList,
  );
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('settings', () => {
  it('keeps the latency offset in whole ms within the limits', () => {
    expect(getLatencyMs()).toBe(0);
    setLatencyMs(42.4);
    expect(getLatencyMs()).toBe(42);
    setLatencyMs(10_000);
    expect(getLatencyMs()).toBe(MAX_LATENCY_MS);
  });

  it('plays music at full volume until changed, and keeps it between 0 and 1', () => {
    expect(getMusicVolume()).toBe(1);
    setMusicVolume(0.456);
    expect(getMusicVolume()).toBe(0.46);
    setMusicVolume(-1);
    expect(getMusicVolume()).toBe(0);
  });

  it('follows the system for effects until the player picks a level', () => {
    reducedMotion(true);
    expect(getEffects()).toBe('reduced');
    expect(hasChosenEffects()).toBe(false);
    setEffects('full');
    expect(getEffects()).toBe('full');
    expect(hasChosenEffects()).toBe(true);
    setEffects(null);
    expect(getEffects()).toBe('reduced');
    reducedMotion(false);
    expect(getEffects()).toBe('full');
  });

  it('tells listeners about every change until they stop listening', () => {
    const listener = vi.fn();
    const stop = onSettingsChange(listener);
    setMusicVolume(0.5);
    setEffects('reduced');
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    setLatencyMs(10);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
