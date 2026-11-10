/**
 * A steady beat grid through tracked beats: the period and a beat time. Shared by the
 * analysis (each tempo segment's tempo) and the level map (the grid the games play on).
 */

/** How far from the guessed period the grid may be, either way, as a share. */
const SEARCH = 0.02;
/** Periods tried across that range. */
const SEARCH_STEPS = 160;
/** A beat further than this share of a period from its grid line is left out of the fit. */
const ON_GRID = 0.2;

export interface GridFit {
  /** A beat of the grid (any one: the fit's beat 0). */
  at: number;
  period: number;
}

/**
 * The grid near `guess` (seconds per beat) that the beats agree on. First the period
 * whose grid most beats line up with (their phases on it add up the most), so a stretch
 * the tracker followed on the off-beats, or a skipped or extra beat, can't tilt it; then
 * a straight line through the beats on that grid, numbered by where they sit on it.
 */
export function fitGrid(beats: number[], guess: number): GridFit {
  const first = beats[0];
  if (first === undefined || beats.length < 2) return { at: first ?? 0, period: guess };
  let best = { period: guess, power: -1, phase: 0 };
  for (let s = -SEARCH_STEPS / 2; s <= SEARCH_STEPS / 2; s++) {
    const period = guess * (1 + (2 * SEARCH * s) / SEARCH_STEPS);
    let re = 0;
    let im = 0;
    for (const t of beats) {
      const a = (2 * Math.PI * (t - first)) / period;
      re += Math.cos(a);
      im += Math.sin(a);
    }
    const power = re * re + im * im;
    if (power > best.power) best = { period, power, phase: Math.atan2(im, re) };
  }
  let period = best.period;
  let at = first + (best.phase / (2 * Math.PI)) * period;
  // Twice: the line's own period numbers the beats a little better the second time.
  for (let pass = 0; pass < 2; pass++) {
    const ks: number[] = [];
    const ts: number[] = [];
    for (const t of beats) {
      const k = Math.round((t - at) / period);
      if (Math.abs(t - at - k * period) <= ON_GRID * period) {
        ks.push(k);
        ts.push(t);
      }
    }
    if (ks.length < 2) break;
    const meanK = ks.reduce((a, b) => a + b, 0) / ks.length;
    const meanT = ts.reduce((a, b) => a + b, 0) / ts.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < ks.length; i++) {
      num += (ks[i]! - meanK) * (ts[i]! - meanT);
      den += (ks[i]! - meanK) ** 2;
    }
    if (den <= 0 || num <= 0) break;
    period = num / den;
    at = meanT - period * meanK;
  }
  return { at, period };
}
