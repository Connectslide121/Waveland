import { getLatencyMs } from './settings';

/** The parts of an AudioContext the clock uses, so tests can drive it with a fake. */
export type ClockContext = Pick<
  AudioContext,
  'currentTime' | 'destination' | 'state' | 'resume' | 'createBufferSource'
> &
  Partial<Pick<AudioContext, 'outputLatency' | 'baseLatency'>>;

let shared: AudioContext | null = null;

/** The one AudioContext the app plays and decodes with, made on first use. */
export function getAudioContext(): AudioContext {
  shared ??= new AudioContext({ latencyHint: 'interactive' });
  return shared;
}

export interface AudioClockOptions {
  context?: ClockContext;
  /** The player's latency offset in ms; defaults to the saved setting. */
  latencyMs?: number;
}

/**
 * Plays a song and tells where in it the player is. Every game times from `time`, never
 * from frame time: it follows the audio hardware, so visuals and sound can't drift apart.
 */
export class AudioClock {
  readonly buffer: AudioBuffer;
  /** Called when the song plays to its end (not when paused or stopped). */
  onEnded: (() => void) | null = null;
  /** How much later than the browser reports the player hears the sound, in ms. */
  latencyMs: number;

  readonly #context: ClockContext;
  #source: AudioBufferSourceNode | null = null;
  /** Song position when paused, or where the current playback started from. */
  #position = 0;
  /** Context time when the current playback started. */
  #startedAt = 0;

  constructor(buffer: AudioBuffer, { context, latencyMs }: AudioClockOptions = {}) {
    this.buffer = buffer;
    this.#context = context ?? getAudioContext();
    this.latencyMs = latencyMs ?? getLatencyMs();
  }

  get duration(): number {
    return this.buffer.duration;
  }

  get playing(): boolean {
    return this.#source !== null;
  }

  /**
   * The song time the player is hearing now, in seconds: the context's clock minus the
   * output latency the browser reports and the player's own offset, kept within the song.
   */
  get time(): number {
    if (!this.#source) return this.#position;
    const elapsed = this.#context.currentTime - this.#startedAt;
    const latency =
      (this.#context.outputLatency ?? 0) + (this.#context.baseLatency ?? 0) + this.latencyMs / 1000;
    return Math.max(0, Math.min(this.duration, this.#position + elapsed - latency));
  }

  /** Play from a song time (by default, from where it is). */
  async play(from = this.#position): Promise<void> {
    this.#halt();
    if (this.#context.state === 'suspended') await this.#context.resume();
    const source = this.#context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.#context.destination);
    this.#position = Math.max(0, Math.min(this.duration, from));
    this.#startedAt = this.#context.currentTime;
    source.onended = () => {
      // Only the source still playing ends the song; one we stopped ourselves doesn't.
      if (this.#source !== source) return;
      this.#source = null;
      this.#position = this.duration;
      this.onEnded?.();
    };
    this.#source = source;
    source.start(0, this.#position);
  }

  /** Stop where it is; `play()` carries on from there. */
  pause(): void {
    if (!this.#source) return;
    const at = this.#unclampedPosition();
    this.#halt();
    this.#position = at;
  }

  /** Jump to a song time, carrying on playing if it was. */
  async seek(to: number): Promise<void> {
    if (this.playing) await this.play(to);
    else this.#position = Math.max(0, Math.min(this.duration, to));
  }

  /** Stop and go back to the start. */
  stop(): void {
    this.#halt();
    this.#position = 0;
  }

  /** Where playback is in the buffer, without the latency offsets: where to resume from. */
  #unclampedPosition(): number {
    const elapsed = this.#context.currentTime - this.#startedAt;
    return Math.max(0, Math.min(this.duration, this.#position + elapsed));
  }

  #halt(): void {
    const source = this.#source;
    if (!source) return;
    this.#source = null;
    source.onended = null;
    source.stop();
    source.disconnect();
  }
}
