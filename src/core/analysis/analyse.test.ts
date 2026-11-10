import { describe, expect, it } from 'vitest';
import type { Onset } from '../types';
import { analyseSamples, toMono } from './analyse';
import { clickTrack, drumKit, drumPattern, place, TEST_RATE } from './test-audio';

/** Distance from `t` to the nearest of `times`. */
function nearest(times: number[], t: number): number {
  let best = Infinity;
  for (const x of times) best = Math.min(best, Math.abs(x - t));
  return best;
}

/** Share of `expected` times that have a found time within `tolerance`. */
function recall(found: number[], expected: number[], tolerance: number): number {
  if (expected.length === 0) return 1;
  return expected.filter((t) => nearest(found, t) <= tolerance).length / expected.length;
}

const times = (onsets: Onset[]) => onsets.map((o) => o.time);

/** Beat-time tolerance: about two analysis frames. */
const BEAT_TOLERANCE = 0.025;

describe('analyseSamples: tempo and beats', () => {
  for (const bpm of [90, 120, 128, 140, 150]) {
    it(`finds ${bpm} BPM within 1 BPM from a click track, with beats on the clicks`, () => {
      const { samples, beats } = clickTrack(bpm, 30);
      const analysis = analyseSamples(samples, TEST_RATE);

      expect(Math.abs(analysis.tempo - bpm)).toBeLessThanOrEqual(1);
      // Every found beat sits on a click, and nearly every click got a beat.
      for (const t of analysis.beats) expect(nearest(beats, t)).toBeLessThanOrEqual(BEAT_TOLERANCE);
      expect(recall(analysis.beats, beats, BEAT_TOLERANCE)).toBeGreaterThanOrEqual(0.95);
    });
  }

  it('tracks a drum groove and puts the downbeats on bar starts', () => {
    const groove = drumPattern({ bpm: 124, seconds: 40 });
    const analysis = analyseSamples(groove.samples, TEST_RATE);

    expect(Math.abs(analysis.tempo - 124)).toBeLessThanOrEqual(1);
    expect(recall(analysis.beats, groove.beats, BEAT_TOLERANCE)).toBeGreaterThanOrEqual(0.95);
    expect(analysis.downbeats.length).toBeGreaterThan(10);
    for (const t of analysis.downbeats)
      expect(nearest(groove.downbeats, t)).toBeLessThanOrEqual(BEAT_TOLERANCE);
  });
});

describe('analyseSamples: bands', () => {
  const groove = drumPattern({ bpm: 120, seconds: 30 });
  const analysis = analyseSamples(groove.samples, TEST_RATE);
  const kickOnly = groove.kicks.filter((t) => !groove.snares.includes(t));
  const tolerance = 0.03;

  it('hears the kicks in the low band, and nothing on the hats there', () => {
    const low = times(analysis.onsets.low);
    expect(recall(low, groove.kicks, tolerance)).toBeGreaterThanOrEqual(0.95);
    expect(recall(low, groove.hats, tolerance)).toBe(0);
  });

  it('hears the snares in the mid band, and not the kicks alone', () => {
    const mid = times(analysis.onsets.mid);
    expect(recall(mid, groove.snares, tolerance)).toBeGreaterThanOrEqual(0.95);
    expect(recall(mid, kickOnly, tolerance)).toBeLessThanOrEqual(0.05);
  });

  it('hears the hats in the high band, and the kicks and snares at most faintly', () => {
    const high = analysis.onsets.high;
    expect(recall(times(high), groove.hats, tolerance)).toBeGreaterThanOrEqual(0.95);
    expect(recall(times(high), kickOnly, tolerance)).toBeLessThanOrEqual(0.05);
    // The snare's noise reaches into the hat band a little, as real snares do: faint hits only.
    const onSnares = high.filter((o) => nearest(groove.snares, o.time) <= tolerance);
    for (const o of onSnares) expect(o.strength).toBeLessThan(0.3);
  });

  it('gives onsets a strength from 0 to 1, stronger for the accented kicks', () => {
    const low = analysis.onsets.low;
    for (const o of low) {
      expect(o.strength).toBeGreaterThanOrEqual(0);
      expect(o.strength).toBeLessThanOrEqual(1);
    }
    const strengthAt = (t: number) =>
      low.reduce((a, b) => (Math.abs(b.time - t) < Math.abs(a.time - t) ? b : a)).strength;
    const accented = groove.downbeats.map(strengthAt);
    const plain = groove.kicks.filter((t) => !groove.downbeats.includes(t)).map(strengthAt);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(accented)).toBeGreaterThan(avg(plain));
  });

  it('samples energy per band at a fixed rate over the whole song', () => {
    const { energy, bands, duration } = analysis;
    expect(energy.step).toBeCloseTo(0.02);
    for (const curve of [energy, bands.low, bands.mid, bands.high]) {
      expect(curve.step).toBe(energy.step);
      expect(curve.values.length).toBe(Math.ceil(duration / curve.step));
      expect(Math.max(...curve.values)).toBeLessThanOrEqual(1);
      expect(Math.min(...curve.values)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('analyseSamples: sections and drops', () => {
  it('finds the drop where a quiet half turns loud, on the bar line', () => {
    const bpm = 120;
    const dropAt = 0.5 + 64 * (60 / bpm); // bar 17
    const groove = drumPattern({ bpm, seconds: 64, gain: (t) => (t < dropAt - 0.01 ? 0.1 : 1) });
    const analysis = analyseSamples(groove.samples, TEST_RATE);

    expect(analysis.drops).toHaveLength(1);
    expect(Math.abs(analysis.drops[0]!.time - dropAt)).toBeLessThanOrEqual(0.05);
    expect(analysis.drops[0]!.strength).toBeGreaterThan(0.5);

    const into = analysis.sections.find((s) => Math.abs(s.start - dropAt) <= 0.05);
    expect(into?.kind).toBe('drop');
    const before = analysis.sections[analysis.sections.indexOf(into!) - 1];
    expect(before?.energy).toBeLessThan(into!.energy);
  });

  it('names a quiet middle a breakdown and finds the drop after it', () => {
    const bpm = 128;
    const bar = (4 * 60) / bpm;
    const start = 0.5;
    const breakdown = start + 12 * bar;
    const dropAt = start + 20 * bar;
    const groove = drumPattern({
      bpm,
      seconds: start + 32 * bar,
      start,
      gain: (t) => (t >= breakdown - 0.01 && t < dropAt - 0.01 ? 0.08 : 1),
    });
    const analysis = analyseSamples(groove.samples, TEST_RATE);

    expect(analysis.drops.map((d) => d.time)).toHaveLength(1);
    expect(Math.abs(analysis.drops[0]!.time - dropAt)).toBeLessThanOrEqual(0.05);
    const quiet = analysis.sections.find((s) => Math.abs(s.start - breakdown) <= 0.05);
    expect(quiet?.kind).toBe('breakdown');
  });

  it('puts a drop after a snare roll where the kick comes in, not where the roll starts', () => {
    const bpm = 128;
    const bar = (4 * 60) / bpm;
    const start = 0.5;
    const roll = start + 15 * bar;
    const dropAt = start + 16 * bar;
    const groove = drumPattern({
      bpm,
      seconds: start + 28 * bar,
      start,
      gain: (t) => (t < dropAt - 0.01 ? 0.1 : 1),
    });
    // A loud sixteenth-note snare roll through the build's last bar.
    const { snare } = drumKit();
    for (let i = 0; i < 16; i++) place(groove.samples, snare, roll + (i * bar) / 16, 0.8);
    const analysis = analyseSamples(groove.samples, TEST_RATE);

    expect(analysis.drops).toHaveLength(1);
    expect(Math.abs(analysis.drops[0]!.time - dropAt)).toBeLessThanOrEqual(0.05);
  });

  it('finds no drop in a steady groove', () => {
    const groove = drumPattern({ bpm: 128, seconds: 40 });
    const analysis = analyseSamples(groove.samples, TEST_RATE);
    expect(analysis.drops).toHaveLength(0);
    expect(analysis.sections.length).toBeGreaterThanOrEqual(1);
    expect(analysis.sections[0]!.start).toBe(0);
    expect(analysis.sections.at(-1)!.end).toBeCloseTo(analysis.duration);
  });

  it('reports progress from 0 up to 1', () => {
    const { samples } = clickTrack(120, 5);
    const progress: number[] = [];
    analyseSamples(samples, TEST_RATE, (p) => progress.push(p));
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1]!)).toBe(true);
  });
});

describe('toMono', () => {
  it('averages the channels', () => {
    const mono = toMono([Float32Array.of(1, 0), Float32Array.of(0, 1)]);
    expect([...mono]).toEqual([0.5, 0.5]);
  });
});
