/**
 * Keeping the platformer smooth: what each quality level costs, and a monitor that counts
 * how long frames take and steps the quality down when they stay over budget.
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

/** A frame slower than this, ms between frames, is over budget (a little under 60 fps). */
export const FRAME_BUDGET_MS = 19;
/** How long a window of frames lasts before it is judged, ms. */
const WINDOW_MS = 1000;
/** Share of a window's frames over budget that lowers the quality. */
const SLOW_SHARE = 0.5;
/** A gap longer than this is a pause or a hidden tab, not a slow frame, ms. */
const MAX_INTERVAL_MS = 250;
/** How often the shown frame rate and frame time are refreshed, ms. */
const SHOW_EVERY_MS = 500;

/**
 * Counts frames: `frame` with the time since the last one started and the CPU time it
 * took. When most frames of a second are over budget, `onLower` gets the next quality
 * level; the window after a step is skipped, so the change can settle first. It never
 * steps back up during a play, so the look doesn't flicker between levels.
 */
export class FrameMonitor {
  /** Index into `QUALITY`. */
  level = 0;
  /** Frames per second and mean CPU ms per frame, refreshed every half second. */
  fps = 0;
  cpuMs = 0;

  #windowMs = 0;
  #frames = 0;
  #slow = 0;
  #settling = false;
  #shownMs = 0;
  #shownFrames = 0;
  #shownCpu = 0;

  constructor(private readonly onLower: (level: number) => void = () => {}) {}

  frame(intervalMs: number, cpuMs: number): void {
    if (!(intervalMs > 0) || intervalMs > MAX_INTERVAL_MS) {
      this.reset();
      return;
    }
    this.#shownMs += intervalMs;
    this.#shownFrames++;
    this.#shownCpu += cpuMs;
    if (this.#shownMs >= SHOW_EVERY_MS) {
      this.fps = (1000 * this.#shownFrames) / this.#shownMs;
      this.cpuMs = this.#shownCpu / this.#shownFrames;
      this.#shownMs = this.#shownFrames = this.#shownCpu = 0;
    }

    this.#windowMs += intervalMs;
    this.#frames++;
    if (intervalMs > FRAME_BUDGET_MS) this.#slow++;
    if (this.#windowMs < WINDOW_MS) return;
    const slow = this.#slow / this.#frames >= SLOW_SHARE;
    const settling = this.#settling;
    this.#windowMs = this.#frames = this.#slow = 0;
    this.#settling = false;
    if (slow && !settling && this.level < QUALITY.length - 1) {
      this.level++;
      this.#settling = true;
      this.onLower(this.level);
    }
  }

  /** Start a new window: after a pause, a seek or a hidden tab. */
  reset(): void {
    this.#windowMs = this.#frames = this.#slow = 0;
    this.#shownMs = this.#shownFrames = this.#shownCpu = 0;
  }
}
