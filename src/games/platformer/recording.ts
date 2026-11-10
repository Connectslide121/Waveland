import { ANALYSIS_VERSION, getAudioContext, getLatencyMs, type LevelMap } from '../../core';
import type { PlatformerLevel } from './level';
import type { PlatformerRun, RunEvent } from './run';

/**
 * A recording of a play, to compare with the music afterwards: the song's analysis and
 * level, the setup (latencies, frame rate, screen) and everything the player did, each
 * press at the song time it was made at. The pause menu and the results screen save it
 * as a JSON file ("Save run data").
 */

/** Bumped when the file's shape changes. */
export const RECORDING_VERSION = 1;

/** The actions a press can be. */
export type RecordedAction = 'jump' | 'release' | 'dash' | 'slam' | 'overdrive';

export interface RecordedPress {
  action: RecordedAction;
  /**
   * The song time heard when the player pressed, from the input event's own timestamp
   * (null for a gamepad, which has no events: then `frame`).
   */
  heard: number | null;
  /** The song time heard at the frame that read it. */
  frame: number;
  /** The song time the run acted on it at: `frame` plus the display lead. */
  run: number;
  /** Which attempt (from 0): a retry starts a new one. */
  attempt: number;
}

/** Something the run did: a judged action, a death, a pickup, with its song time. */
export type RecordedEvent = { t: number; attempt: number } & (
  | Omit<Extract<RunEvent, { type: 'beat' }>, 'x' | 'y'>
  | { type: 'death'; cause: string }
  | { type: 'takeoff' | 'land' | 'dashed' | 'slammed' | 'slamLanded' }
  | { type: 'other'; event: string }
);

/** Where the music played from: a count-in, a respawn, a resume after a pause, a retry. */
export interface RecordedSeek {
  /** The song time the music starts from (before 0 for the first count-in). */
  from: number;
  why: 'begin' | 'respawn' | 'resume';
  attempt: number;
  /** Wall-clock ms since the recording started, to put pauses in order. */
  at: number;
}

export interface Recording {
  version: number;
  recordedAt: string;
  song: { title: string; hash: string; analysisVersion: number };
  setup: {
    userAgent: string;
    screen: { width: number; height: number; devicePixelRatio: number };
    /** The player's latency offset from Settings, ms. */
    latencyMs: number;
    /** What the browser reports, seconds. */
    outputLatency: number | null;
    baseLatency: number | null;
    sampleRate: number | null;
    /** The display's frame interval and the lead drawn ahead of the heard time, seconds. */
    frameInterval: number;
    displayLead: number;
  };
  map: LevelMap;
  level: PlatformerLevel;
  presses: RecordedPress[];
  events: RecordedEvent[];
  seeks: RecordedSeek[];
  results: ReturnType<PlatformerRun['results']>[];
}

/** The moments the run marks with a time, and the event each one becomes. */
const MARKS = [
  ['jumpedAt', 'takeoff'],
  ['landedAt', 'land'],
  ['dashedAt', 'dashed'],
  ['slammedAt', 'slammed'],
  ['slamLandedAt', 'slamLanded'],
] as const;

/** Input events not further back than this belong to the frame that reads them. */
const STALE_INPUT = 0.1;

export class RunRecorder {
  readonly #presses: RecordedPress[] = [];
  readonly #events: RecordedEvent[] = [];
  readonly #seeks: RecordedSeek[] = [];
  readonly #results: Recording['results'] = [];
  readonly #started = performance.now();
  #attempt = -1;
  #marks: Record<(typeof MARKS)[number][0], number> = {
    jumpedAt: -Infinity,
    landedAt: -Infinity,
    dashedAt: -Infinity,
    slammedAt: -Infinity,
    slamLandedAt: -Infinity,
  };
  #jumpHeld = false;
  /** Timestamps (performance ms) of key and mouse presses since the last frame. */
  #inputs: number[] = [];
  #frameInterval = 1 / 60;
  #displayLead = 0;

  readonly #input = (event: Event) => {
    if (event instanceof KeyboardEvent && event.repeat) return;
    this.#inputs.push(event.timeStamp);
  };

  constructor(
    readonly target: Window,
    readonly surface: HTMLElement,
  ) {
    // Passive and in the capture phase: it only notes when presses happen.
    target.addEventListener('keydown', this.#input, { capture: true, passive: true });
    surface.addEventListener('mousedown', this.#input, { capture: true, passive: true });
  }

  destroy(): void {
    this.target.removeEventListener('keydown', this.#input, { capture: true });
    this.surface.removeEventListener('mousedown', this.#input, { capture: true });
  }

  /** A new attempt (the first run or a retry): the music plays from `from`. */
  begin(from: number): void {
    this.#attempt++;
    for (const [mark] of MARKS) this.#marks[mark] = -Infinity;
    this.#jumpHeld = false;
    this.seek(from, 'begin');
  }

  seek(from: number, why: RecordedSeek['why']): void {
    this.#seeks.push({ from, why, attempt: this.#attempt, at: performance.now() - this.#started });
  }

  /**
   * One frame: the presses it read, at `heard` (the clock's time when read, `now` in
   * performance ms) and `run` (the time the run moved on to), and what the run did.
   */
  frame(
    pressed: Record<Exclude<RecordedAction, 'release'>, boolean>,
    jumpHeld: boolean,
    heard: number,
    run: number,
    now: number,
    lead: number,
    interval: number,
  ): void {
    this.#frameInterval = interval;
    this.#displayLead = lead;
    // A key or mouse press's own time, when there is one this frame; else the frame's.
    const stamps = this.#inputs.filter((s) => now - s <= STALE_INPUT * 1000);
    this.#inputs = [];
    const stamp = stamps.at(-1);
    const at = stamp === undefined ? null : heard - (now - stamp) / 1000;
    const attempt = this.#attempt;
    for (const action of ['jump', 'dash', 'slam', 'overdrive'] as const)
      if (pressed[action]) this.#presses.push({ action, heard: at, frame: heard, run, attempt });
    if (this.#jumpHeld && !jumpHeld)
      this.#presses.push({ action: 'release', heard: null, frame: heard, run, attempt });
    this.#jumpHeld = jumpHeld;
  }

  /** What the run did in its last update, at run time `t`. */
  update(run: PlatformerRun, events: RunEvent[], t: number): void {
    const attempt = this.#attempt;
    for (const [mark, type] of MARKS) {
      const at = run[mark];
      if (at !== this.#marks[mark] && Number.isFinite(at))
        this.#events.push({ t: at, attempt, type });
      this.#marks[mark] = at;
    }
    for (const e of events) {
      if (e.type === 'beat') {
        const { action, quality, accent, points } = e;
        this.#events.push({ t, attempt, type: 'beat', action, quality, accent, points });
      } else if (e.type === 'death')
        this.#events.push({ t: run.diedAt, attempt, type: 'death', cause: e.cause });
      else this.#events.push({ t, attempt, type: 'other', event: e.type });
    }
  }

  finish(run: PlatformerRun): void {
    this.#results.push(run.results());
  }

  /** Everything so far, as the file's contents. */
  toRecording(song: { title: string; hash: string }, map: LevelMap, level: PlatformerLevel) {
    // The context the game played through (none where there is no Web Audio, as in tests).
    const context = typeof AudioContext === 'undefined' ? null : getAudioContext();
    const recording: Recording = {
      version: RECORDING_VERSION,
      recordedAt: new Date().toISOString(),
      song: { title: song.title, hash: song.hash, analysisVersion: ANALYSIS_VERSION },
      setup: {
        userAgent: navigator.userAgent,
        screen: {
          width: innerWidth,
          height: innerHeight,
          devicePixelRatio: devicePixelRatio,
        },
        latencyMs: getLatencyMs(),
        outputLatency: context?.outputLatency ?? null,
        baseLatency: context?.baseLatency ?? null,
        sampleRate: context?.sampleRate ?? null,
        frameInterval: this.#frameInterval,
        displayLead: this.#displayLead,
      },
      map,
      level,
      presses: this.#presses,
      events: this.#events,
      seeks: this.#seeks,
      results: this.#results,
    };
    return recording;
  }
}

/** A file name for a recording: the song's title and the time, safe on every system. */
export function recordingName(title: string, at = new Date()): string {
  const safe = title.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'song';
  const two = (n: number) => String(n).padStart(2, '0');
  // Local time, as the player's clock shows it.
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}`;
  return `waveland-run-${safe}-${stamp}.json`;
}

/** Save a recording as a JSON file through the browser's download. */
export function downloadRecording(recording: Recording): void {
  const blob = new Blob([JSON.stringify(recording)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = recordingName(recording.song.title);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
