import * as Phaser from 'phaser';
import {
  AudioClock,
  beatAt,
  beatInBar as beatInBarAt,
  beatsBefore,
  buildLevelMap,
  decodeSong,
  DIFFICULTY_NAMES,
  DisplayLead,
  getBindings,
  getDifficulty,
  getLatencyMs,
  getShowFps,
  onSettingsChange,
  setEffectsLowered,
  shortBinding,
  tempoAt,
  type AnalysedSong,
  type LevelMap,
} from '../../core';
import { openSettings } from '../../shell/settings';
import { palette } from '../../theme/palette';
import type { GameSession } from '../registry';
import { generateLevelInWorker, type BoosterKind, type PlatformerLevel } from './level';
import { Controls } from './controls';
import { solveLevel } from './level/validate';
import type { PlayerInput } from './physics';
import { downloadRecording, RunRecorder } from './recording';
import { musicOf, PlatformerRun, type RunMusic } from './run';
import { PlatformerScene, type FrameState } from './scene';
import { chipBinding } from '../shared';
import { createHud, createPauseMenu, createResultsScreen } from './ui';

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
  /** The kicks and snares accents are judged against. */
  readonly #music: RunMusic;
  /** How far ahead of the heard song each frame is drawn. */
  readonly #lead = new DisplayLead();
  /** Everything the player does, for "Save run data". */
  readonly recorder: RunRecorder;

  constructor(
    readonly song: AnalysedSong,
    readonly map: LevelMap,
    readonly level: PlatformerLevel,
    buffer: AudioBuffer,
    /** Where the game is: mouse buttons play on it. */
    surface: HTMLElement,
    private readonly exit: () => void,
  ) {
    this.#music = musicOf(map.events);
    this.controls = new Controls(window, undefined, surface);
    this.recorder = new RunRecorder(window, surface);
    this.clock = new AudioClock(buffer);
    this.clock.onEnded = () => this.run.finish();
    this.hud = createHud({
      title: song.title,
      tempo: map.tempo,
      duration: level.duration,
      drops: map.drops.map((d) => d.time),
      difficulty: DIFFICULTY_NAMES[level.difficulty],
    });
    this.pause = createPauseMenu({
      onResume: () => this.resume(),
      onRestart: () => this.restart(),
      onSettings: () =>
        openSettings({
          game: 'platformer',
          // A new latency offset applies when the music plays on.
          onClose: () => (this.clock.latencyMs = getLatencyMs()),
        }),
      onQuit: () => this.exit(),
      onSaveRun: () => this.saveRun(),
      bindings: () => this.#bindings,
    });
    this.results = createResultsScreen(`${song.title} · ${DIFFICULTY_NAMES[level.difficulty]}`, {
      onRetry: () => this.restart(),
      onBack: () => this.exit(),
      onSaveRun: () => this.saveRun(),
    });
    this.overlay.className = 'game-overlay';
    this.overlay.append(this.hud.element, this.pause.element, this.results.element);
    document.addEventListener('visibilitychange', this.#hidden);
    this.run = new PlatformerRun(level, map.sections, this.#music);
    this.#state = { time: 0, run: this.run, beatInBar: -1, beatPhase: 0, paused: false };
  }

  /** Presses that play the level by itself, once asked for (dev: `waveland.autoplay()`). */
  #autoplay: Map<number, PlayerInput> | null = null;

  /** Let the level play itself, as the validator found a way through, or stop it. */
  autoplay(on = true): boolean {
    this.#autoplay = on ? (this.#autoplay ?? solveLevel(this.level)) : null;
    this.run.autoplay = this.#autoplay;
    return this.#autoplay !== null;
  }

  /** A fresh run from the top, after a one-bar count-in. */
  begin(): void {
    this.run = new PlatformerRun(this.level, this.map.sections, this.#music);
    this.run.autoplay = this.#autoplay;
    this.scene?.reset();
    this.recorder.begin(this.run.countInFrom);
    this.#seek(this.run.countInFrom);
  }

  /** Save everything recorded this session (every attempt) as a JSON file. */
  saveRun(): void {
    downloadRecording(this.recorder.toRecording(this.song, this.map, this.level));
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
    const from = this.run.phase === 'dying' ? undefined : this.run.holdForResume();
    this.recorder.seek(from ?? this.clock.time, 'resume');
    this.#seek(from);
  }

  /** Called by the scene every frame: move the run on, update the HUD, say what to draw. */
  frame = (): FrameState => {
    const input = this.controls.read();
    if (input.pausePressed) {
      if (this.#paused) this.resume();
      else this.doPause();
    }
    // Drawn for when the frame is seen, not for now: a frame or two later.
    const now = performance.now();
    const lead = this.#lead.frame(now);
    const heard = this.clock.time;
    const time = heard + lead;
    this.run.inputLead = lead;
    if (!this.#paused && !this.#seeking && this.run.phase !== 'finished') {
      const pressed = {
        jump: input.jumpPressed,
        dash: input.dashPressed,
        slam: input.slamPressed,
        overdrive: input.overdrivePressed,
      };
      this.recorder.frame(pressed, input.jumpHeld, heard, time, now, lead, this.#lead.interval);
      const { events, respawn } = this.run.update(time, input);
      this.recorder.update(this.run, events, time);
      this.scene?.effects(events, time, this.run);
      if (respawn) {
        this.scene?.reset();
        const from = this.run.respawn();
        this.recorder.seek(from, 'respawn');
        this.#seek(from);
      }
    }
    // The song ends in the run's update or with the clock's own end.
    if (this.run.phase === 'finished' && !this.results.open) this.#finish();

    const grid = this.level.grid;
    const beats = beatAt(grid, time);
    const beatInBar = beatInBarAt(grid, time);
    // Beats left, never more than the count-in has: the output latency starts the clock a
    // little before the count-in's first beat.
    const { resumeAt, countInBeats } = this.run;
    const countIn =
      this.run.phase === 'countin'
        ? Math.max(1, Math.min(countInBeats, Math.ceil(beatAt(grid, resumeAt) - beats - 1e-6)))
        : null;
    this.hud.update({
      time,
      tempo: tempoAt(grid, time),
      beatInBar,
      score: this.run.score,
      combo: this.run.combo,
      multiplier: this.run.multiplier,
      countIn,
      perf: this.#showFps && this.scene ? this.scene.monitor : null,
      hint: this.#hint(time),
      meter: this.run.meter,
      overdrive: this.#left(this.run.overdrive.from, this.run.overdrive.until, time),
      overdriveKey: chipBinding(this.#bindings, 'overdrive'),
      boosters: this.#boosters(time),
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
    this.recorder.destroy();
    this.pause.destroy();
    this.results.destroy();
    this.#stopSettings();
    setEffectsLowered(false);
    document.removeEventListener('visibilitychange', this.#hidden);
  }

  /** The share of a span of song time left at `t`, or null outside it. */
  #left(from: number, until: number, t: number): number | null {
    return t >= from && t < until ? (until - t) / (until - from) : null;
  }

  /** The boosters for the HUD: each one's share of its time left, or null when off. */
  readonly #boosterState: Record<BoosterKind, number | null> = {
    shield: null,
    magnet: null,
    dash: null,
    rush: null,
  };

  #boosters(t: number): Record<BoosterKind, number | null> {
    const b = this.run.boosters;
    const state = this.#boosterState;
    state.shield = b.shield ? 1 : null;
    state.magnet = this.#left(b.magnetFrom, b.magnetUntil, t);
    state.dash = b.extraDash ? 1 : null;
    state.rush = this.#left(b.rushFrom, b.rushUntil, t);
    return state;
  }

  /**
   * The one-line hint for an ability, from a bar before its first obstacle until the
   * player is past it; once past it alive, never again this session.
   */
  #hint(time: number): string | null {
    const grid = this.level.grid;
    for (const lesson of this.level.lessons) {
      if (this.#learnt.has(lesson.action)) continue;
      if (this.run.phase === 'playing' && time > lesson.end) {
        this.#learnt.add(lesson.action);
        continue;
      }
      if (time >= beatsBefore(grid, lesson.time, 4) && time <= lesson.end)
        return `${shortBinding(this.#bindings[lesson.action])}: ${lesson.action}`;
    }
    return null;
  }

  #finish(): void {
    this.controls.enabled = false;
    this.recorder.finish(this.run);
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
    // At the difficulty picked on the title screen.
    generateLevelInWorker(map, getDifficulty()),
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
