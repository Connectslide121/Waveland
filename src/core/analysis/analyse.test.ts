import { describe, expect, it } from 'vitest';
import type { Onset } from '../types';
import { analyseSamples, toMono } from './analyse';
import {
  clickTrack,
  drumKit,
  drumPattern,
  momentsSong,
  place,
  tempoChangeSong,
  TEST_RATE,
} from './test-audio';

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
      expect(analysis.segments).toHaveLength(1);
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

describe('analyseSamples: tempo map', () => {
  /** Beat-time tolerance across a tempo change. */
  const TOLERANCE = 0.03;

  it('keeps a steady song to one segment over the whole song', () => {
    const groove = drumPattern({ bpm: 128, seconds: 60 });
    const analysis = analyseSamples(groove.samples, TEST_RATE);
    expect(analysis.segments).toHaveLength(1);
    expect(analysis.segments[0]).toMatchObject({ start: 0, end: analysis.duration });
    expect(analysis.segments[0]!.tempo).toBe(analysis.tempo);
  });

  it('finds a change from 120 to 150 BPM within a beat, with beats on both sides', () => {
    const song = tempoChangeSong([
      { bpm: 120, bars: 16 },
      { bpm: 150, bars: 20 },
    ]);
    const analysis = analyseSamples(song.samples, TEST_RATE);

    expect(analysis.segments).toHaveLength(2);
    const [slow, fast] = analysis.segments;
    expect(Math.abs(slow!.tempo - 120)).toBeLessThanOrEqual(1);
    expect(Math.abs(fast!.tempo - 150)).toBeLessThanOrEqual(1);
    expect(Math.abs(fast!.start - song.changes[0]!)).toBeLessThanOrEqual(0.5);
    expect(slow!.end).toBe(fast!.start);
    for (const t of analysis.beats) expect(nearest(song.beats, t)).toBeLessThanOrEqual(TOLERANCE);
    expect(recall(analysis.beats, song.beats, TOLERANCE)).toBeGreaterThanOrEqual(0.95);
    // No beat skipped or doubled across the change.
    const across = analysis.beats.filter((t) => Math.abs(t - song.changes[0]!) < 3);
    for (let i = 1; i < across.length; i++) {
      const gap = across[i]! - across[i - 1]!;
      expect(gap).toBeGreaterThan(0.4 - TOLERANCE);
      expect(gap).toBeLessThan(0.5 + TOLERANCE);
    }
  });

  it('finds a slowdown and a speed-up again', () => {
    const song = tempoChangeSong([
      { bpm: 140, bars: 12 },
      { bpm: 100, bars: 10 },
      { bpm: 140, bars: 12 },
    ]);
    const analysis = analyseSamples(song.samples, TEST_RATE);

    expect(analysis.segments.map((s) => Math.round(s.tempo))).toEqual([140, 100, 140]);
    analysis.segments.slice(1).forEach((s, i) => {
      expect(Math.abs(s.start - song.changes[i]!)).toBeLessThanOrEqual(60 / 100);
    });
    for (const t of analysis.beats) expect(nearest(song.beats, t)).toBeLessThanOrEqual(TOLERANCE);
    expect(recall(analysis.beats, song.beats, TOLERANCE)).toBeGreaterThanOrEqual(0.95);
  });

  it('reads a pulse that really halves as half the tempo, and back', () => {
    const song = tempoChangeSong([
      { bpm: 140, bars: 12, feel: 'clicks' },
      { bpm: 70, bars: 6, feel: 'clicks' },
      { bpm: 140, bars: 12, feel: 'clicks' },
    ]);
    const analysis = analyseSamples(song.samples, TEST_RATE);

    expect(analysis.segments.map((s) => Math.round(s.tempo))).toEqual([140, 70, 140]);
    analysis.segments.slice(1).forEach((s, i) => {
      expect(Math.abs(s.start - song.changes[i]!)).toBeLessThanOrEqual(60 / 70);
    });
    for (const t of analysis.beats) expect(nearest(song.beats, t)).toBeLessThanOrEqual(TOLERANCE);
    expect(recall(analysis.beats, song.beats, TOLERANCE)).toBeGreaterThanOrEqual(0.95);
  });

  it('follows a rock song through several changes, a half-time feel among them', () => {
    // A groove at 150 then a half-time feel at 150 must not pull the groove an octave down.
    const song = tempoChangeSong([
      { bpm: 120, bars: 12 },
      { bpm: 150, bars: 16 },
      { bpm: 150, bars: 8, feel: 'half' },
      { bpm: 100, bars: 8 },
      { bpm: 150, bars: 12 },
    ]);
    const analysis = analyseSamples(song.samples, TEST_RATE);

    expect(analysis.segments.map((s) => Math.round(s.tempo))).toEqual([120, 150, 100, 150]);
    const changes = [song.changes[0]!, song.changes[2]!, song.changes[3]!];
    analysis.segments.slice(1).forEach((s, i) => {
      expect(Math.abs(s.start - changes[i]!)).toBeLessThanOrEqual(0.4);
    });
    for (const t of analysis.beats) expect(nearest(song.beats, t)).toBeLessThanOrEqual(TOLERANCE);
    expect(recall(analysis.beats, song.beats, TOLERANCE)).toBeGreaterThanOrEqual(0.95);
  });

  it("reads the same at the browser's usual 48 kHz as at 22.05 kHz", () => {
    const rate = 48000;
    const song = tempoChangeSong(
      [
        { bpm: 120, bars: 12 },
        { bpm: 150, bars: 16 },
      ],
      0.5,
      rate,
    );
    const analysis = analyseSamples(song.samples, rate);

    expect(analysis.segments.map((s) => Math.round(s.tempo))).toEqual([120, 150]);
    expect(Math.abs(analysis.segments[1]!.start - song.changes[0]!)).toBeLessThanOrEqual(0.4);
    for (const t of analysis.beats) expect(nearest(song.beats, t)).toBeLessThanOrEqual(TOLERANCE);
    expect(recall(analysis.beats, song.beats, TOLERANCE)).toBeGreaterThanOrEqual(0.95);
  });

  it('keeps a half-time feel at the same tempo as one segment', () => {
    const song = tempoChangeSong([
      { bpm: 150, bars: 12 },
      { bpm: 150, bars: 8, feel: 'half' },
      { bpm: 150, bars: 12 },
    ]);
    const analysis = analyseSamples(song.samples, TEST_RATE);

    expect(analysis.segments).toHaveLength(1);
    expect(Math.abs(analysis.tempo - 150)).toBeLessThanOrEqual(1);
    expect(recall(analysis.beats, song.beats, TOLERANCE)).toBeGreaterThanOrEqual(0.95);
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

describe('analyseSamples: musical moments', () => {
  const song = momentsSong();
  const analysis = analyseSamples(song.samples, TEST_RATE);
  const { features } = analysis;
  /** Half an eighth at 120 BPM. */
  const NEAR = 0.13;

  it('finds the held chord, from its hit until it is let go', () => {
    expect(features.sustains).toHaveLength(1);
    const held = features.sustains[0]!;
    expect(Math.abs(held.time - song.held.time)).toBeLessThan(0.03);
    expect(Math.abs(held.end - song.held.end)).toBeLessThan(0.06);
    expect(held.sound).toBe('chord');
  });

  it('finds the stop, from as the downbeat dies away until the band comes back', () => {
    expect(features.stops).toHaveLength(1);
    const stop = features.stops[0]!;
    expect(stop.time).toBeGreaterThan(song.stop.time);
    expect(stop.time - song.stop.time).toBeLessThan(song.period);
    expect(Math.abs(stop.end - song.stop.end)).toBeLessThan(0.03);
  });

  it('finds the crash accents and nothing else as accents', () => {
    expect(features.accents.map((a) => a.time)).toHaveLength(song.accents.length);
    for (const t of song.accents) expect(nearest(times(features.accents), t)).toBeLessThan(NEAR);
  });

  it('finds the snare fill into the riff, hit by hit', () => {
    expect(features.fills).toHaveLength(1);
    const fill = features.fills[0]!;
    expect(Math.abs(fill.end - song.fill.end)).toBeLessThan(0.03);
    expect(fill.hits).toHaveLength(song.fill.hits.length);
    fill.hits.forEach((t, i) => expect(Math.abs(t - song.fill.hits[i]!)).toBeLessThan(0.03));
  });

  it('finds the off-beat kick and snare of the riff as syncopations, and nothing in the groove', () => {
    for (const s of features.syncopations) {
      const inRiff = [...song.riff.first, ...song.riff.again].some(
        (b) => s.time >= b && s.time < b + 4 * song.period,
      );
      expect(inRiff).toBe(true);
    }
    expect(features.syncopations).toHaveLength(4);
  });

  it('knows the riff repeats, bar for bar, and that its bars differ from each other', () => {
    const barAt = (t: number) => features.bars.findIndex((b) => Math.abs(b.start - t) < 0.05);
    const first = song.riff.first.map(barAt);
    const again = song.riff.again.map(barAt);
    expect(first.every((i) => i >= 0)).toBe(true);
    first.forEach((i, k) => {
      expect(features.bars[i]!.repeats).toBe(i);
      expect(features.bars[again[k]!]!.repeats).toBe(i);
    });
    // The groove's bars repeat the first one; the moments' bars repeat nothing.
    expect(features.bars[1]!.repeats).toBe(0);
    expect(features.bars[barAt(song.held.time)]!.repeats).toBe(barAt(song.held.time));
  });
});
