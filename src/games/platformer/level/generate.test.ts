import { afterEach, describe, expect, it } from 'vitest';
import {
  beatAt,
  buildLevelMap,
  DIFFICULTIES,
  periodAt,
  type Difficulty,
  type LevelEvent,
  type LevelMap,
} from '../../../core';
import { analyseSamples } from '../../../core/analysis/analyse';
import { momentsSong, TEST_RATE } from '../../../core/analysis/test-audio';
import { randomAnalysis } from '../../../core/test-analysis';
import {
  JUMP_AIR,
  PHYSICS_DT,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  scrollSpeed,
  startState,
  stepPlayer,
  type PlayerState,
} from '../physics';
import {
  bridgeTimes,
  dashPitAir,
  DASH_REACH,
  DIFFICULTY,
  generateLevel,
  JUMP_REACH,
  MAX_TOP,
  MIN_TOP,
  pressesOf,
} from './generate';
import {
  BOOSTER_KINDS,
  GATE_GRACE,
  LevelWorld,
  solidTop,
  speedAt,
  timeAtX,
  xAtTime,
  type Pickup,
  type Obstacle,
  type PlatformerLevel,
  type Solid,
} from './level';
import { Explorer, stepAt, validateLevel } from './validate';

let moments: LevelMap | null = null;
/** The synthetic song with a held chord, a stop, accents, a fill and a repeated riff. */
function momentsMap(): LevelMap {
  moments ??= buildLevelMap(analyseSamples(momentsSong().samples, TEST_RATE));
  return moments;
}

const maps = new Map<number, LevelMap>();
/** A random song of 30 to 45 s (short, to keep the search quick), cached per seed. */
function song(seed: number): LevelMap {
  let map = maps.get(seed);
  if (!map) {
    map = buildLevelMap(randomAnalysis(seed, { duration: 30 + (seed % 4) * 5 }));
    maps.set(seed, map);
  }
  return map;
}

const levels = new Map<string, PlatformerLevel>();
function level(seed: number, difficulty: Difficulty): PlatformerLevel {
  const key = `${seed}:${difficulty}`;
  let found = levels.get(key);
  if (!found) {
    found = generateLevel(song(seed), difficulty);
    levels.set(key, found);
  }
  return found;
}

/** Seconds in the air the gaps on a level's kicks take to cross, measured from the pits. */
function kickAirs(l: PlatformerLevel): number[] {
  return l.obstacles
    .filter((o) => o.kind === 'kick' && o.air !== undefined)
    .map((o) => (o.x1 - o.x0 - PLAYER_WIDTH) / speedAt(l, o.time));
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

describe('generateLevel: always completable', () => {
  // Random songs at every tempo and shape; each difficulty in turn.
  for (let seed = 1; seed <= 12; seed++) {
    const difficulty = DIFFICULTIES[seed % 3]!;
    it(`song ${seed} (${difficulty}) can be finished`, () => {
      const l = level(seed, difficulty);
      const check = validateLevel(l);
      expect(check.ok, `stuck at ${check.reached.toFixed(2)} s`).toBe(true);
    });
  }

  it('keeps the layout in order and in bounds', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const l = level(seed, DIFFICULTIES[seed % 3]!);
      for (let i = 1; i < l.solids.length; i++)
        expect(l.solids[i]!.x0).toBeGreaterThanOrEqual(l.solids[i - 1]!.x0);
      for (const s of l.solids) {
        expect(s.x1).toBeGreaterThan(s.x0);
        if (s.kind !== 'eq' && s.kind !== 'overhang') {
          expect(s.top).toBeGreaterThanOrEqual(MIN_TOP);
          expect(s.top).toBeLessThanOrEqual(MAX_TOP);
        }
      }
      // The stretches follow each other in time and space, and cover the whole song.
      expect(l.chunks[0]!.start).toBe(0);
      expect(l.chunks[l.chunks.length - 1]!.end).toBe(l.duration);
      for (let i = 1; i < l.chunks.length; i++) {
        expect(l.chunks[i]!.start).toBeCloseTo(l.chunks[i - 1]!.end, 6);
        expect(l.chunks[i]!.x0).toBeCloseTo(l.chunks[i - 1]!.x1, 6);
      }
    }
  });
});

describe('generateLevel: the music', () => {
  let drops = 0;
  let hurdles = 0;
  // Longer songs with drops (one has two, one comes early), and fast ones, whose bars are
  // too short for a staircase in two.
  const songs: [number, number | undefined][] = [
    [102, undefined],
    [103, undefined],
    [114, undefined],
    [124, undefined],
    [102, 174],
    [103, 174],
  ];
  for (const [seed, tempo] of songs) {
    it(`builds a staircase set piece with gems at every drop (song ${seed}${tempo ? ` at ${tempo} BPM` : ''})`, () => {
      const map = buildLevelMap(randomAnalysis(seed, { duration: 80, tempo }));
      const l = generateLevel(map, DIFFICULTIES[seed % 3]!);
      const runIn = l.chunks[0]!.end;
      const runOut = l.chunks[l.chunks.length - 1]!.start;
      for (const e of map.events.filter((x) => x.kind === 'drop')) {
        // Drops with room for a set piece: after the run-in, four bars before the run-out.
        if (e.time < runIn || e.time > runOut - 16 * periodAt(map, e.time)) continue;
        drops++;
        const piece = l.chunks.find((c) => c.kind === 'drop' && c.start >= e.time - 1e-6);
        expect(piece, `drop at ${e.time.toFixed(2)} s`).toBeDefined();
        expect(piece!.start - e.time).toBeLessThan(4 * periodAt(map, e.time) + 1e-6);
        const steps = l.solids.filter(
          (s) => s.kind === 'step' && s.x0 >= piece!.x0 && s.x1 <= piece!.x1 + 1e-6,
        );
        expect(steps.length).toBeGreaterThanOrEqual(3);
        for (let i = 1; i < steps.length; i++)
          expect(steps[i]!.top).toBeGreaterThanOrEqual(steps[i - 1]!.top);
        const gems = l.pickups.filter(
          (p) => p.kind === 'gem' && p.time >= piece!.start && p.time < piece!.end,
        );
        expect(gems.length).toBeGreaterThanOrEqual(steps.length);
        // Hurdles on the plateau's beats, above its top.
        const plateau = steps[steps.length - 1]!;
        for (const h of l.solids.filter(
          (s) => s.kind === 'hurdle' && s.x0 >= plateau.x0 && s.x1 <= piece!.x1 + 1e-6,
        )) {
          expect(h.top).toBeGreaterThan(plateau.top);
          hurdles++;
        }
      }
    }, 20_000);
  }

  it('had drops to check, with hurdles on their plateaus', () => {
    expect(drops).toBeGreaterThanOrEqual(6);
    expect(hurdles).toBeGreaterThan(0);
  });

  it('keeps calm sections calm: their busy-music obstacles (spikes, equalisers, bridges) left out', () => {
    let calm = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const l = level(seed, DIFFICULTIES[seed % 3]!);
      const sections = song(seed).sections.filter((s) =>
        ['intro', 'breakdown', 'outro'].includes(s.kind),
      );
      for (const o of l.obstacles) {
        if (!sections.some((s) => o.time >= s.start && o.time < s.end)) continue;
        calm++;
        expect(['spikes', 'eq', 'bridge']).not.toContain(o.kind);
      }
    }
    expect(calm).toBeGreaterThan(0);
  });

  it('puts coins on the hi-hats (on the beats where there are none), and bridges only where there are snares', () => {
    const map = song(5);
    const l = level(5, 'normal');
    const hatTimes = map.events.filter((e) => e.kind === 'hat').map((e) => e.time);
    const hats = new Set(hatTimes);
    for (const p of l.pickups.filter((x) => x.kind === 'coin')) {
      if (hats.has(p.time)) continue;
      // Not on a hat: on a beat with no hat within a beat of it.
      expect(map.beats).toContain(p.time);
      expect(hatTimes.every((t) => Math.abs(t - p.time) > periodAt(map, p.time))).toBe(true);
    }
    expect(l.pickups.some((p) => p.kind === 'coin' && hats.has(p.time))).toBe(true);
    const snares = map.events.filter((e) => e.kind === 'snare').map((e) => e.time);
    for (const s of l.solids.filter((x) => x.kind === 'bridge'))
      for (const [from] of s.windows!) expect(snares).toContain(from);
  });

  it('keeps coins apart from each other and from the gems, even on fast hats', () => {
    const map = buildLevelMap(randomAnalysis(102, { duration: 80, tempo: 174 }));
    const l = generateLevel(map, 'hard');
    const coins = l.pickups.filter((p) => p.kind === 'coin').map((p) => p.x);
    const gems = l.pickups.filter((p) => p.kind === 'gem').map((p) => p.x);
    expect(coins.length).toBeGreaterThan(0);
    const sorted = [...coins].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++)
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(26 - 1e-6);
    for (const c of coins)
      for (const g of gems) expect(Math.abs(c - g)).toBeGreaterThanOrEqual(26 - 1e-6);
  });

  it('places boosters in turn over a full jump on a beat, at least 8 bars apart, never in drops', () => {
    /** The closest a jump from the ground at `t` (held, or let go at once) comes to `k`. */
    const closest = (
      l: PlatformerLevel,
      world: LevelWorld,
      t: number,
      k: Pickup,
      hold: boolean,
    ) => {
      const x = xAtTime(l, t);
      let top = -Infinity;
      let surface = -1;
      for (const i of world.solidsBetween(x, x + PLAYER_WIDTH)) {
        const at = world.topAt(i, t);
        if (l.solids[i]!.kind !== 'overhang' && at !== null && at > top) [top, surface] = [at, i];
      }
      if (surface < 0) return Infinity;
      let p: PlayerState = { ...startState(x, top), surface };
      let best = Infinity;
      for (let i = 1; i < 60 && p.alive; i++) {
        p = stepPlayer(p, { jump: i === 1, release: !hold }, world, t + i * PHYSICS_DT);
        const nx = Math.max(p.x, Math.min(k.x, p.x + PLAYER_WIDTH));
        const ny = Math.max(p.y, Math.min(k.y, p.y + PLAYER_HEIGHT));
        best = Math.min(best, Math.hypot(nx - k.x, ny - k.y));
      }
      return best;
    };
    let placed = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const map = song(seed);
      const l = level(seed, DIFFICULTIES[seed % 3]!);
      const world = new LevelWorld(l);
      const boosts = l.pickups.filter((p) => (BOOSTER_KINDS as string[]).includes(p.kind));
      placed += boosts.length;
      boosts.forEach((b, i) => {
        expect(b.time).toBeGreaterThan(map.sections[1]!.start);
        expect(l.chunks.some((c) => c.kind === 'drop' && b.time >= c.start && b.time < c.end)).toBe(
          false,
        );
        const prev = boosts[i - 1];
        if (prev) {
          expect(beatAt(map, b.time) - beatAt(map, prev.time)).toBeGreaterThanOrEqual(32 - 1e-6);
          expect(b.kind).not.toBe(prev.kind);
        }
        // A full jump on a beat just before reaches it; a short hop on that beat doesn't.
        const takeoffs = map.beats.filter((t) => t < b.time && t > b.time - 0.6);
        const reach = takeoffs.find((t) => closest(l, world, t, b, true) <= 22);
        expect(reach).toBeDefined();
        expect(closest(l, world, reach!, b, false)).toBeGreaterThan(22);
      });
    }
    expect(placed).toBeGreaterThan(4);
  });

  it('puts coins on the beats of a song with no hi-hats', () => {
    const map = song(5);
    const quiet = { ...map, events: map.events.filter((e) => e.kind !== 'hat') };
    const l = generateLevel(quiet, 'normal');
    const coins = l.pickups.filter((p) => p.kind === 'coin');
    expect(coins.length).toBeGreaterThan(map.beats.length / 4);
    for (const c of coins) expect(map.beats).toContain(c.time);
  });

  it('moves the equalisers with the bass', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const map = song(seed);
      const l = level(seed, DIFFICULTIES[seed % 3]!);
      for (const s of l.solids.filter((x) => x.kind === 'eq')) {
        const { times, tops } = s.keys!;
        const base = Math.min(...tops);
        for (let i = 0; i < times.length; i++) {
          const beat = map.beats.indexOf(times[i]!);
          expect(beat).toBeGreaterThanOrEqual(0);
          // Louder bass, higher column: the rise is the bass level times the column's shape.
          if (map.bass[beat] === 0) expect(tops[i]).toBeCloseTo(base, 6);
        }
      }
    }
  });
});

describe('generateLevel: bridges you land on as the snare comes out', () => {
  const saved = { ...DIFFICULTY.normal };
  afterEach(() => Object.assign(DIFFICULTY.normal, saved));

  /** A rock song: the snare exactly on 2 and 4 of every bar, doubled on the "and" of 4 when asked. */
  function backbeat(seed: number, doubled: boolean): LevelMap {
    const map = buildLevelMap(randomAnalysis(seed, { duration: 60, tempo: 150 }));
    const snares = map.beats.flatMap((time, beat): LevelEvent[] => {
      const inBar = (((beat - map.barPhase) % 4) + 4) % 4;
      const snare = (t: number): LevelEvent => ({ kind: 'snare', time: t, intensity: 1, beat });
      if (inBar === 1) return [snare(time)];
      if (inBar === 3)
        return doubled ? [snare(time), snare(time + periodAt(map, time) / 2)] : [snare(time)];
      return [];
    });
    const events = [...map.events.filter((e) => e.kind !== 'snare'), ...snares].sort(
      (a, b) => a.time - b.time,
    );
    return { ...map, events };
  }

  /** Physics from just before a bridge to past it, with jumps pressed at `presses`; alive after? */
  function crosses(l: PlatformerLevel, bridge: Obstacle, presses: number[]): boolean {
    const world = new LevelWorld(l);
    const { takeoff } = bridgeTimes(l.grid, bridge.time);
    const t0 = takeoff - 4 * PHYSICS_DT;
    // Standing on what is under the player's middle then.
    const middle = world.xAt(t0) + PLAYER_WIDTH / 2;
    const tops = l.solids
      .filter((s) => s.kind !== 'overhang' && s.x0 <= middle && s.x1 >= middle)
      .map((s) => solidTop(s, t0))
      .filter((top): top is number => top !== null);
    let p: PlayerState = startState(world.xAt(t0), Math.max(...tops));
    const steps = presses.map((t) => Math.ceil(t / PHYSICS_DT - 1e-9));
    // Until the landing after the jump off (what follows the bridge is another obstacle's).
    const { off } = bridgeTimes(l.grid, bridge.time);
    // The bridge's height: the still landing after it is at the same.
    const top = l.solids.find((s) => s.kind === 'bridge' && s.x0 === bridge.x0)!.top;
    for (let k = Math.ceil(t0 / PHYSICS_DT) + 1; k * PHYSICS_DT <= off + JUMP_AIR + 0.05; k++)
      p = stepPlayer(p, { jump: steps.includes(k), release: false }, world, k * PHYSICS_DT);
    // Alive and on the landing, not falling in the pit.
    return p.alive && p.y >= top - 1;
  }

  for (const doubled of [false, true])
    it(`lands the player on each bridge as its snare comes out (snares on 2 and 4${doubled ? ', doubled' : ''})`, () => {
      // Every busy bar an obstacle, so there are bridges to check.
      DIFFICULTY.normal.hazard = 1;
      let checked = 0;
      for (const seed of [21, 22, 23]) {
        const map = backbeat(seed, doubled);
        const l = generateLevel(map, 'normal');
        expect(validateLevel(l).ok).toBe(true);
        for (const bridge of l.obstacles.filter((o) => o.kind === 'bridge')) {
          const solid = l.solids.find((s) => s.kind === 'bridge' && s.x0 === bridge.x0)!;
          const { takeoff, land, off } = bridgeTimes(map, bridge.time);
          // One window, out on the snare, before the player comes down on it.
          expect(solid.windows).toHaveLength(1);
          expect(solid.windows![0]![0]).toBe(bridge.time);
          expect(land).toBeGreaterThan(bridge.time);
          // A jump on the beat before and one on the beat after cross it; either alone doesn't.
          expect(crosses(l, bridge, [takeoff, off])).toBe(true);
          expect(crosses(l, bridge, [takeoff])).toBe(false);
          expect(crosses(l, bridge, [off])).toBe(false);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    }, 20_000);

  it('takes off on the beat before the snare, or the eighth before on a slow song', () => {
    const grid = {
      beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4],
      segments: [{ start: 0, end: 4, tempo: 120, beatPeriod: 0.5 }],
    };
    expect(bridgeTimes(grid as never, 2).takeoff).toBeCloseTo(1.5);
    const slow = {
      beats: [0, 0.8, 1.6, 2.4, 3.2, 4],
      segments: [{ start: 0, end: 4, tempo: 75, beatPeriod: 0.8 }],
    };
    expect(bridgeTimes(slow as never, 2.4).takeoff).toBeCloseTo(2);
  });
});

describe('generateLevel: seeds and difficulty', () => {
  it('gives the same level for the same song and difficulty', () => {
    expect(generateLevel(song(3), 'hard')).toEqual(level(3, 'hard'));
  });

  it('gives another level at another difficulty, or for another song', () => {
    expect(level(3, 'easy')).not.toEqual(level(3, 'hard'));
    expect(level(3, 'easy').seed).not.toBe(level(3, 'hard').seed);
    expect(level(4, 'hard').seed).not.toBe(level(3, 'hard').seed);
  });

  it('makes hard levels busier, with wider gaps and longer spikes, than easy ones', () => {
    const stats = (d: Difficulty) => {
      const ls = [1, 2, 3, 4, 5, 6].map((s) => level(s, d));
      return {
        // Obstacles a second, but for the small steps plain ground takes with the energy.
        obstacles: mean(
          ls.map((l) => l.obstacles.filter((o) => o.kind !== 'kick' || o.air).length / l.duration),
        ),
        gap: mean(ls.flatMap((l) => kickAirs(l))),
      };
    };
    const easy = stats('easy');
    const hard = stats('hard');
    expect(hard.obstacles).toBeGreaterThan(easy.obstacles);
    expect(hard.gap).toBeGreaterThan(easy.gap);
    // Spikes come on syncopations, which the moments song has in its riff.
    const map = momentsMap();
    const spikes = (d: Difficulty) => mean(generateLevel(map, d).spikes.map((s) => s.x1 - s.x0));
    expect(spikes('hard')).toBeGreaterThan(spikes('easy'));
  }, 30_000);
});

describe('generateLevel: repairs', () => {
  const saved = { ...DIFFICULTY.hard };
  afterEach(() => Object.assign(DIFFICULTY.hard, saved));

  it('shrinks impossible gaps on their kicks until they are passable', () => {
    // Gaps on the kicks wider than a jump reaches, level on both sides.
    Object.assign(DIFFICULTY.hard, { hazard: 1, gap: 2.4, rise: 0 });
    const map = buildLevelMap(randomAnalysis(5, { duration: 80, tempo: 100 }));
    const l = generateLevel(map, 'hard');
    expect(validateLevel(l).ok).toBe(true);
    expect(l.chunks.reduce((n, c) => n + c.repairs, 0)).toBeGreaterThan(0);
    const kicks = new Set(map.events.filter((e) => e.kind === 'kick').map((e) => e.time));
    const gaps = l.obstacles.filter((o) => o.kind === 'kick' && o.air !== undefined);
    expect(gaps.length).toBeGreaterThan(0);
    for (const o of gaps) {
      // Still on its kick: shrunk, never moved.
      expect(kicks.has(o.time)).toBe(true);
      // A little past the reach at most: the far edge forgives a step's height.
      expect(o.air!).toBeLessThan(DASH_REACH + 0.05);
    }
  });
});

describe('generateLevel: abilities', () => {
  const songs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  it('sizes dash pits between what a jump and a jump and dash reach', () => {
    let pits = 0;
    for (const seed of songs)
      for (const o of level(seed, DIFFICULTIES[seed % 3]!).obstacles) {
        if (o.needs !== 'dash' || o.air === undefined) continue;
        pits++;
        expect(o.air).toBeGreaterThan(JUMP_REACH);
        expect(o.air).toBeLessThan(DASH_REACH);
      }
    expect(pits).toBeGreaterThan(0);
  }, 30_000);

  it('teaches dash and slam on the first obstacle needing them, before any other does', () => {
    let taught = 0;
    for (const seed of songs) {
      const l = level(seed, DIFFICULTIES[seed % 3]!);
      for (const lesson of l.lessons) {
        taught++;
        // The lesson is the first obstacle needing its ability.
        const first = l.obstacles.find((o) => o.needs === lesson.action)!;
        expect(first).toBeDefined();
        expect(lesson.time).toBeGreaterThanOrEqual(first.time - 1);
        expect(lesson.time).toBeLessThanOrEqual(first.end);
      }
      // Nothing needing an ability before its lesson.
      for (const o of l.obstacles)
        if (o.needs)
          expect(l.lessons.some((x) => x.action === o.needs && x.time <= o.end + 1e-6)).toBe(true);
    }
    expect(taught).toBeGreaterThanOrEqual(songs.length);
  });

  it('makes the dash lesson need a dash: without one, the way through stops there', () => {
    let checked = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
      const l = level(seed, DIFFICULTIES[seed % 3]!);
      for (const lesson of l.lessons.filter((x) => x.action === 'dash')) {
        const check = validateLevel(l, 'dash');
        expect(check.ok, `dash at ${lesson.time.toFixed(2)} s`).toBe(false);
        expect(check.reached).toBeGreaterThan(lesson.time - 1);
        expect(check.reached).toBeLessThan(lesson.end + 0.5);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('makes the slam lesson, a slam plate on a heavy kick, take a jump and then a slam', () => {
    let checked = 0;
    for (const seed of songs) {
      const l = level(seed, DIFFICULTIES[seed % 3]!);
      const world = new LevelWorld(l);
      for (const lesson of l.lessons.filter((x) => x.action === 'slam')) {
        const ceiling = l.obstacles.find((o) => o.kind === 'slam' && o.end === lesson.end);
        if (!ceiling) continue;
        // On the ground a moment before, as the search gets there.
        const before = Math.floor(stepAt(lesson.time - 0.3) / 3) * 3;
        const explorer = Explorer.start(world);
        explorer.run(before);
        const start = explorer.states.find((s) => s.grounded)!;
        expect(start).toBeDefined();
        const play = (slamAt: number | null) => {
          let p = start;
          for (let step = before + 1; step < stepAt(lesson.end + 0.3) && p.alive; step++) {
            const t = step * PHYSICS_DT;
            const jump = Math.abs(t - lesson.time) < PHYSICS_DT / 2;
            const slam = slamAt !== null && Math.abs(t - slamAt) < PHYSICS_DT / 2;
            p = stepPlayer(p, { jump, slam }, world, t);
          }
          return p;
        };
        expect(play(null).death).toBe('wall');
        // Slam a quarter of a second after the jump: through the plate, under the ceiling.
        const slammed = [0.27, 0.3, 0.33].map((d) => play(stepAt(lesson.time + d) * PHYSICS_DT));
        expect(slammed.some((p) => p.alive)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('puts every dash gate on an accent, on its ground', () => {
    let gates = 0;
    for (const seed of songs) {
      const map = song(seed);
      const l = level(seed, DIFFICULTIES[seed % 3]!);
      const accents = map.features.accents.map((a) => a.time);
      for (const g of l.gates) {
        gates++;
        expect(accents.some((t) => Math.abs(t - g.time) < 1e-6)).toBe(true);
        // Met a grace after the beat, so a dash pressed on it is in time.
        expect(g.at).toBeCloseTo(g.time + GATE_GRACE, 9);
        expect(g.x).toBeCloseTo(xAtTime(l, g.at) + PLAYER_WIDTH, 6);
      }
    }
    expect(gates).toBeGreaterThan(0);
  });
});

describe('generateLevel: songs whose tempo changes', () => {
  // 120 BPM, then 150 (a faster scroll), then a half-time 75 (the same scroll as 150).
  const analysis = randomAnalysis(31, {
    tempo: 120,
    duration: 70,
    changes: [
      { time: 25, tempo: 150 },
      { time: 48, tempo: 75 },
    ],
  });
  const map = buildLevelMap(analysis);
  const levels = DIFFICULTIES.map((d) => generateLevel(map, d));

  it('builds levels that can be finished at every difficulty', () => {
    expect(map.segments).toHaveLength(3);
    for (const l of levels) expect(validateLevel(l).ok).toBe(true);
  });

  it("scrolls at each segment's speed, easing over a beat at every change", () => {
    const l = levels[1]!;
    const [slow, fast, half] = map.segments;
    expect(speedAt(l, slow!.start + 1)).toBeCloseTo(scrollSpeed(slow!.tempo), 6);
    expect(speedAt(l, fast!.start + fast!.beatPeriod + 0.01)).toBeCloseTo(
      scrollSpeed(fast!.tempo),
      6,
    );
    // Half time folds to the same speed: no change there.
    expect(speedAt(l, half!.start + 1)).toBeCloseTo(scrollSpeed(fast!.tempo), 6);
    // No jump in speed or place anywhere, and the speed only moves during the easing.
    for (let t = 0; t < map.duration; t += 0.01) {
      const dv = Math.abs(speedAt(l, t + 0.01) - speedAt(l, t));
      expect(dv).toBeLessThan(2);
      const dx = xAtTime(l, t + 0.01) - xAtTime(l, t);
      expect(dx).toBeCloseTo(0.01 * speedAt(l, t + 0.005), 3);
      expect(timeAtX(l, xAtTime(l, t))).toBeCloseTo(t, 9);
    }
  });

  it('lays each stretch out on the grid beats of its own tempo', () => {
    for (const l of levels)
      for (const c of l.chunks.filter((x) => x.kind !== 'run-in' && x.kind !== 'run-out')) {
        // Stretches start on bar lines, and the drop staircase's steps are beats apart.
        expect(map.downbeats).toContain(c.start);
        const b = beatAt(map, c.end);
        expect(Math.abs(b - Math.round(b))).toBeLessThan(1e-6);
      }
  });
});

describe('generateLevel: a floor of obstacles', () => {
  const feelAt = (map: LevelMap, t: number) =>
    map.moods[map.sections.findIndex((s) => t >= s.start && t < s.end)]?.feel;
  const calmFeel = (feel: string | undefined) => feel === 'calm' || feel === 'breakdown';

  it('gives nearly every bar of a busy part something to press, and calm parts no more', () => {
    let busy = 0;
    let met = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const map = song(seed);
      const l = level(seed, 'normal');
      const start = l.chunks.find((c) => c.kind !== 'run-in')?.start ?? 0;
      const runOut = l.chunks.find((c) => c.kind === 'run-out')?.start ?? l.duration;
      map.downbeats.forEach((bar, i) => {
        const end = map.downbeats[i + 1] ?? runOut;
        const section = map.sections.find((s) => bar >= s.start && bar < s.end);
        const calm = ['intro', 'breakdown', 'outro'].includes(section?.kind ?? '');
        if (bar < start || end > runOut || calm || calmFeel(feelAt(map, bar))) return;
        busy++;
        if (l.obstacles.some((o) => o.time < end && o.end > bar)) met++;
      });
      // The floor's own gaps are never in calm parts.
      for (const o of l.obstacles.filter((o) => o.reason === 'the beat'))
        expect(calmFeel(feelAt(map, o.time))).toBe(false);
    }
    expect(busy).toBeGreaterThan(20);
    // Repairs may still flatten a bar nobody gets through.
    expect(met / busy).toBeGreaterThanOrEqual(0.9);
  });
});

describe('generateLevel: obstacles from the music (a song with one of each moment)', () => {
  const song = momentsSong();
  const map = momentsMap();
  const levels = Object.fromEntries(DIFFICULTIES.map((d) => [d, generateLevel(map, d)])) as Record<
    Difficulty,
    PlatformerLevel
  >;
  /** The grid's bar line nearest a time in the song. */
  const bar = (t: number) =>
    map.downbeats.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
  const near = (a: number, b: number, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

  it('can be finished at every difficulty, and builds the same level every time', () => {
    for (const d of DIFFICULTIES) {
      expect(validateLevel(levels[d]).ok, d).toBe(true);
      expect(generateLevel(map, d)).toEqual(levels[d]);
    }
  });

  it('puts a dash pit over the held chord: off on its hit, in the air as long as it holds', () => {
    const held = map.features.sustains[0]!;
    for (const d of DIFFICULTIES) {
      const pit = levels[d].obstacles.find((o) => o.kind === 'held')!;
      expect(pit, d).toBeDefined();
      expect(pit.time).toBeCloseTo(held.time, 6);
      expect(pit.needs).toBe('dash');
      expect(pit.label).toBe('Dash pit');
      expect(pit.reason).toBe('held chord, 1.75 beats');
      // As long as the chord holds, up to what the difficulty lets a jump and a dash reach.
      const reach = dashPitAir(DIFFICULTY[d].held);
      expect(pit.air!).toBeCloseTo(Math.min(held.end - held.time, reach), 6);
      expect(pit.air!).toBeGreaterThan(JUMP_REACH);
      expect(pit.air!).toBeLessThan(DASH_REACH);
    }
    // Normal and hard reach the whole 1.75 beats: the player lands as the chord ends.
    const normal = levels.normal.obstacles.find((o) => o.kind === 'held')!;
    expect(normal.end).toBeCloseTo(held.end, 6);
  });

  it('puts a pit over the stop that lands as the band comes back in', () => {
    const stop = map.features.stops[0]!;
    for (const d of DIFFICULTIES) {
      const pit = levels[d].obstacles.find((o) => o.kind === 'stop')!;
      expect(pit, d).toBeDefined();
      expect(pit.time).toBeCloseTo(stop.time, 6);
      expect(pit.end).toBeCloseTo(stop.end, 6);
      expect(pit.reason).toMatch(/^band stops, /);
    }
    // Long enough to need the dash where the difficulty reaches that far.
    expect(levels.hard.obstacles.find((o) => o.kind === 'stop')!.needs).toBe('dash');
  });

  it('puts a dash gate on every accent, the first teaching the dash', () => {
    for (const d of DIFFICULTIES) {
      const gates = levels[d].gates.map((g) => g.time);
      expect(gates).toHaveLength(song.accents.length);
      for (const a of map.features.accents) expect(gates.some((t) => near(t, a.time))).toBe(true);
      expect(levels[d].lessons[0]).toMatchObject({ action: 'dash' });
      expect(levels[d].lessons[0]!.time).toBeCloseTo(map.features.accents[0]!.time, 6);
    }
  });

  it('puts a staircase on the fill: a step down on each of its hits', () => {
    const fill = map.features.fills[0]!;
    for (const d of DIFFICULTIES) {
      const l = levels[d];
      const stairs = l.obstacles.find((o) => o.kind === 'stairs')!;
      expect(stairs, d).toBeDefined();
      expect(stairs.time).toBeCloseTo(fill.hits[0]!, 6);
      const hits = Number(/each of (\d+) hits/.exec(stairs.reason)![1]);
      expect(hits).toBeGreaterThanOrEqual(3);
      // A fill ending in a slam has plates for its last steps, over the ground.
      const plates = l.solids.filter((s) => s.kind === 'plate');
      const under = (s: Solid) => plates.some((p) => Math.abs(p.x0 - s.x0) < 1e-6 && p !== s);
      const steps = l.solids
        .filter(
          (s) =>
            (s.kind === 'ground' || s.kind === 'plate') &&
            !(s.kind === 'ground' && under(s)) &&
            s.x0 >= stairs.x0 - 1e-6 &&
            s.x1 <= stairs.x1 + 1e-6,
        )
        .slice(0, hits);
      expect(steps).toHaveLength(hits);
      if (stairs.needs === 'slam') expect(steps[hits - 1]!.kind).toBe('plate');
      // Each step after the first starts where the player is on its hit, lower than the last.
      for (let k = 1; k < hits; k++) {
        expect(steps[k]!.top).toBeLessThan(steps[k - 1]!.top);
        const on = timeAtX(l, steps[k]!.x0 - PLAYER_WIDTH / 2);
        expect(fill.hits.some((t) => near(on, t, 1e-6))).toBe(true);
      }
    }
  });

  it('repeats the riff: the same obstacles on the same moments when it comes again', () => {
    const first = bar(song.riff.first[0]!);
    const again = bar(song.riff.again[0]!);
    const shift = again - first;
    const length = bar(song.riff.again[0]!) - first;
    for (const d of DIFFICULTIES) {
      const l = levels[d];
      const inside = (from: number) =>
        l.obstacles.filter((o) => o.time >= from - 1e-6 && o.time < from + length - 1e-6);
      const a = inside(first);
      const b = inside(again);
      expect(a.length, d).toBeGreaterThanOrEqual(3);
      const what = (os: typeof a) => os.map((o) => [o.kind, o.label, o.reason]);
      expect(what(b)).toEqual(what(a));
      b.forEach((o, k) => {
        expect(o.time - shift).toBeCloseTo(a[k]!.time, 6);
        expect(o.x1 - o.x0).toBeCloseTo(a[k]!.x1 - a[k]!.x0, 6);
        // It says which bar it repeats: the song's bar (from 1) the riff first played it in
        // (a slam plate's is the bar its plate starts in).
        const source = map.downbeats.findIndex((t) => t > o.time - shift + 1e-6);
        expect([source, source - 1]).toContain(o.repeats);
        expect(a[k]!.repeats).toBeUndefined();
      });
    }
  });

  it('keeps the rare moments on the same beats at every difficulty, only sized differently', () => {
    const rare = (d: Difficulty) =>
      levels[d].obstacles
        .filter((o) => ['held', 'stop', 'gate', 'stairs'].includes(o.kind))
        .map((o) => `${o.kind}@${o.time.toFixed(4)}`);
    expect(rare('easy')).toEqual(rare('normal'));
    expect(rare('hard')).toEqual(rare('normal'));
  });
});

describe('generateLevel: every obstacle has its musical moment', () => {
  it('puts every obstacle on a moment of the song, and says what it is', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const map = song(seed);
      const l = level(seed, DIFFICULTIES[seed % 3]!);
      const { sustains, stops, accents, fills, syncopations } = map.features;
      const moments = [
        ...map.events.filter((e) => e.kind === 'kick' || e.kind === 'snare').map((e) => e.time),
        ...sustains.map((s) => s.time),
        ...stops.map((s) => s.time),
        ...accents.map((a) => a.time),
        ...fills.flatMap((f) => f.hits),
        ...syncopations.map((s) => s.time),
        // Equalisers and the drop's staircase take a whole stretch from its bar line.
        ...map.downbeats,
      ];
      for (const o of l.obstacles) {
        const on = moments.some((t) => Math.abs(t - o.time) < 1e-6);
        expect(on, `${o.label} at ${o.time}`).toBe(true);
        expect(o.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('generateLevel: presses on the pulse', () => {
  /** How far `t` is from the nearest beat or "and", in beats. */
  const offPulse = (map: LevelMap, t: number) => {
    const eighths = beatAt(map, t) * 2;
    return Math.abs(eighths - Math.round(eighths)) / 2;
  };
  /** The moments song with an accent and an off-beat hit moved onto a sixteenth. */
  const pushed = (): LevelMap => {
    const map = momentsMap();
    const by = periodAt(map, 0) / 4;
    const { accents, syncopations } = map.features;
    return {
      ...map,
      features: {
        ...map.features,
        accents: accents.map((a) => ({ ...a, time: a.time + by })),
        syncopations: syncopations.map((s) => ({ ...s, time: s.time + by })),
      },
    };
  };

  it('asks for no press on a sixteenth below hard', () => {
    const map = pushed();
    expect(map.features.accents.length + map.features.syncopations.length).toBeGreaterThan(1);
    for (const difficulty of ['easy', 'normal'] as const) {
      const level = generateLevel(map, difficulty);
      const pressed = level.obstacles.filter((o) => ['gate', 'spikes', 'kick'].includes(o.kind));
      expect(pressed.length).toBeGreaterThan(0);
      for (const o of pressed) expect(offPulse(map, o.time)).toBeLessThanOrEqual(0.09);
    }
    const hard = generateLevel(map, 'hard');
    const on16 = hard.obstacles.filter(
      (o) => (o.kind === 'gate' || o.kind === 'spikes') && offPulse(map, o.time) > 0.2,
    );
    expect(on16.length).toBeGreaterThan(0);
  });

  it('gives off-beat hits that are the song’s texture no spikes', () => {
    const map = momentsMap();
    const period = periodAt(map, 0);
    // An off-beat hit on every "and" of the song: a wall of guitars, not a moment.
    const syncopations = map.beats.map((b) => ({ time: b + period / 2, strength: 0.8 }));
    const dense = { ...map, features: { ...map.features, syncopations } };
    for (const difficulty of DIFFICULTIES)
      expect(generateLevel(dense, difficulty).obstacles.filter((o) => o.kind === 'spikes')).toEqual(
        [],
      );
    expect(generateLevel(map, 'normal').obstacles.some((o) => o.kind === 'spikes')).toBe(true);
  });
});

describe('pressesOf: where the obstacles want their presses', () => {
  it('lists a press on every gap, spike strip and gate, and two around a bridge, in order', () => {
    const map = momentsMap();
    const level = generateLevel(map, 'normal');
    const presses = pressesOf(level);
    const count = (kind: string) => level.obstacles.filter((o) => o.kind === kind).length;
    expect(presses.filter((p) => p.dash)).toHaveLength(count('gate'));
    expect(presses.length).toBeGreaterThanOrEqual(
      count('gate') + count('spikes') + 2 * count('bridge'),
    );
    expect(presses.length).toBeGreaterThan(4);
    for (let i = 1; i < presses.length; i++)
      expect(presses[i]!.time).toBeGreaterThanOrEqual(presses[i - 1]!.time);
    // Every one on a beat or an "and": the pulse.
    for (const p of presses) {
      const eighths = beatAt(map, p.time) * 2;
      expect(Math.abs(eighths - Math.round(eighths))).toBeLessThanOrEqual(0.2);
    }
  });
});
