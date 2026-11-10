import { BANDS, type Band, type Onset, type SongAnalysis } from '../types';
import { pickOnsets } from './onsets';
import {
  beatEnvelope,
  beatTimes,
  estimatePeriod,
  findDownbeatPhase,
  tempoFromBeats,
  trackBeats,
} from './rhythm';
import { computeFrames } from './spectrum';
import { energyCurves, findStructure } from './structure';

/**
 * Bumped whenever the analysis changes what it finds, so cached results from older
 * versions are ignored and the song is analysed again.
 */
export const ANALYSIS_VERSION = 1;

/** Share of the progress bar the spectrum takes; the rest is quick. */
const SPECTRUM_SHARE = 0.85;

/** Mix any number of channels down to one. */
export function toMono(channels: Float32Array[]): Float32Array {
  const [first, ...rest] = channels;
  if (!first) return new Float32Array(0);
  if (rest.length === 0) return first;
  const mono = new Float32Array(first.length);
  for (const channel of channels)
    for (let i = 0; i < mono.length; i++) mono[i] = mono[i]! + channel[i]!;
  for (let i = 0; i < mono.length; i++) mono[i] = mono[i]! / channels.length;
  return mono;
}

/**
 * Everything the games need from a song, from its mono samples. Pure and synchronous:
 * it runs in the analysis worker, and directly in tests.
 */
export function analyseSamples(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (done: number) => void,
): SongAnalysis {
  const duration = samples.length / sampleRate;
  const frames = computeFrames(samples, sampleRate, (done) => onProgress?.(done * SPECTRUM_SHARE));

  const onsets = Object.fromEntries(
    BANDS.map((band) => [band, pickOnsets(frames.flux[band], frames.rate)]),
  ) as Record<Band, Onset[]>;
  onProgress?.(0.9);

  const envelope = beatEnvelope(frames);
  const period = estimatePeriod(envelope, frames.rate);
  const beatFrames = trackBeats(envelope, period);
  const beats = beatTimes(beatFrames, frames.rate);
  const tempo = tempoFromBeats(beats, (frames.rate * 60) / period);
  const phase = findDownbeatPhase(beatFrames, frames);
  const downbeats = beats.filter((_, i) => i >= phase && (i - phase) % 4 === 0);
  onProgress?.(0.95);

  const { energy, bands } = energyCurves(frames, duration);
  const { sections, drops } = findStructure({ duration, downbeats, onsets, energy, bands });
  onProgress?.(1);

  return { duration, tempo, beats, downbeats, onsets, energy, bands, sections, drops };
}
