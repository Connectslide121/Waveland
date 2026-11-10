import { describe, expect, it } from 'vitest';
import { buildLevelMap } from '../level-map';
import { analyseSamples } from './analyse';
import { electroSong, rockSong, wavFile } from './test-songs';

/** Share of `expected` times that have a found time within `tolerance`. */
function recall(found: number[], expected: number[], tolerance: number): number {
  const near = (t: number) => found.some((f) => Math.abs(f - t) <= tolerance);
  return expected.filter(near).length / expected.length;
}

describe('the rock stand-in: 170 BPM with a half-time breakdown, then 150, then 180', () => {
  const song = rockSong();
  const analysis = analyseSamples(song.samples, song.rate);
  const part = (name: string) => song.parts.find((p) => p.name === name)!;

  it('lasts over two minutes', () => {
    expect(analysis.duration).toBeGreaterThan(130);
    expect(analysis.duration).toBeLessThan(180);
  });

  it('keeps the half-time breakdown at 170, and finds both changes on their beat', () => {
    expect(analysis.segments.map((s) => Math.round(s.tempo))).toEqual([170, 150, 180]);
    expect(Math.abs(analysis.segments[1]!.start - part('Bridge').start)).toBeLessThan(0.4);
    expect(Math.abs(analysis.segments[2]!.start - part('Last chorus').start)).toBeLessThan(0.4);
    expect(recall(analysis.beats, song.beats, 0.03)).toBeGreaterThan(0.9);
    const map = buildLevelMap(analysis);
    expect(recall(map.beats, song.beats, 0.015)).toBe(1);
  });

  it('hears crashes as accents, not every downbeat over a bass and guitar on the eighths', () => {
    const inVerses = analysis.features.accents.filter((a) =>
      song.parts.some((p) => p.name === 'Verse' && a.time >= p.start + 1 && a.time < p.end),
    );
    // 24 bars of verse: at most one every four bars (it was every bar).
    expect(inVerses.length).toBeLessThanOrEqual(6);
    // The breakdown's crashes, every other bar.
    const breakdown = part('Half-time breakdown');
    const crashes = analysis.features.accents.filter(
      (a) => a.time >= breakdown.start && a.time < breakdown.end,
    );
    expect(crashes.length).toBeGreaterThanOrEqual(3);
  });

  it('feels the quiet bridge as a breakdown and the choruses as loud', () => {
    const map = buildLevelMap(analysis);
    const feelAt = (t: number) =>
      map.moods[map.sections.findIndex((s) => t >= s.start && t < s.end)]!;
    const bridge = part('Bridge');
    expect(feelAt(bridge.start + 4).feel).toBe('breakdown');
    expect(feelAt(part('Chorus').start + 6).feel).toBe('chorus');
    expect(feelAt(bridge.start + 4).intensity).toBeLessThan(0.3);
  });
});

describe('the electronic track: a steady 128 BPM', () => {
  const song = electroSong();
  const analysis = analyseSamples(song.samples, song.rate);

  it('is one tempo, its grid on every beat and bar, through the drumless breakdown too', () => {
    expect(analysis.segments).toHaveLength(1);
    expect(Math.abs(analysis.tempo - 128)).toBeLessThan(0.1);
    // The tracker follows the breakdown's off-beat hats; the grid keeps to the song's beat.
    const map = buildLevelMap(analysis);
    expect(recall(map.beats, song.beats, 0.015)).toBe(1);
    const bars = song.beats.filter((_, i) => i % 4 === 0);
    expect(recall(map.downbeats, bars, 0.015)).toBe(1);
  });

  it('hears the crash on the first and ninth bar of each drop as accents', () => {
    const crashes = song.parts
      .filter((p) => p.name === 'Drop')
      .flatMap((p) => [p.start, p.start + 8 * 4 * (60 / 128)]);
    expect(
      recall(
        analysis.features.accents.map((a) => a.time),
        crashes,
        0.05,
      ),
    ).toBe(1);
    expect(analysis.features.accents.length).toBeLessThanOrEqual(crashes.length + 1);
  });

  it('finds both drops within a bar of where they land', () => {
    const drops = song.parts.filter((p) => p.name === 'Drop').map((p) => p.start);
    expect(analysis.drops).toHaveLength(2);
    analysis.drops.forEach((d, i) => expect(Math.abs(d.time - drops[i]!)).toBeLessThan(2));
  });
});

describe('wavFile', () => {
  it('writes a 16-bit mono WAV of the samples', async () => {
    const file = wavFile(new Float32Array([0, 1, -1, 0.5]), 22050, 'a.wav');
    const bytes = new DataView(await file.arrayBuffer());
    expect(file.size).toBe(44 + 8);
    expect(bytes.getUint32(24, true)).toBe(22050);
    expect(bytes.getInt16(46, true)).toBe(32767);
    expect(bytes.getInt16(48, true)).toBe(-32767);
  });
});
