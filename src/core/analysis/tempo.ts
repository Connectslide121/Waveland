import { refinePeak } from './onsets';
import {
  autocorrelation,
  beatScores,
  estimatePeriod,
  HALVING_MAX_BPM,
  HALVING_SHARE,
  lagRange,
  MAX_BPM,
  MIN_BPM,
  pulseOf,
  tempoPreference,
} from './rhythm';
import { mean, percentile } from './stats';

/**
 * The tempo map: where a song's tempo changes. The local tempo is read from the
 * autocorrelation of overlapping windows; a Viterbi path through the tempos finds the
 * stretches of steady tempo, paying for every change so a beat's wobble never makes one;
 * then each change is put on the beat where one grid gives way to the other.
 */

/** A stretch of steady tempo, in frames: [from, to), `period` frames per beat. */
export interface FrameSegment {
  from: number;
  to: number;
  period: number;
}

/** The windows the local tempo is read over, and how far apart they start, in seconds. */
const WINDOW_SECONDS = 10;
const HOP_SECONDS = 1.5;
/** Tempos the path can take: this many per octave (about 1.5% apart). */
const STATES_PER_OCTAVE = 48;
/** What the path pays to drift one tempo step, and to jump to another tempo. */
const DRIFT_COST = 0.15;
const CHANGE_COST = 2;
/** A path drifting this many steps from where its stretch started is a change too. */
const MAX_DRIFT_STEPS = 1;
/** What a slower reading keeps of its fit where the octave above carries the pulse too. */
const SLOWER_SHARE = 0.6;
/** Neighbouring stretches closer in tempo than this (as a ratio) are one. */
const SAME_TEMPO = 0.025;
/** Stretches shorter than this join the neighbour nearest their tempo, in seconds. */
const MIN_SEGMENT_SECONDS = 6;
/** How far from the path's change the change can really be, in seconds either side. */
const CHANGE_REACH = WINDOW_SECONDS / 2 + HOP_SECONDS;
/** Beats compared on each side of a change, at most. */
const CHANGE_BEATS = 16;
/** How far a beat may sit from its grid line and still count, in frames. */
const BEAT_SLACK = 2;

/** `ac` at a fractional lag, linearly between its whole lags. */
function at(ac: Float64Array, lag: number): number {
  const i = Math.floor(lag);
  const f = lag - i;
  return (ac[i] ?? 0) * (1 - f) + (ac[i + 1] ?? 0) * f;
}

/** The period in frames nearest `lag` that `x[from, to)` repeats at best. */
function periodNear(x: Float32Array, from: number, to: number, lag: number): number {
  const lo = Math.max(2, Math.floor(lag * (1 - SAME_TEMPO)));
  const hi = Math.ceil(lag * (1 + SAME_TEMPO));
  const ac = autocorrelation(x, from, to, lo, hi);
  let best = Math.round(lag);
  for (let l = lo; l <= hi; l++) if (ac[l]! > ac[best]!) best = l;
  return refinePeak(ac, best);
}

/**
 * The stretches of steady tempo in a beat envelope, in order and covering it. A steady
 * song is one stretch whose period is `estimatePeriod`'s, exactly as without a tempo map.
 */
export function findTempoSegments(env: Float32Array, rate: number): FrameSegment[] {
  const n = env.length;
  const whole = (): FrameSegment[] => [{ from: 0, to: n, period: estimatePeriod(env, rate) }];
  const win = Math.round(WINDOW_SECONDS * rate);
  const hop = Math.round(HOP_SECONDS * rate);
  if (n < 2 * win) return whole();

  const x = pulseOf(env, rate);
  const { minLag, maxLag } = lagRange(rate, win);
  const states = Math.floor(Math.log2(MAX_BPM / MIN_BPM) * STATES_PER_OCTAVE) + 1;
  const bpmOf = (s: number) => MIN_BPM * 2 ** (s / STATES_PER_OCTAVE);
  const lagOf = (s: number) => (rate * 60) / bpmOf(s);
  const count = Math.floor((n - win) / hop) + 1;

  // How well each tempo fits each window: its pulse (against the window's best), leaning
  // toward 120 BPM. Where the faster octave still carries half the pulse it wins, clearly
  // enough that a half-time stretch later on can't pull a whole groove an octave down.
  const fit: Float64Array[] = [];
  for (let w = 0; w < count; w++) {
    const ac = autocorrelation(x, w * hop, w * hop + win, minLag, maxLag);
    let peak = 0;
    for (let l = minLag; l <= maxLag; l++) peak = Math.max(peak, ac[l]!);
    const row = new Float64Array(states);
    if (peak > 0) {
      for (let s = 0; s < states; s++)
        row[s] = (Math.max(0, at(ac, lagOf(s))) / peak) * tempoPreference(bpmOf(s));
      for (let s = 0; s + STATES_PER_OCTAVE < states; s++) {
        const faster = s + STATES_PER_OCTAVE;
        if (bpmOf(faster) > HALVING_MAX_BPM) break;
        if (at(ac, lagOf(faster)) >= HALVING_SHARE * at(ac, lagOf(s))) {
          row[faster] = Math.max(row[faster]!, row[s]!);
          row[s] = row[s]! * SLOWER_SHARE;
        }
      }
    }
    fit.push(row);
  }

  // The Viterbi path: staying costs nothing, drifting a step a little, changing a lot.
  let total = Float64Array.from(fit[0]!);
  const back = new Int32Array(count * states);
  for (let w = 1; w < count; w++) {
    let top = 0;
    for (let s = 1; s < states; s++) if (total[s]! >= total[top]!) top = s;
    const next = new Float64Array(states);
    for (let s = 0; s < states; s++) {
      let best = total[s]!;
      let from = s;
      for (const d of [s - 1, s + 1])
        if (d >= 0 && d < states && total[d]! - DRIFT_COST > best) {
          best = total[d]! - DRIFT_COST;
          from = d;
        }
      if (total[top]! - CHANGE_COST > best) {
        best = total[top]! - CHANGE_COST;
        from = top;
      }
      next[s] = best + fit[w]![s]!;
      back[w * states + s] = from;
    }
    total = next;
  }
  const path = new Int32Array(count);
  let end = 0;
  // The faster reading wins a tie, as in `estimatePeriod`.
  for (let s = 1; s < states; s++) if (total[s]! >= total[end]!) end = s;
  path[count - 1] = end;
  for (let w = count - 1; w > 0; w--) path[w - 1] = back[w * states + path[w]!]!;

  // Runs of the path at one tempo, each change halfway between its windows' centres.
  const centre = (w: number) => w * hop + win / 2;
  const runs: { from: number; to: number; state: number }[] = [];
  let anchor = path[0]!;
  let runFrom = 0;
  for (let w = 1; w <= count; w++) {
    const jump = w < count && Math.abs(path[w]! - anchor) > MAX_DRIFT_STEPS;
    const step = w < count && Math.abs(path[w]! - path[w - 1]!) > 1;
    if (w < count && !jump && !step) continue;
    const states = Array.from(path.subarray(runFrom, w)).sort((a, b) => a - b);
    const to = w < count ? Math.round((centre(w - 1) + centre(w)) / 2) : n;
    runs.push({ from: runs.at(-1)?.to ?? 0, to, state: states[states.length >> 1]! });
    if (w < count) {
      anchor = path[w]!;
      runFrom = w;
    }
  }
  if (runs.length === 1) return whole();

  let segments: FrameSegment[] = runs.map((r) => ({
    from: r.from,
    to: r.to,
    period: periodNear(x, r.from, r.to, lagOf(r.state)),
  }));
  segments = tidy(segments, x, rate);
  if (segments.length === 1) return whole();

  // Each change on the beat where one grid gives way to the other.
  const score = beatScores(env);
  for (let i = 1; i < segments.length; i++) {
    const before = segments[i - 1]!;
    const after = segments[i]!;
    const lo = Math.max(before.from + 1, after.from - Math.round(CHANGE_REACH * rate));
    const hi = Math.min(after.to - 1, after.from + Math.round(CHANGE_REACH * rate));
    const change = changeFrame(score, lo, hi, before.period, after.period);
    before.to = after.from = change;
  }
  // A stretch the changes left too short to trust (a half-time feel the path read as
  // half the tempo for a while, its change found late on the beats) joins the neighbour
  // nearest its tempo, an octave either way counting as the same.
  const short = MIN_SEGMENT_SECONDS * rate;
  const folded = (a: number, b: number) => {
    const r = Math.abs(Math.log(a / b));
    return Math.min(r, Math.abs(r - Math.LN2));
  };
  for (let i = 0; i < segments.length && segments.length > 1;) {
    const s = segments[i]!;
    if (s.to - s.from >= short) {
      i++;
      continue;
    }
    const prev = segments[i - 1];
    const next = segments[i + 1];
    if (prev && (!next || folded(prev.period, s.period) <= folded(next.period, s.period))) {
      prev.to = s.to;
      segments.splice(i, 1);
    } else {
      next!.from = s.from;
      segments.splice(i, 1);
    }
  }
  return segments.length === 1 ? whole() : segments;
}

/** Neighbours at one tempo merged, and stretches too short to trust joined to a neighbour. */
function tidy(segments: FrameSegment[], x: Float32Array, rate: number): FrameSegment[] {
  const ratio = (a: number, b: number) => Math.abs(Math.log(a / b));
  const merge = (list: FrameSegment[], i: number) => {
    const a = list[i]!;
    const b = list[i + 1]!;
    const longer = a.to - a.from >= b.to - b.from ? a : b;
    list.splice(i, 2, {
      from: a.from,
      to: b.to,
      period: periodNear(x, a.from, b.to, longer.period),
    });
  };
  const list = [...segments];
  for (let i = 0; i + 1 < list.length;) {
    if (ratio(list[i]!.period, list[i + 1]!.period) < SAME_TEMPO) merge(list, i);
    else i++;
  }
  const short = MIN_SEGMENT_SECONDS * rate;
  for (;;) {
    let shortest = -1;
    for (let i = 0; i < list.length; i++) {
      const length = list[i]!.to - list[i]!.from;
      if (length < short && (shortest < 0 || length < list[shortest]!.to - list[shortest]!.from))
        shortest = i;
    }
    if (shortest < 0 || list.length === 1) break;
    const s = list[shortest]!;
    const prev = list[shortest - 1];
    const next = list[shortest + 1];
    const intoPrev =
      prev !== undefined &&
      (next === undefined || ratio(prev.period, s.period) <= ratio(next.period, s.period));
    merge(list, intoPrev ? shortest - 1 : shortest);
    // A merge can leave two neighbours at one tempo.
    for (let i = 0; i + 1 < list.length;) {
      if (ratio(list[i]!.period, list[i + 1]!.period) < SAME_TEMPO) merge(list, i);
      else i++;
    }
  }
  return list;
}

/**
 * The frame in [lo, hi] where a grid at `before` frames a beat gives way to one at
 * `after`: both grids drawn from it (back and forth), the one whose beats land on the hits
 * best. Every beat costs half a typical hit, so a slower grid that skips hits loses to the
 * faster one where the music is fast, and a faster grid with empty beats loses where it
 * is slow (a half-time switch reads right both ways).
 */
function changeFrame(
  score: Float32Array,
  lo: number,
  hi: number,
  before: number,
  after: number,
): number {
  const n = score.length;
  // How strong the hit nearest a frame is.
  const near = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let v = 0;
    for (let g = Math.max(0, f - BEAT_SLACK); g <= Math.min(n - 1, f + BEAT_SLACK); g++)
      v = Math.max(v, score[g]!);
    near[f] = v;
  }
  // A typical hit: the mean of the clear peaks around the change.
  const peaks: number[] = [];
  const from = Math.max(1, lo - Math.round(CHANGE_BEATS * before));
  const to = Math.min(n - 1, hi + Math.round(CHANGE_BEATS * after));
  for (let f = from; f < to; f++)
    if (score[f]! > score[f - 1]! && score[f]! >= score[f + 1]!) peaks.push(score[f]!);
  const loud = percentile(peaks, 0.99);
  const typical = mean(peaks.filter((v) => v >= 0.3 * loud));
  const cost = 0.5 * (typical || 1);

  // A grid walked from `c` by `step` frames (back when negative) up to `limit`, each beat
  // settling on a hit within the slack when there is one, so a period a hair off doesn't
  // drift off the hits.
  const walk = (c: number, step: number, limit: number) => {
    let sum = 0;
    for (let t = c + step; step < 0 ? t >= Math.max(0, limit) : t <= Math.min(n - 1, limit);) {
      const f = Math.round(t);
      sum += near[f]! - cost;
      let hit = f;
      for (let g = Math.max(0, f - BEAT_SLACK); g <= Math.min(n - 1, f + BEAT_SLACK); g++)
        if (score[g]! > score[hit]!) hit = g;
      t = (score[hit]! > cost ? hit : t) + step;
    }
    return sum;
  };
  // The same span for every candidate, so their totals compare.
  const start = lo - CHANGE_BEATS * before;
  const stop = hi + CHANGE_BEATS * after;
  let best = lo;
  let bestScore = -Infinity;
  for (let c = lo; c <= hi; c++) {
    const total = near[c]! - cost + walk(c, -before, start) + walk(c, after, stop);
    if (total > bestScore) {
      bestScore = total;
      best = c;
    }
  }
  // Onto the hit itself.
  let hit = best;
  for (let g = Math.max(0, best - BEAT_SLACK); g <= Math.min(n - 1, best + BEAT_SLACK); g++)
    if (score[g]! > score[hit]!) hit = g;
  return hit;
}

/**
 * Each change moved onto the tracked beat where the beat intervals switch from one
 * segment's period to the next one's: grids only a few percent apart both land near the
 * hits for a while, but the intervals between tracked beats tell them apart. Returns the
 * same list when nothing moved.
 */
export function refineChanges(
  segments: FrameSegment[],
  beatFrames: number[],
  rate: number,
): FrameSegment[] {
  if (segments.length === 1 || beatFrames.length < 3) return segments;
  const reach = CHANGE_REACH * rate;
  const misfit = (d: number, p: number) => Math.min(Math.log(d / p) ** 2, Math.log(1.2) ** 2);
  const moved = segments.map((s) => ({ ...s }));
  let changed = false;
  for (let i = 1; i < moved.length; i++) {
    const before = moved[i - 1]!;
    const after = moved[i]!;
    const lo = Math.max(before.from, after.from - reach);
    const hi = Math.min(after.to, after.from + reach);
    // The beats around the change: intervals before beat k keep to `before`, from it on to `after`.
    const first = beatFrames.findIndex((f) => f >= lo);
    let last = beatFrames.length - 1;
    while (last > first && beatFrames[last]! > hi) last--;
    if (first < 0 || last - first < 3) continue;
    let best = -1;
    let bestCost = Infinity;
    for (let k = first + 1; k < last; k++) {
      let cost = 0;
      for (let j = first; j < last; j++) {
        const d = beatFrames[j + 1]! - beatFrames[j]!;
        cost += misfit(d, j < k ? before.period : after.period);
      }
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        best = k;
      }
    }
    const frame = Math.round(beatFrames[best]!);
    if (best < 0 || Math.abs(frame - after.from) <= BEAT_SLACK) continue;
    before.to = after.from = frame;
    changed = true;
  }
  return changed ? moved : segments;
}

/** The period of every frame, from the segments, for `trackBeats`. */
export function framePeriods(segments: FrameSegment[], n: number): number | Float64Array {
  if (segments.length === 1) return segments[0]!.period;
  const periods = new Float64Array(n);
  for (const [i, s] of segments.entries()) {
    // The beat on the change still ends an interval of the tempo before it.
    const from = i === 0 ? 0 : s.from + BEAT_SLACK;
    const to = i === segments.length - 1 ? n : s.to + BEAT_SLACK;
    periods.fill(s.period, from, Math.min(n, to));
  }
  return periods;
}
