/**
 * How many frames after it is drawn a frame reaches the screen: the browser draws it at
 * the next vsync and the display shows it during the one after, so about one and a half.
 */
export const DISPLAY_FRAMES = 1.5;
/** Frame intervals outside these, in seconds, are a hitch or a hidden tab: not measured. */
const SHORTEST_FRAME = 1 / 360;
const LONGEST_FRAME = 1 / 20;
/** How much of each new interval the smoothed one takes in. */
const SMOOTHING = 0.05;

/**
 * How far ahead of the heard song time a game draws, so what reaches the screen matches
 * what is heard then. `AudioClock.time` is the song time heard now, but a frame drawn
 * now is only seen a frame or two later: drawn at the heard time, everything shows where
 * it was that long ago and the player seems to trail the music. The lead follows the
 * display's own frame rate (about 25 ms at 60 Hz, 10 ms at 144 Hz).
 */
export class DisplayLead {
  /** The smoothed frame interval, in seconds; 60 Hz until measured. */
  interval = 1 / 60;
  #last: number | null = null;

  /** Note a frame starting at `now` (ms, `performance.now()`), and return the lead in seconds. */
  frame(now: number): number {
    if (this.#last !== null) {
      const dt = (now - this.#last) / 1000;
      if (dt >= SHORTEST_FRAME && dt <= LONGEST_FRAME)
        this.interval += (dt - this.interval) * SMOOTHING;
    }
    this.#last = now;
    return this.lead;
  }

  /** The lead in seconds. */
  get lead(): number {
    return this.interval * DISPLAY_FRAMES;
  }
}
