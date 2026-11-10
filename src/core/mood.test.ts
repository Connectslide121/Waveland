import { describe, expect, it } from 'vitest';
import { analyseSamples } from './analysis/analyse';
import { beatGrid, drumKit, place, track, TEST_RATE } from './analysis/test-audio';
import { buildLevelMap } from './level-map';
import { curveAt, melodyCurves, sectionMoods, smoothBeats } from './mood';
import { randomAnalysis } from './test-analysis';
import type { MoodCurves, Section } from './types';

/**
 * A quiet intro (soft kicks on every other beat, nothing else) for 16 s, then a loud,
 * busy chorus (kick every beat, snare on 2 and 4, hats on every sixteenth) to 32 s.
 */
function introThenChorus() {
  const kit = drumKit();
  const out = track(32);
  const beats = beatGrid(120, 0.5, 31.7);
  const change = 16.5;
  beats.forEach((t, i) => {
    if (t < change) {
      if (i % 2 === 0) place(out, kit.kick, t, 0.12);
      return;
    }
    place(out, kit.kick, t, i % 4 === 0 ? 0.9 : 0.7);
    if (i % 2 === 1) place(out, kit.snare, t, 0.6);
    for (let k = 0; k < 4; k++) place(out, kit.hat, t + k * 0.125, 0.35);
  });
  return { samples: out, change };
}

describe('the mood curves', () => {
  const song = introThenChorus();
  const map = buildLevelMap(analyseSamples(song.samples, TEST_RATE));
  const beatOf = (t: number) => map.beats.findIndex((b) => b >= t);
  const mean = (curve: number[], from: number, to: number) =>
    curve.slice(beatOf(from), beatOf(to)).reduce((a, b) => a + b, 0) / (beatOf(to) - beatOf(from));

  it('has one value per grid beat in every curve, each 0 to 1', () => {
    const { melodyMove, ...curves } = map.mood;
    expect(melodyMove).toHaveLength(map.beats.length);
    for (const curve of Object.values(curves)) {
      expect(curve).toHaveLength(map.beats.length);
      for (const v of curve) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rises in intensity from a quiet intro into a loud chorus', () => {
    const intro = mean(map.mood.intensity, 3, 14);
    const chorus = mean(map.mood.intensity, 19, 30);
    expect(chorus).toBeGreaterThan(intro + 0.5);
    // Smoothed: it climbs over the change rather than jumping in one beat.
    const at = beatOf(song.change);
    const step = map.mood.intensity[at + 1]! - map.mood.intensity[at - 1]!;
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(chorus - intro);
  });

  it('reads the chorus as busier and brighter, and the kicks-only intro as heavier', () => {
    expect(mean(map.mood.density, 19, 30)).toBeGreaterThan(mean(map.mood.density, 3, 14) + 0.4);
    expect(mean(map.mood.brightness, 19, 30)).toBeGreaterThan(
      mean(map.mood.brightness, 3, 14) + 0.3,
    );
    expect(mean(map.mood.heaviness, 3, 14)).toBeGreaterThan(mean(map.mood.heaviness, 19, 30) + 0.3);
  });

  it('feels the intro as calm (or the lead-in to a drop) and the chorus as loud', () => {
    expect(map.moods).toHaveLength(map.sections.length);
    expect(['calm', 'build', 'breakdown']).toContain(map.moods[0]!.feel);
    expect(['chorus', 'drop']).toContain(map.moods.at(-1)!.feel);
    expect(map.moods.at(-1)!.intensity).toBeGreaterThan(map.moods[0]!.intensity);
  });

  it('is the same every time for the same analysis', () => {
    const analysis = randomAnalysis(11, { duration: 60 });
    const a = buildLevelMap(analysis);
    const b = buildLevelMap(analysis);
    expect(a.mood).toEqual(b.mood);
    expect(a.moods).toEqual(b.moods);
  });
});

describe('sectionMoods', () => {
  /** Four sections of 16 beats each, at the given intensity per beat. */
  const beats = Array.from({ length: 64 }, (_, i) => i * 0.5);
  const sections = (kinds: Section['kind'][]): Section[] =>
    kinds.map((kind, i) => ({ start: i * 8, end: (i + 1) * 8, kind, energy: 0.5 }));
  const curves = (intensity: (i: number) => number): MoodCurves => ({
    intensity: beats.map((_, i) => intensity(i)),
    brightness: beats.map(() => 0.5),
    density: beats.map(() => 0.5),
    heaviness: beats.map(() => 0.5),
    melody: beats.map(() => 0.5),
    melodyMove: beats.map(() => 'none'),
  });

  it('feels quiet parts calm, middling ones a groove and the loudest a chorus', () => {
    const levels = [0.2, 0.5, 0.85, 0.45];
    const moods = sectionMoods(
      sections(['intro', 'main', 'main', 'main']),
      beats,
      curves((i) => levels[Math.floor(i / 16)]!),
    );
    expect(moods.map((m) => m.feel)).toEqual(['calm', 'groove', 'chorus', 'groove']);
    expect(moods[2]!.intensity).toBeCloseTo(0.85, 6);
  });

  it('keeps the structure’s builds, drops and breakdowns', () => {
    const moods = sectionMoods(
      sections(['main', 'build', 'drop', 'breakdown']),
      beats,
      curves(() => 0.5),
    );
    expect(moods.map((m) => m.feel)).toEqual(['groove', 'build', 'drop', 'breakdown']);
  });

  it('calls a main section rising bar by bar into a louder one a build', () => {
    // 0.35 → 0.75 across the second section, then a loud third.
    const moods = sectionMoods(
      sections(['main', 'main', 'main', 'outro']),
      beats,
      curves((i) => (i < 16 ? 0.45 : i < 32 ? 0.35 + ((i - 16) / 15) * 0.4 : i < 48 ? 0.9 : 0.2)),
    );
    expect(moods.map((m) => m.feel)).toEqual(['groove', 'build', 'chorus', 'calm']);
  });
});

describe('smoothBeats and curveAt', () => {
  it('smooths a step over two beats either side, keeping flat stretches flat', () => {
    const smooth = smoothBeats([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
    expect(smooth[0]).toBe(0);
    expect(smooth[9]).toBe(1);
    for (let i = 1; i < smooth.length; i++)
      expect(smooth[i]!).toBeGreaterThanOrEqual(smooth[i - 1]!);
    expect(smooth[4]!).toBeGreaterThan(0);
    expect(smooth[5]!).toBeLessThan(1);
  });

  it('reads a curve between its beats', () => {
    expect(curveAt([0, 1, 0], 0.5)).toBeCloseTo(0.5);
    expect(curveAt([0, 1, 0], 5)).toBe(0);
    expect(curveAt([], 1)).toBe(0);
  });
});

describe('melodyCurves', () => {
  /** 24 beats of half a second, the melody at `pitch(t)` (0 for none) sampled at 50/s. */
  const beats = Array.from({ length: 24 }, (_, i) => i * 0.5);
  const melodyOf = (pitch: (t: number) => number) => ({
    step: 0.02,
    values: Float32Array.from({ length: 600 }, (_, k) => pitch(k * 0.02)),
  });
  const span = () => 0.5;

  it('fills beats with no melody between the heard ones, and says none was heard', () => {
    // A5 for 4 s, nothing for 2 s, A4 for the rest.
    const curves = melodyCurves(
      melodyOf((t) => (t < 4 ? 81 : t < 6 ? 0 : 69)),
      beats,
      span,
    );
    expect(curves.melodyMove.slice(8, 12)).toEqual(['none', 'none', 'none', 'none']);
    // Down from the top to the bottom across the gap, without jumping to 0 and back.
    for (let i = 7; i < 13; i++)
      expect(curves.melody[i + 1]!).toBeLessThanOrEqual(curves.melody[i]! + 1e-9);
    expect(curves.melody[2]!).toBeGreaterThan(0.95);
    expect(curves.melody[20]!).toBeLessThan(0.05);
    expect(curves.melodyMove[2]).toBe('held');
  });

  it('is level at 0.5 with no movement when the song has no melody', () => {
    for (const melody of [melodyOf(() => 0), undefined]) {
      const curves = melodyCurves(melody, beats, span);
      expect(new Set(curves.melody)).toEqual(new Set([0.5]));
      expect(new Set(curves.melodyMove)).toEqual(new Set(['none']));
    }
  });

  it('counts a beat as heard only when enough of it has a melody', () => {
    // A blip of 60 ms on every beat: a snare's crack read as a pitch, not a melody.
    const curves = melodyCurves(
      melodyOf((t) => (t % 0.5 < 0.06 ? 90 : 0)),
      beats,
      span,
    );
    expect(new Set(curves.melodyMove)).toEqual(new Set(['none']));
  });
});
