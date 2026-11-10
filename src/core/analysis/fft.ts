/**
 * A radix-2 FFT for one fixed size, reused frame after frame. Tables are built once;
 * `magnitudes` writes into a caller's array so the analysis loop allocates nothing.
 */
export class Fft {
  readonly size: number;
  readonly #cos: Float64Array;
  readonly #sin: Float64Array;
  readonly #reverse: Uint32Array;
  readonly #re: Float64Array;
  readonly #im: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two`);
    this.size = size;
    this.#cos = new Float64Array(size / 2);
    this.#sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.#cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.#sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    const bits = Math.log2(size);
    this.#reverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.#reverse[i] = r;
    }
    this.#re = new Float64Array(size);
    this.#im = new Float64Array(size);
  }

  /** Magnitudes of bins 0..size/2 of a real frame (already windowed). */
  magnitudes(frame: ArrayLike<number>, out: Float32Array): void {
    const n = this.size;
    const re = this.#re;
    const im = this.#im;
    const rev = this.#reverse;
    for (let i = 0; i < n; i++) {
      re[rev[i]!] = frame[i]!;
      im[i] = 0;
    }
    const cos = this.#cos;
    const sin = this.#sin;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step]!;
          const wi = sin[k * step]!;
          const a = start + k;
          const b = a + half;
          const tr = re[b]! * wr - im[b]! * wi;
          const ti = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
    for (let k = 0; k <= n / 2; k++) out[k] = Math.hypot(re[k]!, im[k]!);
  }
}

/** A Hann window of the given length. */
export function hann(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}
