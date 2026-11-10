import { describe, expect, it } from 'vitest';
import { buildLevelMap } from '../level-map';
import { analyseSamples } from './analyse';
import { electroSong, melodySong, rockSong, wavFile } from './test-songs';

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

// At 48 kHz too, the browser's usual rate: frames of another size hear the snare otherwise.
describe.each([22050, 48000])(
  'the melody song at %i Hz: a lead climbing, holding and falling',
  (rate) => {
    const song = melodySong(rate);
    const analysis = analyseSamples(song.samples, song.rate);
    const map = buildLevelMap(analysis);
    const part = (name: string) => song.parts.find((p) => p.name === name)!;
    /** The grid beats from `from` beats into a part to `to` beats before its end. */
    const beatsOf = (name: string, from = 1, to = 1) => {
      const p = part(name);
      const period = 60 / p.bpm;
      return map.beats
        .map((t, i) => [t, i] as const)
        .filter(([t]) => t >= p.start + from * period - 0.01 && t < p.end - to * period - 0.01)
        .map(([, i]) => i);
    };

    it('hears each note of the lead within half a semitone, and nothing where none plays', () => {
      const { step, values } = analysis.melody;
      let near = 0;
      for (const n of song.notes) {
        // The middle of the note, away from its attack and release.
        const v = values[Math.round((n.time + n.end) / 2 / step)]!;
        if (Math.abs(v - n.midi) <= 0.5) near++;
      }
      expect(near / song.notes.length).toBeGreaterThan(0.9);
      // In the intro and outro the drums and the low bass play, and no melody is heard.
      for (const name of ['Intro', 'Outro']) {
        const p = part(name);
        const from = Math.ceil(p.start / step);
        const to = Math.floor(p.end / step);
        let heard = 0;
        for (let k = from; k < to; k++) if (values[k]! > 0) heard++;
        expect(heard / (to - from)).toBeLessThan(0.1);
      }
    });

    it('puts the melody on the grid: rising up the climb, holding high, falling, holding low', () => {
      const { melody, melodyMove } = map.mood;
      const climb = beatsOf('Climb', 2, 2);
      for (const i of climb) expect(melodyMove[i]).toBe('rising');
      for (let k = 1; k < climb.length; k++)
        expect(melody[climb[k]!]!).toBeGreaterThan(melody[climb[k - 1]!]!);
      for (const i of beatsOf('Fall', 2, 2)) expect(melodyMove[i]).toBe('falling');
      for (const i of beatsOf('High', 3, 2)) {
        expect(melodyMove[i]).toBe('held');
        expect(melody[i]!).toBeGreaterThan(0.85);
      }
      for (const i of beatsOf('Low', 3, 1)) {
        expect(melodyMove[i]).toBe('held');
        expect(melody[i]!).toBeLessThan(0.15);
      }
    });

    it('says where no melody is heard, and keeps the curve level there, not dropping to 0', () => {
      const { melody, melodyMove } = map.mood;
      const intro = beatsOf('Intro', 0, 1);
      for (const i of [...intro, ...beatsOf('Outro', 1, 0)]) expect(melodyMove[i]).toBe('none');
      // Before the first note, the curve holds where the melody starts.
      const first = beatsOf('Climb', 0, 0)[0]!;
      for (const i of intro) expect(melody[i]).toBeCloseTo(melody[first]!, 1);
    });
  },
);

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
