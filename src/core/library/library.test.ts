import { describe, expect, it } from 'vitest';
import { analyseSamples } from '../analysis/analyse';
import { buildLevelMap } from '../level-map';
import { generateLevel as platformerLevel } from '../../games/platformer/level/generate';
import { validateLevel as validatePlatformer } from '../../games/platformer/level/validate';
import { generateLevel as tunnelTrack } from '../../games/tunnel/level/generate';
import { validateLevel as validateTunnel } from '../../games/tunnel/level/validate';
import { composeSong } from './compose';
import { LIBRARY, songSeconds, STYLE_NAMES, type LibraryStyle } from './songs';

describe('the song library', () => {
  it('has twenty songs, four of each style, each with its own name and seed', () => {
    expect(LIBRARY).toHaveLength(20);
    expect(new Set(LIBRARY.map((s) => s.id)).size).toBe(20);
    expect(new Set(LIBRARY.map((s) => s.title)).size).toBe(20);
    expect(new Set(LIBRARY.map((s) => s.seed)).size).toBe(20);
    for (const style of Object.keys(STYLE_NAMES) as LibraryStyle[])
      expect(LIBRARY.filter((s) => s.style === style)).toHaveLength(4);
  });

  it('keeps every song between three and five minutes', () => {
    for (const song of LIBRARY) {
      expect(songSeconds(song), song.title).toBeGreaterThanOrEqual(180);
      expect(songSeconds(song), song.title).toBeLessThanOrEqual(300);
    }
  });
});

describe('composeSong', () => {
  // Half the usual rate: quicker, and the analysis reads the same song.
  const rate = 22050;
  const song = LIBRARY.find((s) => s.id === 'pixel-comet')!;
  const made = composeSong(song, rate);

  it('writes a song as long as its form says, on its own beats', () => {
    expect(made.samples.length / rate).toBeCloseTo(songSeconds(song), 0);
    const bars = song.form.reduce((sum, [, n]) => sum + n, 0);
    expect(made.beats).toHaveLength(bars * 4);
    expect(made.beats[1]! - made.beats[0]!).toBeCloseTo(60 / song.bpm, 6);
    expect(made.parts.map((p) => p.name)).toEqual(song.form.map(([kind]) => kind));
  });

  it('writes the same samples every time, and other ones for another song', () => {
    const again = composeSong(song, rate);
    expect(again.samples.length).toBe(made.samples.length);
    let same = true;
    for (let i = 0; i < made.samples.length && same; i += 97)
      same = made.samples[i] === again.samples[i];
    expect(same).toBe(true);
    const other = composeSong({ ...song, seed: song.seed + 1 }, rate);
    let differs = false;
    for (let i = 0; i < made.samples.length && !differs; i += 97)
      differs = made.samples[i] !== other.samples[i];
    expect(differs).toBe(true);
  });

  it('is a song the games can read: its tempo, its moments, and levels that can be finished', () => {
    const analysis = analyseSamples(made.samples, rate);
    expect(analysis.tempo).toBeCloseTo(song.bpm, 0);
    const map = buildLevelMap(analysis);
    const { fills, accents, sustains } = map.features;
    expect(fills.length).toBeGreaterThan(2);
    expect(accents.length).toBeGreaterThan(5);
    expect(sustains.length).toBeGreaterThan(0);
    const level = platformerLevel(map, 'hard');
    expect(level.obstacles.length / (analysis.duration / 60)).toBeGreaterThan(15);
    expect(validatePlatformer(level).ok).toBe(true);
    const track = tunnelTrack(map, 'hard');
    expect(track.obstacles.length / (analysis.duration / 60)).toBeGreaterThan(40);
    expect(validateTunnel(track).ok).toBe(true);
  }, 120_000);
});
