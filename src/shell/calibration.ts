/**
 * Audio latency calibration: a metronome plays, the player taps along, and the median
 * of how late the taps land is the offset the audio clock takes off.
 */

/** The metronome's tempo while calibrating. */
export const CALIBRATION_BPM = 100;
/** Clicks to listen to before tapping counts: one bar. */
export const COUNT_IN_CLICKS = 4;
/** Clicks to tap along with. */
export const TAP_CLICKS = 12;
/** At least this many taps have to match a click for a result. */
export const MIN_TAPS = 6;
/** Taps spread wider than this around their median (ms) are too uneven to trust. */
export const MAX_SPREAD_MS = 45;

export type CalibrationResult =
  | { ok: true; latencyMs: number; taps: number; spreadMs: number }
  | { ok: false; reason: 'too-few' | 'uneven'; taps: number };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The latency from taps and the clicks they followed, all in seconds on one clock (the
 * time the player hears, as the audio clock counts it). Each tap counts against its nearest
 * click within half a beat; a click takes one tap at most.
 */
export function latencyFromTaps(taps: number[], clicks: number[]): CalibrationResult {
  const half = 30 / CALIBRATION_BPM;
  const used = new Set<number>();
  const offsets: number[] = [];
  for (const tap of taps) {
    let best = -1;
    for (let i = 0; i < clicks.length; i++) {
      if (used.has(i) || Math.abs(tap - clicks[i]!) > half) continue;
      if (best < 0 || Math.abs(tap - clicks[i]!) < Math.abs(tap - clicks[best]!)) best = i;
    }
    if (best < 0) continue;
    used.add(best);
    offsets.push((tap - clicks[best]!) * 1000);
  }
  if (offsets.length < MIN_TAPS) return { ok: false, reason: 'too-few', taps: offsets.length };
  const latency = median(offsets);
  const spread = median(offsets.map((o) => Math.abs(o - latency)));
  if (spread > MAX_SPREAD_MS) return { ok: false, reason: 'uneven', taps: offsets.length };
  return { ok: true, latencyMs: Math.round(latency), taps: offsets.length, spreadMs: spread };
}

/** The parts of an AudioContext the metronome uses. */
type MetronomeContext = Pick<
  AudioContext,
  'currentTime' | 'destination' | 'createOscillator' | 'createGain' | 'state' | 'resume'
> &
  Partial<Pick<AudioContext, 'outputLatency' | 'baseLatency'>>;

/** A metronome on the audio context: count-in, then the clicks to tap along with. */
export class Metronome {
  /** Context times of every click, count-in first. */
  readonly clicks: number[] = [];
  readonly #nodes: OscillatorNode[] = [];

  constructor(private readonly context: MetronomeContext) {}

  /** How the context's clock maps to what the player hears now (as the audio clock does it). */
  heardTime(eventAge = 0): number {
    const c = this.context;
    return c.currentTime - (c.outputLatency ?? 0) - (c.baseLatency ?? 0) - eventAge;
  }

  async start(): Promise<void> {
    if (this.context.state === 'suspended') await this.context.resume();
    const beat = 60 / CALIBRATION_BPM;
    const first = this.context.currentTime + 0.4;
    for (let i = 0; i < COUNT_IN_CLICKS + TAP_CLICKS; i++) {
      const at = first + i * beat;
      this.clicks.push(at);
      const osc = this.context.createOscillator();
      const gain = this.context.createGain();
      osc.frequency.value = i % 4 === 0 ? 1760 : 1320;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.5, at + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
      osc.connect(gain).connect(this.context.destination);
      osc.start(at);
      osc.stop(at + 0.08);
      this.#nodes.push(osc);
    }
  }

  /** The clicks the player taps along with. */
  get tapClicks(): number[] {
    return this.clicks.slice(COUNT_IN_CLICKS);
  }

  /** Context time the last click ends, to stop listening for taps after it. */
  get end(): number {
    return (this.clicks.at(-1) ?? this.context.currentTime) + 30 / CALIBRATION_BPM;
  }

  stop(): void {
    for (const osc of this.#nodes) {
      try {
        osc.stop();
      } catch {
        // Already stopped.
      }
      osc.disconnect();
    }
    this.#nodes.length = 0;
  }
}
