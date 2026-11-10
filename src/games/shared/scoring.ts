import { beatAt, lastAtOrBefore, periodAt, type TempoGrid } from '../../core';

/**
 * What every game's scoring shares: judging an action against the beat or the eighth,
 * the combo's multiplier, overdrive, count-ins and ranks. Pure, no drawing, so each
 * game's run (`PlatformerRun`, `TunnelRun`) and its tests use it as is.
 */

/**
 * An action within this many seconds of a beat, or of the eighth between two beats, is
 * perfect, or good. On fast songs the windows shrink to a share of the eighth
 * (`PERFECT_SHARE`, `GOOD_SHARE`), so not everything is on the grid.
 */
export const PERFECT_WINDOW = 0.05;
export const GOOD_WINDOW = 0.1;
export const PERFECT_SHARE = 0.18;
export const GOOD_SHARE = 0.36;
/** Beats of count-in after a pause: the music rewinds this far and the player waits. */
export const RESUME_BEATS = 2;
/** Beats of count-in before a (re)start: a bar. */
export const BAR_BEATS = 4;
/** Every this many in a row raises the multiplier by one, up to `MAX_MULTIPLIER`. */
export const COMBO_STEP = 8;
export const MAX_MULTIPLIER = 4;
/** Overdrive: lasts this many beats (4 bars), and doubles the score on top of the combo. */
export const OVERDRIVE_BEATS = 16;
export const OVERDRIVE_FACTOR = 2;
/** Activating overdrive within `GOOD_WINDOW` of a downbeat scores this, times the multiplier. */
export const DOWNBEAT_BONUS = 1000;

export type BeatQuality = 'perfect' | 'good' | 'miss';

type Grid = Pick<TempoGrid, 'beats' | 'segments'>;

/** Seconds from `t` to the nearest beat of the grid, at the tempo there. */
export function offBeat(grid: Grid, t: number) {
  const beats = beatAt(grid, t);
  return Math.abs(beats - Math.round(beats)) * periodAt(grid, t);
}

/** Seconds from `t` to the nearest beat or eighth between beats, at the tempo there. */
export function offGrid(grid: Grid, t: number) {
  const eighths = beatAt(grid, t) * 2;
  return (Math.abs(eighths - Math.round(eighths)) * periodAt(grid, t)) / 2;
}

/** How an action at `t` is judged: against the nearest beat or eighth. */
export function judgeAt(grid: Grid, t: number): BeatQuality {
  const eighth = periodAt(grid, t) / 2;
  const off = offGrid(grid, t);
  if (off <= Math.min(PERFECT_WINDOW, PERFECT_SHARE * eighth)) return 'perfect';
  if (off <= Math.min(GOOD_WINDOW, GOOD_SHARE * eighth)) return 'good';
  return 'miss';
}

/** Seconds from `t` to the nearest of the sorted `times`, or Infinity when there are none. */
export function nearest(times: readonly number[], t: number): number {
  const i = lastAtOrBefore(times, t);
  const before = i >= 0 ? t - times[i]! : Infinity;
  const after = i + 1 < times.length ? times[i + 1]! - t : Infinity;
  return Math.min(before, after);
}

export function multiplierOf(combo: number): number {
  return Math.min(MAX_MULTIPLIER, 1 + Math.floor(combo / COMBO_STEP));
}

/** (Perfects + half the goods) / judged actions, 0 to 1, or null when none were judged. */
export function timingOf(perfect: number, good: number, miss: number): number | null {
  const judged = perfect + good + miss;
  return judged > 0 ? (perfect + good / 2) / judged : null;
}

export type Rank = 'S' | 'A' | 'B' | 'C';

/**
 * A rank's thresholds: the least timing, the most faults (deaths in the platformer,
 * crashes in the tunnel) and, when the game counts it, the least share of pickups taken.
 */
export interface RankRule {
  rank: Rank;
  timing: number;
  faults: number;
  pickups?: number;
}

/** The best rank of `rules` (best first) the play meets. Timing null counts as 0. */
export function rankAgainst(
  rules: readonly RankRule[],
  timing: number | null,
  faults: number,
  pickups = 1,
): Rank {
  const t = timing ?? 0;
  return (
    rules.find((r) => t >= r.timing && faults <= r.faults && pickups >= (r.pickups ?? 0))?.rank ??
    'C'
  );
}

const NBSP = String.fromCharCode(160);
const percent = (share: number) => `${Math.round(share * 100)}%+`;

/**
 * The ranks' thresholds in words, for the results screen: "S: timing 85%+, no deaths ·
 * A: timing 70%+, at most 2 deaths · B: timing 50%+ · C: finished. Timing counts a good as
 * half a perfect." `fault` names the faults, plural ("deaths", "crashes").
 */
export function describeRanks(rules: readonly RankRule[], fault: string): string {
  const parts = rules.map(({ rank, timing, faults, pickups }) => {
    if (timing === 0 && !pickups) return `${rank}: finished`;
    const p = pickups ? `, pickups ${percent(pickups)}` : '';
    const f =
      faults === 0
        ? `, no ${fault}`
        : Number.isFinite(faults)
          ? `, at most ${faults} ${fault}`
          : '';
    return `${rank}: timing ${percent(timing)}${p}${f}`;
  });
  // Each rank's rule stays on one line.
  const whole = parts.map((p) => p.replace(/ /g, NBSP));
  return `${whole.join(' · ')}. Timing counts a good as half a perfect.`;
}
