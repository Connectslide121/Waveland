import {
  AudioClock,
  beatAt,
  beatInBar as beatInBarAt,
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
  tempoAt,
  type AnalysedSong,
  type LevelMap,
} from '../../core';
import { openSettings } from '../../shell/settings';
import type { GameSession } from '../registry';
import { chipBinding } from '../shared';
import { GameControls } from '../shared/controls';
import { generateLevelInWorker, solveLevel, type TunnelTrack } from './level';
import type { RacerInput } from './physics';
import { TunnelRun } from './run';
import { TunnelScene, type FrameState } from './scene';
import {
  createHud,
  createPauseMenu,
  createResultsScreen,
  JUDGEMENT_TIME,
  TUNNEL_ACTIONS,
  type Judgement,
} from './ui';

/**
 * One race down the tunnel: the audio clock, the run, the controls and the HTML over the
 * canvas. Every frame it reads the clock and the controls, moves the run on to the clock's
 * time and tells the scene what to draw.
 */
class TunnelSession {
  readonly clock: AudioClock;
  readonly controls: GameControls<(typeof TUNNEL_ACTIONS)[number]>;
  readonly overlay = document.createElement('div');
  readonly hud;
  readonly pause;
  readonly results;
  run: TunnelRun;
  scene: TunnelScene | null = null;

  /** True while the clock is starting from a new place: the run waits for it. */
  #seeking = false;
  #paused = false;
  /** Bumped by every seek, so a slow one finishing late doesn't clear a newer one. */
  #seekId = 0;
  #showFps = getShowFps();
  #bindings = getBindings();
  readonly #stopSettings = onSettingsChange(() => {
    this.#showFps = getShowFps();
    this.#bindings = getBindings();
    this.pause.refresh();
  });
  /** The last judgement shown, and the song time it was made. */
  #judged: { word: Judgement; time: number } | null = null;
  readonly #state: FrameState;
  /** How far ahead of the heard song each frame is drawn. */
  readonly #lead = new DisplayLead();
  /** Presses that race the track by themselves, once asked for (dev: `waveland.autoplay()`). */
  #autoplay: Map<number, RacerInput> | null = null;

  constructor(
    readonly song: AnalysedSong,
    readonly map: LevelMap,
    readonly track: TunnelTrack,
    buffer: AudioBuffer,
    surface: HTMLElement,
    private readonly exit: () => void,
  ) {
    this.controls = new GameControls(TUNNEL_ACTIONS, window, undefined, surface);
    this.clock = new AudioClock(buffer);
    this.clock.onEnded = () => this.run.finish();
    this.hud = createHud({
      title: song.title,
      tempo: map.tempo,
      duration: track.duration,
      drops: map.drops.map((d) => d.time),
      difficulty: DIFFICULTY_NAMES[track.difficulty],
    });
    this.pause = createPauseMenu({
      onResume: () => this.resume(),
      onRestart: () => this.restart(),
      onSettings: () =>
        openSettings({
          game: 'tunnel',
          // A new latency offset applies when the music plays on.
          onClose: () => (this.clock.latencyMs = getLatencyMs()),
        }),
      onQuit: () => this.exit(),
      bindings: () => this.#bindings,
    });
    this.results = createResultsScreen(`${song.title} · ${DIFFICULTY_NAMES[track.difficulty]}`, {
      onRetry: () => this.restart(),
      onBack: () => this.exit(),
    });
    this.overlay.className = 'game-overlay';
    this.overlay.append(this.hud.element, this.pause.element, this.results.element);
    document.addEventListener('visibilitychange', this.#hidden);
    this.run = new TunnelRun(track);
    this.#state = { time: 0, run: this.run, paused: false };
  }

  /** Let the track race itself, as the validator found a way through, or stop it. */
  autoplay(on = true): boolean {
    this.#autoplay = on ? (this.#autoplay ?? solveLevel(this.track)) : null;
    this.run.autoplay = this.#autoplay;
    return this.#autoplay !== null;
  }

  /** A fresh race from the top, after a one-bar count-in. */
  begin(): void {
    this.run = new TunnelRun(this.track);
    this.run.autoplay = this.#autoplay;
    this.#judged = null;
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
    // A short count-in up to where it stopped (or the cut-short count-in again).
    this.#seek(this.run.holdForResume());
  }

  /** Called by the scene every frame: move the run on, update the HUD, say what to draw. */
  frame = (): FrameState => {
    const { pressed, held, pausePressed } = this.controls.read();
    if (pausePressed) {
      if (this.#paused) this.resume();
      else this.doPause();
    }
    // Drawn for when the frame is seen, not for now: a frame or two later.
    const lead = this.#lead.frame(performance.now());
    const time = this.clock.time + lead;
    this.run.inputLead = lead;
    if (!this.#paused && !this.#seeking && this.run.phase !== 'finished') {
      const events = this.run.update(time, {
        leftHeld: held.left,
        rightHeld: held.right,
        leftPressed: pressed.left,
        rightPressed: pressed.right,
        jumpPressed: pressed.jump,
        overdrivePressed: pressed.overdrive,
      });
      for (const e of events) {
        if (e.type === 'beat') this.#judged = { word: e.quality, time };
        else if (e.type === 'crash') this.#judged = { word: e.shield ? 'saved' : 'crash', time };
        else if (e.type === 'hoop') this.#judged = { word: e.bonus > 0 ? 'streak' : 'hoop', time };
        else if (e.type === 'booster') this.#judged = { word: e.kind, time };
      }
      this.scene?.effects(events, this.run);
    }
    // The song ends in the run's update or with the clock's own end.
    if (this.run.phase === 'finished' && !this.results.open) this.#finish();

    const grid = this.track.grid;
    const beats = beatAt(grid, time);
    // Beats left, never more than the count-in has: the output latency starts the clock a
    // little before the count-in's first beat.
    const { resumeAt, countInBeats } = this.run;
    const countIn =
      this.run.phase === 'countin'
        ? Math.max(1, Math.min(countInBeats, Math.ceil(beatAt(grid, resumeAt) - beats - 1e-6)))
        : null;
    const judged = this.#judged;
    const age = judged ? time - judged.time : Infinity;
    this.hud.update({
      time,
      tempo: tempoAt(grid, time),
      beatInBar: beatInBarAt(grid, time),
      score: this.run.score,
      combo: this.run.combo,
      multiplier: this.run.multiplier,
      countIn,
      perf: this.#showFps && this.scene ? this.scene.monitor : null,
      meter: this.run.meter,
      overdrive: this.#left(this.run.overdrive.from, this.run.overdrive.until, time),
      overdriveKey: chipBinding(this.#bindings, 'overdrive'),
      shield: this.run.shield,
      boosters: {
        magnet: this.#left(this.run.magnet.from, this.run.magnet.until, time),
        surge: this.#left(this.run.surge.from, this.run.surge.until, time),
      },
      judgement: judged && age >= 0 && age < JUDGEMENT_TIME ? { word: judged.word, age } : null,
    });
    const state = this.#state;
    state.time = time;
    state.run = this.run;
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

  /** The share of a span of song time left at `t`, or null outside it. */
  #left(from: number, until: number, t: number): number | null {
    return t >= from && t < until ? (until - t) / (until - from) : null;
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
 * Start the tunnel for a song: build its track in a worker and decode the audio, then
 * race until the player quits.
 */
export async function startTunnel(
  song: AnalysedSong,
  container: HTMLElement,
  exit: () => void,
): Promise<GameSession> {
  const map = buildLevelMap(song.analysis);
  const [track, buffer] = await Promise.all([
    // At the difficulty picked on the title screen.
    generateLevelInWorker(map, getDifficulty()),
    decodeSong(song),
  ]);
  const session = new TunnelSession(song, map, track, buffer, container, exit);
  // Effects lowered to keep frames smooth are said in Settings while the game runs.
  const scene = new TunnelScene(track, map, container, session.frame, () =>
    setEffectsLowered(true),
  );
  session.scene = scene;
  // For profiling in dev: the running session, from the browser's console.
  if (import.meta.env.DEV) (globalThis as { waveland?: unknown }).waveland = session;
  container.append(session.overlay);
  session.begin();
  scene.start();
  return {
    stop: () => {
      session.stop();
      scene.destroy();
    },
  };
}
