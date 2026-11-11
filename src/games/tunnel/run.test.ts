import { describe, expect, it } from 'vitest';
import { buildLevelMap, steadyGrid } from '../../core';
import { analyseSamples } from '../../core/analysis/analyse';
import { electroSong } from '../../core/analysis/test-songs';
import { COMBO_STEP, DOWNBEAT_BONUS, OVERDRIVE_FACTOR, RESUME_BEATS } from '../shared/scoring';
import {
  generateLevel,
  solveLevel,
  zAtTime,
  type BoosterKind,
  type Obstacle,
  type SectionLook,
} from './level';
import { testTrack } from './level/test-track';
import { LANE_HOP_TIME, PHYSICS_DT } from './physics';
import {
  BOOSTER_BEATS,
  CLEAN_BONUS,
  CRASH_PENALTY,
  HOOP_STREAK_BONUS,
  MAGNET_REACH,
  PICKUP_REACH,
  POINTS,
  SURGE_FACTOR,
  rankOf,
  rankRules,
  summaryOf,
  TunnelRun,
  type RunEvent,
  type RunInput,
} from './run';

const NOTHING: RunInput = {
  leftHeld: false,
  rightHeld: false,
  leftPressed: false,
  rightPressed: false,
  jumpPressed: false,
};
const RIGHT: RunInput = { ...NOTHING, rightHeld: true, rightPressed: true };
const HOLD_RIGHT: RunInput = { ...NOTHING, rightHeld: true };
const JUMP: RunInput = { ...NOTHING, jumpPressed: true };

/** A hand-built track at 120 BPM (a beat every 0.5 s), with gems and sections when given. */
function race(
  obstacles: Partial<Obstacle>[] = [],
  opts: {
    gems?: { time: number; lane: number }[];
    sections?: number[];
    duration?: number;
    boosters?: { kind: BoosterKind; time: number; lane: number }[];
    hoops?: { time: number; lane: number; group?: number; slot?: number; size?: number }[];
  } = {},
) {
  const duration = opts.duration ?? 6;
  const { track } = testTrack(obstacles, 5, duration);
  track.grid = steadyGrid(0, 0.5, duration);
  track.boosters = (opts.boosters ?? []).map((b) => ({ ...b, z: zAtTime(track, b.time) }));
  track.hoops = (opts.hoops ?? []).map((h) => ({
    kind: 'phrase' as const,
    group: 0,
    slot: 0,
    size: 1,
    ...h,
    z: zAtTime(track, h.time),
  }));
  track.pickups = (opts.gems ?? []).map((g) => ({
    kind: 'gem' as const,
    ...g,
    z: zAtTime(track, g.time),
  }));
  const bounds = [0, ...(opts.sections ?? []), duration];
  track.looks = bounds.slice(1).map((end, i): SectionLook => ({
    start: bounds[i]!,
    end,
    feel: 'groove',
    radius: 1,
    radiusEnd: 1,
    ringBeats: 1,
    glow: 0.5,
    ringWalls: false,
    spin: 0,
    burst: 0,
    stars: 0,
  }));
  return { track, run: new TunnelRun(track) };
}

/** Feed the run frames of a physics step from `from` to `to`, with `input` on the first. */
function play(run: TunnelRun, from: number, to: number, input = NOTHING, rest = NOTHING) {
  const events: RunEvent[] = [];
  let first = true;
  for (let t = from; t <= to + 1e-9; t += PHYSICS_DT) {
    events.push(...run.update(t, first ? input : rest));
    first = false;
  }
  return events;
}

const ofType = <T extends RunEvent['type']>(events: RunEvent[], type: T) =>
  events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

describe('TunnelRun', () => {
  it('counts a bar in, then puts the racer where song time does, whatever the frames', () => {
    const { track, run } = race();
    expect(run.countInFrom).toBeCloseTo(-2);
    expect(run.countInBeats).toBe(4);
    run.update(-1, NOTHING);
    expect(run.phase).toBe('countin');
    run.update(0, NOTHING);
    expect(run.phase).toBe('playing');
    run.update(0.37, NOTHING);
    run.update(1, NOTHING);
    expect(run.racer.z).toBeCloseTo(zAtTime(track, 1), 6);
  });

  it('counts in again after a pause, holding the racer where it stopped', () => {
    const { run } = race();
    play(run, 0, 1);
    const stopped = run.racer.z;
    const from = run.holdForResume();
    expect(run.phase).toBe('countin');
    expect(run.countInBeats).toBe(RESUME_BEATS);
    expect(from).toBeCloseTo(run.resumeAt - RESUME_BEATS * 0.5);
    play(run, from, run.resumeAt - 0.01);
    expect(run.racer.z).toBe(stopped);
    play(run, run.resumeAt, run.resumeAt + 0.2);
    expect(run.phase).toBe('playing');
    expect(run.racer.z).toBeGreaterThan(stopped);
  });

  it('crashes without stopping: the combo breaks, points go and the race goes on', () => {
    const gems = [0.2, 0.4, 0.6].map((time) => ({ time, lane: 2 }));
    const { track, run } = race([{ time: 1, lanes: [2] }], { gems });
    const events = play(run, 0, 1.5);
    const crash = ofType(events, 'crash');
    expect(crash).toHaveLength(1);
    expect(crash[0]!.obstacle.time).toBe(1);
    expect(crash[0]!.lost).toBe(3 * POINTS.gem);
    expect(run.score).toBe(0);
    expect(run.combo).toBe(0);
    expect(run.bestCombo).toBe(3);
    expect(run.crashes).toBe(1);
    expect(run.crashedAt).toBeCloseTo(1, 1);
    expect(run.phase).toBe('playing');
    expect(run.racer.z).toBeCloseTo(zAtTime(track, 1.5), 6);
  });

  it('costs at most the crash penalty', () => {
    const gems = Array.from({ length: 12 }, (_, i) => ({ time: 0.1 + i * 0.05, lane: 2 }));
    const { run } = race([{ time: 1, lanes: [2] }], { gems });
    const before = play(run, 0, 0.9);
    expect(ofType(before, 'pickup')).toHaveLength(12);
    const score = run.score;
    const crash = ofType(play(run, 0.9 + PHYSICS_DT, 1.2), 'crash')[0]!;
    expect(crash.lost).toBe(CRASH_PENALTY);
    expect(run.score).toBe(score - CRASH_PENALTY);
  });

  it('steers clear of a block with a hop, judged on the beat', () => {
    const { run } = race([{ time: 1, lanes: [2] }]);
    play(run, 0, 0.5 - PHYSICS_DT);
    const events = play(run, 0.5, 1.5, RIGHT);
    expect(ofType(events, 'crash')).toHaveLength(0);
    expect(run.racer.lane).toBe(3);
    const beat = ofType(events, 'beat');
    expect(beat).toEqual([expect.objectContaining({ action: 'hop', quality: 'perfect' })]);
    expect(beat[0]!.points).toBe(POINTS.perfect);
    expect(run.hoppedAt).toBeCloseTo(0.5, 6);
  });

  it('judges a hop between the beat and the eighth a miss, without breaking the combo', () => {
    const { run } = race([], { gems: [{ time: 0.2, lane: 2 }] });
    play(run, 0, 0.37 - PHYSICS_DT);
    expect(run.combo).toBe(1);
    const beat = ofType(play(run, 0.37, 0.6, RIGHT), 'beat');
    expect(beat).toEqual([expect.objectContaining({ quality: 'miss', points: 0 })]);
    expect(run.combo).toBe(1);
    expect(run.results().miss).toBe(1);
  });

  it('judges a press the input lead before it acts', () => {
    const { run } = race();
    run.inputLead = 0.08;
    play(run, 0, 0.58 - PHYSICS_DT);
    const beat = ofType(play(run, 0.58, 0.7, RIGHT), 'beat');
    expect(beat[0]!.quality).toBe('perfect');
  });

  it('hops again every half beat while held, judging only the press', () => {
    const { run } = race();
    play(run, 0, 0.5 - PHYSICS_DT);
    const events = play(run, 0.5, 1.6, RIGHT, HOLD_RIGHT);
    // From lane 2: a hop on the press, another on the next half beat, then the side wall.
    expect(run.racer.lane).toBe(4);
    expect(ofType(events, 'beat')).toHaveLength(1);
    // Let go: no more repeats, and a new press starts the timing again.
    play(run, 1.6 + PHYSICS_DT, 2);
    expect(run.racer.lane).toBe(4);
  });

  it('stops repeating when let go', () => {
    const { run } = race();
    play(run, 0, 0.5 - PHYSICS_DT);
    play(run, 0.5, 0.5 + LANE_HOP_TIME, RIGHT, HOLD_RIGHT);
    play(run, 0.5 + LANE_HOP_TIME + PHYSICS_DT, 1.5);
    expect(run.racer.lane).toBe(3);
  });

  it('jumps a low wall, and a jump pressed just before landing happens on landing', () => {
    const { run } = race([{ time: 1, lanes: [0, 1, 2, 3, 4], low: true }]);
    play(run, 0, 0.9 - PHYSICS_DT);
    const events = play(run, 0.9, 1.3, JUMP);
    expect(ofType(events, 'crash')).toHaveLength(0);
    expect(run.jumpedAt).toBeCloseTo(0.9, 6);
    // Pressed in the air, a jump waits for the floor.
    const { run: again } = race();
    play(again, 0, 1 - PHYSICS_DT);
    play(again, 1, 1.25, JUMP);
    play(again, 1.25 + PHYSICS_DT, 1.27, JUMP);
    play(again, 1.27 + PHYSICS_DT, 1.4);
    expect(again.jumpedAt).toBeGreaterThan(1.3);
  });

  it('takes the gems in its lane, raising the multiplier with the combo', () => {
    const gems = Array.from({ length: COMBO_STEP + 1 }, (_, i) => ({
      time: 0.2 + i * 0.1,
      lane: 2,
    }));
    const { run } = race([], { gems: [...gems, { time: 0.25, lane: 0 }] });
    const pickups = ofType(play(run, 0, 2), 'pickup');
    expect(pickups).toHaveLength(COMBO_STEP + 1);
    expect(pickups[0]!.points).toBe(POINTS.gem);
    expect(pickups[COMBO_STEP]!.points).toBe(2 * POINTS.gem);
    expect(run.isCollected(gems.length)).toBe(false);
    expect(run.results()).toMatchObject({ pickups: COMBO_STEP + 1, totalPickups: COMBO_STEP + 2 });
  });

  it('runs overdrive for 4 bars at double score, with a bonus on a downbeat', () => {
    const { run } = race([], { gems: [{ time: 2.5, lane: 2 }], duration: 12 });
    play(run, 0, 2 - PHYSICS_DT);
    expect(ofType(play(run, 2, 2.1, { ...NOTHING, overdrivePressed: true }), 'overdrive')).toEqual(
      [],
    );
    run.meter = 1;
    const od = ofType(
      play(run, 2.1 + PHYSICS_DT, 2.2, { ...NOTHING, overdrivePressed: true }),
      'overdrive',
    );
    expect(od).toEqual([{ type: 'overdrive', downbeat: false, points: 0 }]);
    expect(run.overdrive.until).toBeCloseTo(run.overdrive.from + 8, 6);
    expect(run.meter).toBe(0);
    const gem = ofType(play(run, 2.2 + PHYSICS_DT, 3), 'pickup')[0]!;
    expect(gem.points).toBe(POINTS.gem * OVERDRIVE_FACTOR);

    const { run: onBeat } = race([], { duration: 12 });
    play(onBeat, 0, 4 - PHYSICS_DT);
    onBeat.meter = 1;
    const bonus = ofType(play(onBeat, 4, 4, { ...NOTHING, overdrivePressed: true }), 'overdrive');
    expect(bonus).toEqual([{ type: 'overdrive', downbeat: true, points: DOWNBEAT_BONUS }]);
  });

  it('gives a clean section a bonus and a shield, which takes the next crash instead of points', () => {
    const gems = [{ time: 2.5, lane: 2 }];
    const { run } = race([{ time: 3, lanes: [2] }], { gems, sections: [2] });
    const first = ofType(play(run, 0, 2.2), 'clean');
    expect(first).toEqual([{ type: 'clean', points: CLEAN_BONUS, shield: true }]);
    expect(run.shield).toBe(true);
    const crash = ofType(play(run, 2.2 + PHYSICS_DT, 3.5), 'crash')[0]!;
    expect(crash).toMatchObject({ shield: true, lost: 0 });
    expect(run.shield).toBe(false);
    expect(run.combo).toBe(0);
    // The section with the crash ends with the song, without a bonus.
    const end = play(run, 3.5 + PHYSICS_DT, 6.1);
    expect(ofType(end, 'clean')).toHaveLength(0);
    expect(run.phase).toBe('finished');
    expect(run.results()).toMatchObject({ crashes: 1, saves: 1, clean: 1, sections: 2 });
  });

  it('finishes with the song and ranks the race', () => {
    const { run } = race([], { gems: [{ time: 1, lane: 2 }] });
    play(run, 0, 0.5 - PHYSICS_DT);
    play(run, 0.5, 0.6, RIGHT);
    play(run, 0.6 + PHYSICS_DT, 1 - PHYSICS_DT);
    play(run, 1, 1.1, { ...NOTHING, leftHeld: true, leftPressed: true });
    play(run, 1.1 + PHYSICS_DT, 6.1);
    expect(run.phase).toBe('finished');
    const r = run.results();
    expect(r).toMatchObject({ perfect: 2, crashes: 0, clean: 1, pickups: 0, rank: 'C' });
    expect(r.timing).toBe(1);
  });
});

describe('boosters', () => {
  it('puts up a shield when the shield is taken, which takes the next crash', () => {
    const { run } = race([{ time: 3, lanes: [2] }], {
      boosters: [{ kind: 'shield', time: 1, lane: 2 }],
    });
    const taken = ofType(play(run, 0, 1.5), 'booster');
    expect(taken).toEqual([
      expect.objectContaining({ kind: 'shield', shield: true, points: POINTS.booster }),
    ]);
    expect(run.shield).toBe(true);
    expect(run.boosterTaken(0)).toBe(true);
    const crash = ofType(play(run, 1.5 + PHYSICS_DT, 3.5), 'crash')[0]!;
    expect(crash).toMatchObject({ shield: true, lost: 0 });
    expect(run.results()).toMatchObject({ boosters: 1, totalBoosters: 1, saves: 1 });
  });

  it('is only taken in its own lane', () => {
    const { run } = race([], { boosters: [{ kind: 'surge', time: 1, lane: 0 }] });
    expect(ofType(play(run, 0, 1.5), 'booster')).toEqual([]);
    expect(run.boosterTaken(0)).toBe(false);
  });

  it('runs the magnet for two bars: gems in the lanes beside the racer are taken, then not', () => {
    const gems = [
      { time: 1.5, lane: 3 },
      { time: 1.6, lane: 4 },
      { time: 5, lane: 3 },
    ];
    const { run } = race([], {
      gems,
      boosters: [{ kind: 'magnet', time: 1, lane: 2 }],
      duration: 8,
    });
    play(run, 0, 1.2);
    expect(run.magnetAt(1.2)).toBe(true);
    expect(run.magnet.until - run.magnet.from).toBeCloseTo(BOOSTER_BEATS.magnet * 0.5, 6);
    play(run, 1.2 + PHYSICS_DT, 2);
    // The next lane is taken (1 lane away), the one two lanes away is not.
    expect(run.isCollected(0)).toBe(true);
    expect(run.isCollected(1)).toBe(false);
    expect(MAGNET_REACH).toBeGreaterThan(1);
    expect(MAGNET_REACH).toBeLessThan(2);
    // Once the magnet has run out, a gem beside the racer is out of reach again.
    play(run, 2 + PHYSICS_DT, 5.5);
    expect(run.magnetAt(5)).toBe(false);
    expect(run.isCollected(2)).toBe(false);
    expect(PICKUP_REACH).toBeLessThan(1);
  });

  it('doubles what gems and hoops score while the surge runs, and not the hops', () => {
    const gems = [
      { time: 1.5, lane: 2 },
      { time: 5.5, lane: 2 },
    ];
    const { run } = race([], {
      gems,
      boosters: [{ kind: 'surge', time: 1, lane: 2 }],
      hoops: [{ time: 2, lane: 2 }],
      duration: 8,
    });
    const events = play(run, 0, 2.5);
    expect(run.surgeAt(2)).toBe(true);
    const [gem] = ofType(events, 'pickup');
    // The booster before it is combo 1; the gem is combo 2 (still ×1), doubled.
    expect(gem!.points).toBe(POINTS.gem * SURGE_FACTOR);
    expect(ofType(events, 'hoop')[0]!.points).toBe(POINTS.hoop * SURGE_FACTOR);
    // Back to normal after two bars.
    const late = ofType(play(run, 2.5 + PHYSICS_DT, 6), 'pickup')[0]!;
    expect(run.surgeAt(5)).toBe(false);
    expect(late.points).toBe(POINTS.gem);
  });

  it('never counts toward the rank: only gems do', () => {
    const { run } = race([], {
      gems: [{ time: 4, lane: 2 }],
      boosters: [{ kind: 'magnet', time: 1, lane: 2 }],
      hoops: [{ time: 2, lane: 2 }],
    });
    play(run, 0, 6.1);
    const r = run.results();
    expect(r).toMatchObject({ pickups: 1, totalPickups: 1, boosters: 1, hoops: 1 });
    expect(r.rank).toBe('C');
  });
});

describe('boost hoops', () => {
  const phrase = [1, 2, 3, 4].map((time, slot) => ({ time, lane: 2, group: 0, slot, size: 4 }));

  it('are flown through in their lane for points, and fill the meter', () => {
    const { run } = race([], {
      hoops: [
        { time: 1, lane: 2 },
        { time: 2, lane: 4 },
      ],
    });
    const events = ofType(play(run, 0, 2.5), 'hoop');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ points: POINTS.hoop, streak: 1, bonus: 0 });
    expect(run.hoopTaken(0)).toBe(true);
    expect(run.hoopTaken(1)).toBe(false);
    expect(run.meter).toBeGreaterThan(0);
    expect(run.combo).toBe(1);
  });

  it('earn a streak bonus for every hoop of a phrase in a row', () => {
    const { run } = race([], { hoops: phrase, duration: 8 });
    const events = ofType(play(run, 0, 4.5), 'hoop');
    expect(events.map((e) => e.streak)).toEqual([1, 2, 3, 4]);
    expect(events.map((e) => e.bonus)).toEqual([0, 0, 0, run.multiplier * HOOP_STREAK_BONUS]);
    expect(run.results()).toMatchObject({ hoops: 4, totalHoops: 4, streaks: 1 });
  });

  it('lose the streak when one of the phrase is missed', () => {
    const missed = phrase.map((h, i) => (i === 1 ? { ...h, lane: 0 } : h));
    const { run } = race([], { hoops: missed, duration: 8 });
    const events = ofType(play(run, 0, 4.5), 'hoop');
    expect(events.map((e) => e.bonus)).toEqual([0, 0, 0]);
    expect(events.map((e) => e.streak)).toEqual([1, 0, 0]);
    expect(run.results().streaks).toBe(0);
  });

  it('give a single hoop no streak bonus', () => {
    const { run } = race([], { hoops: [{ time: 1, lane: 2 }] });
    expect(ofType(play(run, 0, 1.5), 'hoop')[0]!.bonus).toBe(0);
  });
});

describe('rankOf', () => {
  it('ranks by timing, pickups taken and crashes', () => {
    expect(rankOf(0.85, 0, 0.95)).toBe('S');
    expect(rankOf(0.85, 1, 0.95)).toBe('A');
    expect(rankOf(0.85, 0, 0.8)).toBe('A');
    expect(rankOf(0.7, 4, 0.8)).toBe('B');
    expect(rankOf(0.6, 0, 0.4)).toBe('C');
    expect(rankOf(null, 0, 1)).toBe('C');
  });

  it('says its rules and the results in words for the shared results screen', () => {
    expect(rankRules()).toContain('crashes');
    const { run } = race();
    play(run, 0, 6.1);
    const summary = summaryOf(run.results());
    expect(summary.columns[0].map((row) => row.name)).toContain('Crashes');
    expect(summary.columns[1].find((row) => row.name === 'Pickups')!.value).toBe('—');
  });
});

describe('TunnelRun autoplay', () => {
  it('races the electronic test song from solveLevel to the end without a crash', () => {
    const song = electroSong();
    const track = generateLevel(buildLevelMap(analyseSamples(song.samples, song.rate)), 'normal');
    const run = new TunnelRun(track);
    run.autoplay = solveLevel(track);
    expect(run.autoplay).not.toBeNull();
    const events: RunEvent[] = [];
    for (let t = run.countInFrom; t <= track.duration + 0.1; t += 1 / 60)
      events.push(...run.update(t, NOTHING));
    expect(run.phase).toBe('finished');
    expect(ofType(events, 'crash')).toHaveLength(0);
    const r = run.results();
    expect(r.crashes).toBe(0);
    expect(r.clean).toBe(r.sections);
    expect(r.pickups).toBeGreaterThan(0);
    expect(run.score).toBeGreaterThan(0);
  }, 60_000);
});
