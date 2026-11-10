import { beatAt, curveAt, periodAt, timeOfBeat, type LevelMap } from '../../../core';
import { ANCHOR_X, PLAYER_WIDTH, VIEW_WIDTH } from '../physics';
import type { Gate, Solid, SpikeStrip, TerrainStyle } from './level';

/**
 * The terrain styles: how a stretch's ground looks and moves around its obstacles, from
 * its section's feel. The obstacles themselves (the grammar in `generate.ts`) stay where
 * the music put them; the style only reshapes the plain ground between them:
 *
 * - float (calm parts, breakdowns): the ground becomes wide floating slabs drifting gently
 *   up and down with the melody (the brightness) and the energy;
 * - heave (choruses, and a drop after its set piece): the ground becomes runs of
 *   equaliser columns that heave together with the bass on every beat;
 * - contour and climb (grooves, builds) stay still: their steps are in `generate.ts`.
 *
 * All of it is in the solids' keys, so the physics, and so the validator, sees it exactly
 * as it is drawn. A floating slab settles to its own height while the player steps onto
 * it or off it, so its edges meet what is next to it as the generator built them. A
 * heaving run only rises, so stepping off it is a step down: it settles only where the
 * player steps (or lands) onto it, and not even there when it carries straight on from
 * the stretch before's heaving run.
 *
 * At a change of style the new style starts on the downbeat, in the player's view: the
 * still ground ahead rises or falls from the height the last stretch ended at into its
 * own (over `MORPH_BEATS`), and floating slabs and heaving columns, resting until then,
 * start moving (over `RAMP_BEATS`).
 */

/** How far a floating slab drifts either way, px. */
export const FLOAT_RANGE = 18;
/** Floating slabs are about this many beats wide, with a small gap between them, px. */
const FLOAT_BEATS = 3;
const FLOAT_GAP = 4;
/** The most a heaving column rises on a beat, px. */
export const HEAVE_MAX = 36;
/** A heaving column takes this long to reach each height, s. */
export const HEAVE_EASE = 0.18;
/** The gap between heaving columns, px. */
const HEAVE_GAP = 3;
/**
 * A heaving run's columns differ this little in reach, as a share of it (a gentle wave
 * along the run), so neighbours are never more than a step apart while they move.
 */
const HEAVE_WAVE = 0.1;
const HEAVE_WAVE_PX = 400;
/** A floating slab settles over this many beats either side of the player stepping on or off. */
const FLOAT_SETTLE = 1;
/** A heaving run settles over this many beats before the player steps onto it. */
const HEAVE_SETTLE = 0.5;
const SETTLE_MARGIN = 0.05;
/** At a change of style: still ground reshapes over this many beats, motion starts over these. */
export const MORPH_BEATS = 2;
export const RAMP_BEATS = 2;
/** Keep moving solids' keys this far outside the view, px. */
const VIEW_MARGIN = 120;
/** Narrower plain ground than this stays as it is, px. */
const MIN_RUN = 40;
const MIN_COLUMN = 20;

/** The ground's height limits. */
interface Bounds {
  min: number;
  max: number;
}

export interface TerrainContext {
  map: LevelMap;
  style: TerrainStyle;
  /** Where the player is at song time `t`, and when at `x`. */
  x: (t: number) => number;
  timeAt: (x: number) => number;
  /** The stretch being shaped. */
  start: number;
  end: number;
  /** When this style began: the downbeat of the first stretch built in it. */
  since: number;
  /**
   * For the first stretch in a new style: the height the stretch before ended at, which
   * the ground ahead reshapes from on the downbeat.
   */
  morphFrom?: number;
  /** 1 as planned; smaller when the stretch is being made easier. */
  amount: number;
  /** How far heaving columns rise, px, before `amount`. */
  heave: number;
  /** The stretch before ends on a heaving run that this one's can carry straight on from. */
  heavingIn: boolean;
  bounds: Bounds;
}

const smooth = (k: number) => {
  const c = Math.max(0, Math.min(1, k));
  return c * c * (3 - 2 * c);
};

/** The x-ranges plain ground must keep its height under: spikes, gates and overhangs. */
function anchors(solids: Solid[], spikes: SpikeStrip[], gates: Gate[]): [number, number][] {
  const out: [number, number][] = [];
  for (const s of spikes) out.push([s.x0 - 40, s.x1 + 20]);
  for (const g of gates) out.push([g.x - 60, g.x + 20]);
  for (const s of solids) if (s.kind === 'overhang') out.push([s.x0 - 60, s.x1 + 20]);
  return out.sort((a, b) => a[0] - b[0]);
}

/** A piece of ground minus the anchored ranges: the spans that can move. */
function freeSpans(s: Solid, anchored: [number, number][]): [number, number][] {
  let spans: [number, number][] = [[s.x0, s.x1]];
  for (const [a, b] of anchored) {
    const next: [number, number][] = [];
    for (const [x0, x1] of spans) {
      if (b <= x0 || a >= x1) next.push([x0, x1]);
      else {
        if (a > x0) next.push([x0, a]);
        if (b < x1) next.push([b, x1]);
      }
    }
    spans = next;
  }
  return spans;
}

/** The song times from which a solid at [x0, x1] is in view until it has left it. */
function viewTimes(ctx: TerrainContext, x0: number, x1: number): [number, number] {
  const from = ctx.timeAt(x0 - (VIEW_WIDTH - ANCHOR_X) - VIEW_MARGIN);
  const to = ctx.timeAt(x1 + ANCHOR_X + VIEW_MARGIN);
  return [Math.max(0, from), Math.min(ctx.map.duration, to)];
}

/** Grid beats (and `per` points in each) from `from` to `to`. */
function keyTimes(map: LevelMap, from: number, to: number, per: number): number[] {
  const times: number[] = [];
  const first = Math.floor(beatAt(map, from) * per) / per;
  for (let b = first; ; b += 1 / per) {
    const t = timeOfBeat(map, b);
    if (t > to) break;
    if (t >= from - 1e-9) times.push(t);
  }
  return times;
}

/**
 * How much a moving run moves for the key holding from `t` until `until`: 0 while the
 * player steps on (at `tIn`) or off (at `tOut`) it, rising to 1 a beat away.
 */
function settled(t: number, until: number, edges: number[], settle: number): number {
  let w = 1;
  for (const e of edges) {
    const d = e < t ? t - e : e > until ? e - until : 0;
    w = Math.min(w, smooth((d - SETTLE_MARGIN) / settle));
  }
  return w;
}

/** How far into the style motion is, 0 before its first downbeat, 1 a bar after. */
function ramp(ctx: TerrainContext, t: number): number {
  const beats = beatAt(ctx.map, t) - beatAt(ctx.map, ctx.since);
  return smooth(beats / RAMP_BEATS);
}

/** The height still ground has at `t`: from where the last stretch ended into its own. */
function morphed(ctx: TerrainContext, top: number, t: number): number {
  if (ctx.morphFrom === undefined) return top;
  const beats = beatAt(ctx.map, t) - beatAt(ctx.map, ctx.since);
  return ctx.morphFrom + (top - ctx.morphFrom) * smooth(beats / MORPH_BEATS);
}

const clampTo = (b: Bounds, v: number) => Math.max(b.min, Math.min(b.max, v));

/** Keys for `solid` from `top(t, i)` at `times`, eased over `ease`. */
function withKeys(
  solid: Solid,
  times: number[],
  top: (t: number, i: number) => number,
  ease: number,
): Solid {
  if (times.length === 0) return solid;
  return { ...solid, keys: { times, tops: times.map(top) }, ease };
}

/** Floating slabs in place of a span of ground. */
function floats(ctx: TerrainContext, x0: number, x1: number, top: number): Solid[] {
  const { map } = ctx;
  const t0 = ctx.timeAt(x0);
  const period = periodAt(map, t0);
  const beatWidth = ctx.x(t0 + period) - ctx.x(t0);
  const count = Math.max(1, Math.round((x1 - x0) / (FLOAT_BEATS * beatWidth)));
  const width = (x1 - x0) / count;
  const range = FLOAT_RANGE * ctx.amount;
  const out: Solid[] = [];
  for (let i = 0; i < count; i++) {
    const a = x0 + i * width;
    const b = i === count - 1 ? x1 : a + width - FLOAT_GAP;
    const slab: Solid = { kind: 'float', x0: a, x1: b, top };
    // Each slab its own way: a slow swell, and the melody's brightness lifting it.
    const phase = (a / 97) % (2 * Math.PI);
    const tIn = ctx.timeAt(a - PLAYER_WIDTH);
    const tOut = ctx.timeAt(b);
    const ease = periodAt(map, ctx.timeAt((a + b) / 2));
    const settle = FLOAT_SETTLE * period;
    const times = keyTimes(map, ...viewTimes(ctx, a, b), 1);
    const drift = (t: number) => {
      const beat = beatAt(map, t);
      const bright = curveAt(map.mood.brightness, beat);
      const v = 0.65 * Math.sin((Math.PI * beat) / 4 + phase) + 0.35 * (2 * bright - 1);
      return Math.max(-1, Math.min(1, v));
    };
    out.push(
      withKeys(
        slab,
        times,
        (t, k) => {
          const until = (times[k + 1] ?? t + ease) + ease;
          const w = settled(t, until, [tIn, tOut], settle) * ramp(ctx, t);
          return clampTo(ctx.bounds, morphed(ctx, top, t) + range * w * drift(t));
        },
        ease,
      ),
    );
  }
  return out;
}

/** A heaving column's reach at `x`: a gentle wave along the run, the same for every run. */
const reachAt = (x: number) => 1 - HEAVE_WAVE + HEAVE_WAVE * Math.sin(x / HEAVE_WAVE_PX);

/** Heaving columns in place of a span of ground, one per step of the beat. */
function heaving(
  ctx: TerrainContext,
  x0: number,
  x1: number,
  top: number,
  settleIn: boolean,
): Solid[] {
  const { map } = ctx;
  const t0 = ctx.timeAt(x0);
  const period = periodAt(map, t0);
  const beatWidth = ctx.x(t0 + period) - ctx.x(t0);
  const count = Math.max(1, Math.round((x1 - x0) / beatWidth));
  const width = (x1 - x0) / count;
  if (width < MIN_COLUMN) return [{ kind: 'ground', x0, x1, top }];
  const reach = Math.min(HEAVE_MAX, ctx.heave) * ctx.amount;
  const edges = settleIn ? [ctx.timeAt(x0 - PLAYER_WIDTH)] : [];
  const settle = HEAVE_SETTLE * period;
  // Up with the bass on the beat, most of the way back down by the off-beat.
  const pulse = (t: number) => {
    const beat = beatAt(map, t);
    const k = Math.floor(beat + 1e-6);
    const bass = map.bass[Math.max(0, Math.min(map.bass.length - 1, k))] ?? 0;
    const onBeat = beat - k < 0.25;
    return (0.3 + 0.7 * bass) * (onBeat ? 1 : 0.25);
  };
  const out: Solid[] = [];
  for (let i = 0; i < count; i++) {
    const a = x0 + i * width;
    const b = i === count - 1 ? x1 : a + width - HEAVE_GAP;
    const column: Solid = { kind: 'heave', x0: a, x1: b, top };
    const shape = reachAt((a + b) / 2);
    // Every column of the run keys on the same beats, so they move as one.
    const [from, to] = viewTimes(ctx, x0, x1);
    const times = keyTimes(map, from, to, 2);
    out.push(
      withKeys(
        column,
        times,
        (t, k) => {
          const until = (times[k + 1] ?? t + period / 2) + HEAVE_EASE;
          const w = settled(t, until, edges, settle) * ramp(ctx, t);
          return clampTo(ctx.bounds, morphed(ctx, top, t) + reach * shape * w * pulse(t));
        },
        HEAVE_EASE,
      ),
    );
  }
  return out;
}

/**
 * The stretch's solids in its style: plain ground between the obstacles turned into
 * floating slabs or heaving columns, and still ground ahead reshaping from the last
 * stretch's height on the downbeat of a new style. Ground under spikes, gates and
 * overhangs, slam plates and a fill's steps (`fixed`) keep their height.
 */
export function shapeTerrain(
  ctx: TerrainContext,
  solids: Solid[],
  spikes: SpikeStrip[],
  gates: Gate[],
  fixed: ReadonlySet<Solid>,
): Solid[] {
  const anchored = anchors(solids, spikes, gates);
  const startX = ctx.x(ctx.start);
  const out: Solid[] = [];
  // Still ground the player reaches once it has reshaped, and that is in view on the
  // downbeat, reshapes from the last stretch's height.
  const morphReach = ctx.x(timeOfBeat(ctx.map, beatAt(ctx.map, ctx.since) + MORPH_BEATS) + 0.1);
  const morphLimit = startX + VIEW_WIDTH - ANCHOR_X;
  const reshapes = (x0: number, x1: number, top: number) =>
    ctx.morphFrom !== undefined &&
    Math.abs(top - ctx.morphFrom) >= 0.5 &&
    x0 >= Math.max(morphReach, startX + PLAYER_WIDTH + 8) &&
    x0 <= morphLimit &&
    !anchored.some(([a, b]) => a < x1 && b > x0);
  // Moving ground that doesn't reshape starts at its own height.
  const settledCtx = (x0: number, x1: number, top: number): TerrainContext =>
    reshapes(x0, x1, top) ? ctx : { ...ctx, morphFrom: undefined };
  const still = (s: Solid): Solid => {
    if (!reshapes(s.x0, s.x1, s.top)) return s;
    const times = keyTimes(ctx.map, ctx.since, ctx.timeAt(morphReach), 4);
    return withKeys(
      { ...s, top: ctx.morphFrom! },
      times,
      (t) => morphed(ctx, s.top, t),
      periodAt(ctx.map, ctx.since) / 4,
    );
  };

  for (const s of solids) {
    const moving = ctx.style === 'float' || ctx.style === 'heave';
    if (s.kind !== 'ground' || fixed.has(s) || !moving) {
      out.push(s.kind === 'ground' && !fixed.has(s) ? still(s) : s);
      continue;
    }
    let cursor = s.x0;
    for (const [a, b] of freeSpans(s, anchored)) {
      if (b - a < MIN_RUN) continue;
      if (a > cursor) out.push(still({ ...s, x0: cursor, x1: a }));
      const here = settledCtx(a, b, s.top);
      if (ctx.style === 'float') out.push(...floats(here, a, b, s.top));
      else out.push(...heaving(here, a, b, s.top, !(ctx.heavingIn && Math.abs(a - startX) < 0.5)));
      cursor = b;
    }
    if (cursor < s.x1) out.push(still({ ...s, x0: cursor, x1: s.x1 }));
  }
  return out;
}

/** True when a stretch's last solid is a heaving column at `top` reaching `x`: a run to carry on. */
export function endsHeaving(solids: readonly Solid[], x: number, top: number): boolean {
  for (let i = solids.length - 1; i >= 0 && i >= solids.length - 4; i--) {
    const s = solids[i]!;
    if (s.kind === 'overhang') continue;
    return s.kind === 'heave' && Math.abs(s.x1 - x) < 0.5 && Math.abs(s.top - top) < 0.5;
  }
  return false;
}
