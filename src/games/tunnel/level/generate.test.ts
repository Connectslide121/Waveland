import { describe, expect, it } from 'vitest';
import {
  beatAt,
  beatIndexAt,
  buildLevelMap,
  DIFFICULTIES,
  timeOfBeat,
  type Difficulty,
  type LevelEvent,
  type LevelMap,
  type MusicFeatures,
  periodAt,
} from '../../../core';
import { randomAnalysis } from '../../../core/test-analysis';
import { hits } from '../physics';
import { DIFFICULTY, HOP_LEAD, JUMP_LEAD, DROP_BARS, gapLanes, generateLevel } from './generate';
import { zAtTime, type Obstacle, type TunnelTrack } from './track';
import { validateLevel } from './validate';

/**
 * A steady 120 BPM groove with nothing in it (no hits, moments, drops or repeats), to put
 * musical moments into one at a time.
 */
function quiet(): LevelMap {
  const map = buildLevelMap(
    randomAnalysis(11, {
      duration: 40,
      tempo: 120,
      sections: [{ bars: 40, kind: 'main', energy: 0.7 }],
    }),
  );
  return {
    ...map,
    events: map.events.filter((e) => e.kind === 'section' || e.kind === 'offbeat'),
    drops: [],
    features: {
      sustains: [],
      stops: [],
      accents: [],
      fills: [],
      syncopations: [],
      bars: map.features.bars.map((b, i) => ({ ...b, repeats: i, similarity: 1 })),
    },
  };
}

/** The quiet map with these moments and hits in it. */
function withMoments(
  features: Partial<MusicFeatures>,
  hitsAt: { time: number; kind: 'kick' | 'snare'; intensity?: number }[] = [],
): LevelMap {
  const map = quiet();
  const events: LevelEvent[] = [
    ...map.events,
    ...hitsAt.map((h) => ({
      time: h.time,
      kind: h.kind,
      intensity: h.intensity ?? 0.7,
      beat: beatIndexAt(map, h.time),
    })),
  ].sort((a, b) => a.time - b.time);
  return { ...map, events, features: { ...map.features, ...features } };
}

/** Song time of beat `beat` of bar `bar` (from 0) of a map. */
const at = (map: LevelMap, bar: number, beat = 0) =>
  timeOfBeat(map, map.beats.indexOf(map.downbeats[bar]!) + beat);

const ofKind = (track: TunnelTrack, ...kinds: Obstacle['kind'][]) =>
  track.obstacles.filter((o) => kinds.includes(o.kind));

describe('the grammar', () => {
  it('makes an accent a wall leaving the difficulty’s gap lanes, on its beat', () => {
    const map = withMoments({ accents: [{ time: 0, strength: 0.5 }] });
    map.features.accents[0]!.time = at(map, 4);
    for (const d of DIFFICULTIES) {
      const track = generateLevel(map, d);
      const [wall] = ofKind(track, 'wall');
      expect(wall, d).toBeDefined();
      expect(wall!.time).toBeCloseTo(at(map, 4), 6);
      expect(wall!.lanes).toHaveLength(DIFFICULTY[d].lanes - DIFFICULTY[d].gaps);
      expect(validateLevel(track).ok).toBe(true);
    }
  });

  it('makes the strongest accents low walls across every lane, to jump', () => {
    const map = withMoments({ accents: [{ time: 0, strength: 0.95 }] });
    map.features.accents[0]!.time = at(map, 4);
    const track = generateLevel(map, 'normal');
    const [low] = ofKind(track, 'low');
    expect(low?.low).toBe(true);
    expect(low!.lanes).toEqual([0, 1, 2, 3, 4]);
    expect(validateLevel(track).ok).toBe(true);
  });

  it('opens gaps from the picked lane toward the centre', () => {
    expect(gapLanes(0, 1, 5)).toEqual([0]);
    expect(gapLanes(0, 2, 5)).toEqual([0, 1]);
    expect(gapLanes(0.99, 2, 5)).toEqual([3, 4]);
    expect(gapLanes(0.5, 3, 5)).toEqual([1, 2, 3]);
    expect(gapLanes(0.2, 9, 3)).toEqual([0, 1, 2]);
  });

  it('goes dark and empty over a stop, and lands a wall on the band’s return', () => {
    const map = withMoments({ stops: [{ time: 0, end: 0 }] });
    const stop = map.features.stops[0]!;
    stop.time = at(map, 4, 1);
    stop.end = at(map, 5, 1);
    // Kicks in the stop: no blocks there.
    const kicks = [0, 1, 2, 3].map((k) => ({ time: at(map, 4, 1.5 + k), kind: 'kick' as const }));
    const track = generateLevel(withMoments({ stops: [stop] }, kicks), 'hard');
    expect(track.dark).toEqual([{ time: stop.time, end: stop.end }]);
    const walls = ofKind(track, 'stop');
    expect(walls).toHaveLength(1);
    expect(walls[0]!.time).toBeCloseTo(stop.end, 6);
    expect(track.obstacles.filter((o) => o.time > stop.time && o.time < stop.end)).toEqual([]);
    expect(validateLevel(track).ok).toBe(true);
  });

  it('puts a block where the racer is on every kick and a low wall to jump on every snare', () => {
    const map = quiet();
    // A busy groove at full energy: a block or three a bar, the strongest hits first.
    const groove = [];
    for (let bar = 2; bar < 16; bar++) {
      groove.push(
        { time: at(map, bar, 0), kind: 'kick' as const, intensity: 0.9 },
        { time: at(map, bar, 1), kind: 'snare' as const, intensity: 0.85 },
        { time: at(map, bar, 2), kind: 'kick' as const, intensity: 0.5 },
        { time: at(map, bar, 3), kind: 'snare' as const, intensity: 0.75 },
      );
    }
    const busy = withMoments({}, groove);
    busy.energy = busy.energy.map(() => 1);
    const track = generateLevel(busy, 'hard');
    const kicks = ofKind(track, 'kick');
    const snares = ofKind(track, 'snare');
    expect(kicks.length).toBeGreaterThan(10);
    expect(snares.length).toBeGreaterThan(10);
    // A snare: a low wall across every lane, to jump.
    for (const o of snares) {
      expect(o.low).toBe(true);
      expect(o.lanes).toEqual([0, 1, 2, 3, 4]);
    }
    // A kick: lanes next to each other with a way out beside them, and the racer in one:
    // it starts in the centre, and each block stands where the last one sent it.
    expect(kicks[0]!.lanes).toContain(2);
    kicks.forEach((o, n) => {
      expect(o.lanes.length).toBeLessThan(5);
      expect(o.lanes[o.lanes.length - 1]! - o.lanes[0]!).toBe(o.lanes.length - 1);
      const next = kicks[n + 1];
      // The racer hops to the open lane beside the block; the next block stands there.
      if (next)
        expect(
          next.lanes.includes(o.lanes[0]! - 1) ||
            next.lanes.includes(o.lanes[o.lanes.length - 1]! + 1),
        ).toBe(true);
    });
    // Every kick walls off the racer's whole side: from the tunnel's edge to its lane.
    for (const o of kicks) {
      expect(o.label).toBe('Side wall');
      expect(o.lanes[0] === 0 || o.lanes[o.lanes.length - 1] === 4).toBe(true);
    }
    // Both come just after their beat, as soon as the move is done: the press is on the beat.
    for (const o of kicks) expect(o.z0).toBeCloseTo(zAtTime(track, o.time + HOP_LEAD), 6);
    for (const o of snares) expect(o.z0).toBeCloseTo(zAtTime(track, o.time + JUMP_LEAD), 6);
    expect(validateLevel(track).ok).toBe(true);
  });

  it('turns a fill into a slalom: a block a hit, alternating sides', () => {
    const map = quiet();
    const fill = {
      time: at(map, 5, 0),
      end: at(map, 6),
      hits: [0, 1, 2, 3].map((k) => at(map, 5, k)),
    };
    for (const d of ['normal', 'hard'] as Difficulty[]) {
      const track = generateLevel(withMoments({ fills: [fill] }), d);
      const slalom = ofKind(track, 'slalom');
      expect(slalom.map((o) => o.time)).toEqual(fill.hits);
      const sides = slalom.map((o) => (o.lanes.some((l) => l < 2) ? 'left' : 'right'));
      for (let i = 1; i < sides.length; i++) expect(sides[i]).not.toBe(sides[i - 1]);
      // On hard the hits a beat apart leave time to weave, so the centre is blocked too.
      expect(slalom.every((o) => o.lanes.includes(2))).toBe(d === 'hard');
      expect(validateLevel(track).ok).toBe(true);
    }
  });

  it('slides a block a lane across on a syncopation, on hard only', () => {
    const map = quiet();
    const syncopations = [3, 4, 5, 6, 7, 8, 9, 10, 11].map((bar) => ({
      time: at(map, bar, 1.5),
      strength: 0.8,
    }));
    const hard = generateLevel(withMoments({ syncopations }), 'hard');
    const slides = ofKind(hard, 'slide');
    expect(slides.length).toBeGreaterThan(0);
    for (const o of slides) expect(syncopations.some((s) => s.time === o.time)).toBe(true);
    for (const o of slides) {
      expect(Math.abs(o.slide!.from - o.lanes[0]!)).toBe(1);
      expect(o.slide!.end).toBeCloseTo(o.time, 6);
    }
    expect(ofKind(generateLevel(withMoments({ syncopations }), 'normal'), 'slide')).toEqual([]);
  });

  it('rides a held note on a rail of gems in one lane, and a chord in a ring', () => {
    const map = quiet();
    const sustains = [
      { time: at(map, 4), end: at(map, 5), strength: 0.8, sound: 'note' as const },
      { time: at(map, 8), end: at(map, 9), strength: 0.8, sound: 'chord' as const },
    ];
    const track = generateLevel(withMoments({ sustains }), 'normal');
    const [rail, ring] = track.holds;
    expect(rail).toMatchObject({ kind: 'rail', time: sustains[0]!.time, end: sustains[0]!.end });
    expect(ring).toMatchObject({ kind: 'ring', lane: null, time: sustains[1]!.time });
    const gems = track.pickups.filter((p) => p.kind === 'rail');
    expect(gems).toHaveLength(8);
    expect(gems.every((p) => p.lane === rail!.lane)).toBe(true);
  });
});

const songs = new Map<number, LevelMap>();
/** A random song of 30 to 45 s, cached per seed. */
function song(seed: number): LevelMap {
  let map = songs.get(seed);
  if (!map) {
    map = buildLevelMap(randomAnalysis(seed, { duration: 30 + (seed % 4) * 5 }));
    songs.set(seed, map);
  }
  return map;
}
const tracks = new Map<string, TunnelTrack>();
function track(seed: number, d: Difficulty): TunnelTrack {
  const key = `${seed}:${d}`;
  let found = tracks.get(key);
  if (!found) {
    found = generateLevel(song(seed), d);
    tracks.set(key, found);
  }
  return found;
}

describe('generateLevel on random songs', () => {
  for (let seed = 1; seed <= 9; seed++)
    for (const d of DIFFICULTIES)
      it(`song ${seed} (${d}) can be raced without a crash`, () => {
        const check = validateLevel(track(seed, d));
        expect(check.ok, `stuck at ${check.reached.toFixed(2)} s`).toBe(true);
      });

  it('puts every obstacle on its musical moment', () => {
    const near = (times: number[], t: number) => times.some((u) => Math.abs(u - t) < 1e-6);
    for (let seed = 1; seed <= 9; seed++) {
      const map = song(seed);
      const events = (kind: string) => map.events.filter((e) => e.kind === kind).map((e) => e.time);
      const f = map.features;
      const source: Record<Obstacle['kind'], number[]> = {
        kick: events('kick'),
        snare: events('snare'),
        wall: f.accents.map((a) => a.time),
        low: f.accents.map((a) => a.time),
        stop: f.stops.map((s) => s.end),
        slide: f.syncopations.map((s) => s.time),
        slalom: f.fills.flatMap((x) => x.hits),
        // A build's last bar (the last with three beats before its end): walls on beats 1 to 3.
        squeeze: map.sections
          .filter((x) => x.kind === 'build')
          .flatMap((x) => {
            const bar = [...map.downbeats]
              .reverse()
              .find((d) => beatAt(map, x.end) - beatAt(map, d) >= 3 - 1e-6)!;
            return [1, 2, 3].map((k) => timeOfBeat(map, beatAt(map, bar) + k));
          }),
      };
      for (const d of DIFFICULTIES)
        for (const o of track(seed, d).obstacles)
          expect(near(source[o.kind], o.time), `${o.kind} at ${o.time}`).toBe(true);
    }
  });

  it('sets the lanes by difficulty and gets busier from easy to hard', () => {
    const count = (d: Difficulty) => {
      let n = 0;
      for (let seed = 1; seed <= 9; seed++) n += track(seed, d).obstacles.length;
      return n;
    };
    expect(track(1, 'easy').lanes).toBe(3);
    expect(track(1, 'normal').lanes).toBe(5);
    expect(track(1, 'hard').lanes).toBe(5);
    expect(count('easy')).toBeLessThan(count('normal'));
    expect(count('normal')).toBeLessThan(count('hard'));
    for (let seed = 1; seed <= 9; seed++)
      for (const d of DIFFICULTIES) {
        const t = track(seed, d);
        for (const o of t.obstacles) {
          expect(o.lanes.length).toBeGreaterThan(0);
          for (const l of o.lanes) expect(l >= 0 && l < t.lanes).toBe(true);
          // Only low walls close every lane.
          if (!o.low) expect(o.lanes.length).toBeLessThan(t.lanes);
        }
      }
  });

  it('is the same track every time for the same song and difficulty', () => {
    expect(JSON.stringify(generateLevel(song(4), 'hard'))).toBe(JSON.stringify(track(4, 'hard')));
    expect(track(4, 'hard').seed).not.toBe(track(4, 'normal').seed);
  });

  it('covers the song with stretches, in order', () => {
    for (let seed = 1; seed <= 9; seed++) {
      const { chunks, duration, obstacles } = track(seed, 'normal');
      expect(chunks[0]!.start).toBe(0);
      expect(chunks[chunks.length - 1]!.end).toBe(duration);
      for (let i = 1; i < chunks.length; i++)
        expect(chunks[i]!.start).toBeCloseTo(chunks[i - 1]!.end, 6);
      for (let i = 1; i < obstacles.length; i++)
        expect(obstacles[i]!.z0).toBeGreaterThanOrEqual(obstacles[i - 1]!.z0);
    }
  });

  it('opens every lane for a drop’s set piece, with a wave of gems on its beats', () => {
    const map = buildLevelMap(
      randomAnalysis(21, {
        tempo: 128,
        sections: [
          { bars: 4, kind: 'intro', energy: 0.3 },
          { bars: 4, kind: 'build', energy: 0.6 },
          { bars: 8, kind: 'drop', energy: 1 },
          { bars: 4, kind: 'outro', energy: 0.3 },
        ],
      }),
    );
    const drops = map.events.filter((x) => x.kind === 'drop');
    expect(drops.length).toBeGreaterThan(0);
    for (const d of DIFFICULTIES) {
      const t = generateLevel(map, d);
      for (const e of drops) {
        // Its own bar when it is within a beat of the bar line, else the next.
        const bar = map.downbeats.findIndex((b) => b >= e.time - periodAt(map, e.time) - 1e-6);
        const [start, end] = [map.downbeats[bar]!, map.downbeats[bar + DROP_BARS]!];
        expect(t.obstacles.filter((o) => o.time >= start && o.time < end)).toEqual([]);
        expect(t.pickups.filter((p) => Math.abs(p.time - start) < 1e-6)).toHaveLength(t.lanes);
      }
    }
  });

  it('keeps gems clear of obstacles in their lane, and out of the dark', () => {
    for (let seed = 1; seed <= 9; seed++)
      for (const d of DIFFICULTIES) {
        const t = track(seed, d);
        for (const p of t.pickups) {
          for (const o of t.obstacles)
            if (Math.abs(o.time - p.time) <= 0.15)
              expect(hits(o, p.lane, 0, o.time), `gem at ${p.time}`).toBe(false);
          if (p.kind === 'gem')
            expect(t.dark.some((x) => p.time >= x.time && p.time < x.end)).toBe(false);
        }
      }
  });
});
