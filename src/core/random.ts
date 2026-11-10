/** Seeded randomness, so the same song always builds the same level. */

/** A 32-bit hash of any number of numbers or strings (FNV-1a over their text). */
export function hashOf(...parts: (number | string)[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const text = typeof part === 'number' ? part.toFixed(6) : part;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    // A separator, so ('ab', 'c') and ('a', 'bc') differ.
    h ^= 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A seeded random number generator (mulberry32). */
export class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** A number from 0 (inclusive) to 1 (exclusive). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  }

  /** A number from `min` to `max`. */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** A whole number from `min` to `max`, both included. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** One of the options, picked by weight. */
  weighted<T>(options: readonly (readonly [T, number])[]): T {
    const total = options.reduce((sum, [, w]) => sum + Math.max(0, w), 0);
    let r = this.next() * total;
    for (const [value, w] of options) {
      r -= Math.max(0, w);
      if (r < 0) return value;
    }
    return options[options.length - 1]![0];
  }
}
