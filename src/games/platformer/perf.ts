/**
 * Keeping the platformer smooth: what each quality level costs. The shared `FrameMonitor`
 * (`src/games/shared/perf.ts`) steps down through them when frames stay over budget.
 */

export interface Quality {
  /** The bloom's resolution, as a share of the screen's. */
  bloomScale: number;
  /** Blur passes of the bloom, each a horizontal and a vertical one. */
  blurSteps: number;
  /** Share of each burst's particles drawn. */
  particles: number;
  /** Points along each faint wave line, and along the drop's big waveforms. */
  wavePoints: number;
  dropWavePoints: number;
}

/** From the full look down to the cheapest; the game starts at the first. */
export const QUALITY: readonly Quality[] = [
  { bloomScale: 0.5, blurSteps: 4, particles: 1, wavePoints: 48, dropWavePoints: 64 },
  { bloomScale: 0.5, blurSteps: 2, particles: 0.6, wavePoints: 32, dropWavePoints: 40 },
  { bloomScale: 0.25, blurSteps: 2, particles: 0.35, wavePoints: 24, dropWavePoints: 28 },
];
