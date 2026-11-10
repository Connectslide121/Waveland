import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEffects, getLatencyMs, getMusicVolume, setLatencyMs } from '../core';
import { latencyFromTaps, MIN_TAPS } from './calibration';
import { formatLatency, openSettings } from './settings';

afterEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

describe('latencyFromTaps', () => {
  const clicks = Array.from({ length: 12 }, (_, i) => 10 + i * 0.6);

  it('takes the median of how late the taps land', () => {
    const taps = clicks.map((c, i) => c + 0.04 + (i % 3) * 0.004);
    const result = latencyFromTaps(taps, clicks);
    expect(result).toMatchObject({ ok: true, latencyMs: 44, taps: 12 });
  });

  it('needs enough taps near a click', () => {
    const taps = clicks.slice(0, MIN_TAPS - 1).map((c) => c + 0.02);
    taps.push(100);
    expect(latencyFromTaps(taps, clicks)).toMatchObject({ ok: false, reason: 'too-few' });
  });

  it('turns down taps that are all over the place', () => {
    const taps = clicks.map((c, i) => c + (i % 2 ? 0.2 : -0.2));
    expect(latencyFromTaps(taps, clicks)).toMatchObject({ ok: false, reason: 'uneven' });
  });
});

describe('openSettings', () => {
  it('changes volume and effects at once, and closes on Escape but not on the backdrop', () => {
    const opener = document.body.appendChild(document.createElement('button'));
    opener.focus();
    const onClose = vi.fn();
    const below = vi.fn();
    window.addEventListener('keydown', below);
    const modal = openSettings({ onClose });

    const volume = modal.element.querySelector<HTMLInputElement>('input[type=range]')!;
    volume.value = '40';
    volume.dispatchEvent(new Event('input'));
    expect(getMusicVolume()).toBe(0.4);
    expect(modal.element.querySelector('output')!.textContent).toBe('40%');

    const reduced = modal.element.querySelector<HTMLInputElement>('input[value=reduced]')!;
    reduced.checked = true;
    reduced.dispatchEvent(new Event('change'));
    expect(getEffects()).toBe('reduced');

    modal.element.click();
    expect(document.body.contains(modal.element)).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(below).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.body.contains(modal.element)).toBe(false);
    expect(document.activeElement).toBe(opener);
    window.removeEventListener('keydown', below);
  });

  it('nudges the latency offset in steps', () => {
    setLatencyMs(20);
    const modal = openSettings();
    const latency = modal.element.querySelector('.settings__latency')!;
    expect(latency.textContent).toBe('+20 ms');
    modal.element.querySelector<HTMLButtonElement>('[aria-label="5 ms earlier"]')!.click();
    expect(getLatencyMs()).toBe(15);
    expect(latency.textContent).toBe('+15 ms');
    modal.close();
  });

  it('writes offsets as the player reads them', () => {
    expect(formatLatency(0)).toBe('0 ms');
    expect(formatLatency(-15)).toBe('−15 ms');
  });
});
