/** The p-th percentile (0 to 1) of the values, or 0 when there are none. */
export function percentile(values: ArrayLike<number>, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[at]!;
}

export function mean(values: ArrayLike<number>, from = 0, to = values.length): number {
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) sum += values[i]!;
  return sum / (to - from);
}

/** Mean of each value's neighbourhood of `radius` values on either side. */
export function movingAverage(values: ArrayLike<number>, radius: number): Float32Array {
  const n = values.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + values[i]!;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n, i + radius + 1);
    out[i] = (prefix[hi]! - prefix[lo]!) / (hi - lo);
  }
  return out;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
