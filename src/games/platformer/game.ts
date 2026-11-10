import * as Phaser from 'phaser';
import {
  AudioClock,
  buildLevelMap,
  decodeSong,
  getBindings,
  getLatencyMs,
  getShowFps,
  onSettingsChange,
  setEffectsLowered,
  shortBinding,
  type AnalysedSong,
  type LevelMap,
} from '../../core';
import { openSettings } from '../../shell/settings';
import { palette } from '../../theme/palette';
import type { GameSession } from '../registry';
import { generateLevelInWorker, type PlatformerLevel } from './level';
import { Controls } from './controls';
import { PlatformerRun } from './run';
import { PlatformerScene, type FrameState } from './scene';
import { createHud, createPauseMenu, createResultsScreen } from './ui';

/** No difficulty picker yet: every song plays at normal. */
const DIFFICULTY = 'normal';

/**
 * One play of the platformer: the audio clock, the run, the controls and the HTML over
 * the canvas. Every frame it reads the clock and the controls, moves the run on to the
 * clock's time and tells the scene what to draw.
 */
class PlatformerSession {
  readonly clock: AudioClock;
  readonly controls: Controls;
  readonly overlay = document.createElement('div');
  readonly hud;
  readonly pause;
  readonly results;
  run: PlatformerRun;
  scene: PlatformerScene | null = null;

  /** True while the clock is starting from a new place: the run waits for it. */
  #seeking = false;
  #paused = false;
  /** Bumped by every seek, so a slow one finishing late doesn't clear a newer one. */
  #seekId = 0;
  /** Settings: show the frame rate in the HUD, and the controls for the hints. */
  #showFps = getShowFps();
  #bindings = getBindings();
  readonly #stopSettings = onSettingsChange(() => {
    this.#showFps = getShowFps();
    this.#bindings = getBindings();
    this.pause.refresh();
  });
  /** Abilities whose first obstacle the player has got past: their hint is done. */
  readonly #learnt = new Set<string>();
  /** What the scene draws, filled in again every frame. */
  readonly #state: FrameState;

  constructor(
    readonly song: AnalysedSong,
    readonly map: LevelMap,
    readonly level: PlatformerLevel,
    buffer: AudioBuffer,
    /** Where the game is: mouse buttons play on it. */
    surface: HTMLElement,
    private readonly exit: () => void,
  ) {
    this.controls = new Controls(window, undefined, surface);
    this.clock = new AudioClock(buffer);
    this.clock.onEnded = () => this.run.finish();
    this.hud = createHud({
      title: song.title,
      tempo: map.tempo,
      duration: level.duration,
      drops: map.drops.map((d) => d.time),
    });
    this.pause = createPauseMenu({
      onResume: () => this.resume(),
      onRestart: () => this.restart(),
      onSettings: () =>
        openSettings({
          // A new latency offset applies when the music plays on.
          onClose: () => (this.clock.latencyMs = getLatencyMs()),
        }),
      onQuit: () => this.exit(),
      bindings: () => this.#bindings,
    });
    this.results = createResultsScreen(song.title, {
      onRetry: () => this.restart(),
      onBack: () => this.exit(),
    });
    this.overlay.className = 'pf-overlay';
    this.overlay.append(this.hud.element, this.pause.element, this.results.element);
    document.addEventListener('visibilitychange', this.#hidden);
    this.run = new PlatformerRun(level, map.sections);
    this.#state = { time: 0, run: this.run, beatInBar: -1, beatPhase: 0, paused: false };
  }

  /** A fresh run from the top, after a one-bar count-in. */
  begin(): void {
    this.run = new PlatformerRun(this.level, this.map.sections);
    this.scene?.reset();
    this.#seek(this.run.countInFrom);
  }

  restart(): void {
    this.pause.close();
    this.results.close();
    this.#paused = false;
    this.controls.enabled = true;
    this.begin();
  }

  doPause(): void {
    if (this.#paused || this.run.phase === 'finished') return;
    this.#paused = true;
    this.clock.pause();
    this.controls.enabled = false;
    this.pause.show();
  }

  resume(): void {
    if (!this.#paused) return;
    this.pause.close();
    this.#paused = false;
    this.controls.enabled = true;
    // A short count-in up to where it stopped (or the cut-short count-in again); a death
    // plays on.
    this.#seek(this.run.phase === 'dying' ? undefined : this.run.holdForResume());
  }

  /** Called by the scene every frame: move the run on, update the HUD, say what to draw. */
  frame = (): FrameState => {
    const input = this.controls.read();
    if (input.pausePressed) {
      if (this.#paused) this.resume();
      else this.doPause();
    }
    const time = this.clock.time;
    if (!this.#paused && !this.#seeking && this.run.phase !== 'finished') {
      const { events, respawn } = this.run.update(time, input);
      this.scene?.effects(events, time, this.run);
      if (respawn) {
        this.scene?.reset();
        this.#seek(this.run.respawn());
      }
    }
    // The song ends in the run's update or with the clock's own end.
    if (this.run.phase === 'finished' && !this.results.open) this.#finish();

    const beats = (time - this.level.gridStart) / this.level.beatPeriod;
    const index = Math.floor(beats + 1e-6);
    const beatInBar = (((index - this.map.barPhase) % 4) + 4) % 4;
    // Beats left, never more than the count-in has: the output latency starts the clock a
    // little before the count-in's first beat.
    const { resumeAt, countInFrom } = this.run;
    const countInBeats = Math.round((resumeAt - countInFrom) / this.level.beatPeriod);
    const countIn =
      this.run.phase === 'countin'
        ? Math.max(
            1,
            Math.min(countInBeats, Math.ceil((resumeAt - time) / this.level.beatPeriod - 1e-6)),
          )
        : null;
    this.hud.update({
      time,
      beatInBar,
      score: this.run.score,
      combo: this.run.combo,
      multiplier: this.run.multiplier,
      countIn,
      perf: this.#showFps && this.scene ? this.scene.monitor : null,
      hint: this.#hint(time),
    });
    const state = this.#state;
    state.time = time;
    state.run = this.run;
    state.beatInBar = beatInBar;
    state.beatPhase = beats - Math.floor(beats);
    state.paused = this.#paused;
    return state;
  };

  stop(): void {
    this.clock.onEnded = null;
    this.clock.stop();
    this.controls.destroy();
    this.pause.destroy();
    this.results.destroy();
    this.#stopSettings();
    setEffectsLowered(false);
    document.removeEventListener('visibilitychange', this.#hidden);
  }

  /**
   * The one-line hint for an ability, from a bar before its first obstacle until the
   * player is past it; once past it alive, never again this session.
   */
  #hint(time: number): string | null {
    const bar = 4 * this.level.beatPeriod;
    for (const lesson of this.level.lessons) {
      if (this.#learnt.has(lesson.action)) continue;
      if (this.run.phase === 'playing' && time > lesson.end) {
        this.#learnt.add(lesson.action);
        continue;
      }
      if (time >= lesson.time - bar && time <= lesson.end)
        return `${shortBinding(this.#bindings[lesson.action])}: ${lesson.action}`;
    }
    return null;
  }

  #finish(): void {
    this.controls.enabled = false;
    this.results.show(this.run.results());
  }

  /** Switching away from the tab pauses. */
  readonly #hidden = () => {
    if (document.hidden) this.doPause();
  };

  #seek(from?: number): void {
    const id = ++this.#seekId;
    this.#seeking = true;
    this.clock
      .play(from)
      .catch(() => {
        // Audio that can't start (no output device) leaves the clock where it was.
      })
      .finally(() => {
        if (id === this.#seekId) this.#seeking = false;
      });
  }
}

/**
 * Start the platformer for a song: build its level in a worker and decode the audio,
 * then run the game until the player quits.
 */
export async function startPlatformer(
  song: AnalysedSong,
  container: HTMLElement,
  exit: () => void,
): Promise<GameSession> {
  const map = buildLevelMap(song.analysis);
  const [level, buffer] = await Promise.all([
    generateLevelInWorker(map, DIFFICULTY),
    decodeSong(song),
  ]);
  const session = new PlatformerSession(song, map, level, buffer, container, exit);
  // Effects lowered to keep frames smooth are said in Settings while the game runs.
  const scene = new PlatformerScene(level, map, session.frame, () => setEffectsLowered(true));
  session.scene = scene;
  // For profiling in dev: the running session, from the browser's console.
  if (import.meta.env.DEV) (globalThis as { waveland?: unknown }).waveland = session;

  return new Promise((resolve) => {
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: container,
      backgroundColor: palette.night,
      scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
      banner: false,
      scene,
      callbacks: {
        postBoot: () => {
          container.append(session.overlay);
          session.begin();
          resolve({
            stop: () => {
              session.stop();
              game.destroy(true);
            },
          });
        },
      },
    });
  });
}
