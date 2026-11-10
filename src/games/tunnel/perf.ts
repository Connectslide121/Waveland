/**
 * Keeping the tunnel smooth: what each quality level costs. The shared `FrameMonitor`
 * (`src/games/shared/perf.ts`) steps down through them when frames stay over budget.
 */

export interface Quality {
  /** The most device pixels drawn per CSS pixel. */
  maxPixelRatio: number;
  /** Bloom on. */
  bloom: boolean;
  /** How far down the tunnel is drawn, track units: the rings and lane lines it takes. */
  viewAhead: number;
  /** Share of each burst's particles drawn. */
  particles: number;
}

/** From the full look down to the cheapest; the game starts at the first. */
export const QUALITY: readonly Quality[] = [
  { maxPixelRatio: 2, bloom: true, viewAhead: 110, particles: 1 },
  { maxPixelRatio: 1.25, bloom: true, viewAhead: 85, particles: 0.6 },
  { maxPixelRatio: 1, bloom: false, viewAhead: 65, particles: 0.35 },
];
