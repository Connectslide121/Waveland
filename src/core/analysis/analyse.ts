import { BANDS, type Band, type Onset, type SongAnalysis, type TempoSegment } from '../types';
import { frameTime, pickOnsets } from './onsets';
import { beatEnvelope, beatTimes, findDownbeatPhase, tempoFromBeats, trackBeats } from './rhythm';
import { computeFrames, type Frames } from './spectrum';
import { findFeatures } from './features';
import { melodyCurve } from './melody';
import { energyCurves, findStructure } from './structure';
import { findTempoSegments, framePeriods, refineChanges, type FrameSegment } from './tempo';

/**
 * Bumped whenever the analysis changes what it finds, so cached results from older
 * versions are ignored and the song is analysed again.
 */
export const ANALYSIS_VERSION = 7;

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
  let found = findTempoSegments(envelope, frames.rate);
  let beatFrames = trackBeats(envelope, framePeriods(found, envelope.length));
  const refined = refineChanges(found, beatFrames, frames.rate);
  if (refined !== found) {
    found = refined;
    beatFrames = trackBeats(envelope, framePeriods(found, envelope.length));
  }
  const { segments, beats, downbeats } = tempoMap(found, beatFrames, frames, duration);
  // The tempo the song spends most of its time at.
  const main = segments.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  onProgress?.(0.95);

  const { energy, bands } = energyCurves(frames, duration);
  const { sections, drops } = findStructure({ duration, downbeats, onsets, energy, bands });
  const features = findFeatures({
    duration,
    segments,
    beats,
    downbeats,
    onsets,
    energy,
    bands,
    chroma: (start, end) => meanChroma(frames, start, end),
  });
  const melody = melodyCurve(frames, duration);
  onProgress?.(1);

  return {
    duration,
    tempo: main.tempo,
    segments,
    beats,
    downbeats,
    onsets,
    energy,
    bands,
    sections,
    drops,
    features,
    melody,
  };
}

/** The mean power per pitch class over [start, end). */
function meanChroma(frames: Frames, start: number, end: number): Float32Array {
  const out = new Float32Array(12);
  const from = Math.max(0, Math.floor(start * frames.rate));
  const to = Math.min(frames.count, Math.ceil(end * frames.rate));
  for (let i = from; i < to; i++)
    for (let c = 0; c < 12; c++) out[c] = out[c]! + frames.chroma[i * 12 + c]!;
  if (to > from) for (let c = 0; c < 12; c++) out[c] = out[c]! / (to - from);
  return out;
}

/**
 * The tempo segments in song time, each with its tempo from its own beats, and the
 * downbeats found in each. A later segment starts on the tracked beat at its change.
 */
function tempoMap(
  found: FrameSegment[],
  beatFrames: number[],
  frames: Frames,
  duration: number,
): { segments: TempoSegment[]; beats: number[]; downbeats: number[] } {
  const rate = frames.rate;
  const beats = beatTimes(beatFrames, rate);
  // Where each segment's beats start: the beat nearest its change.
  const firsts = found.map((s, i) => {
    if (i === 0) return 0;
    let best = beatFrames.findIndex((f) => f >= s.from);
    if (best < 0) return beatFrames.length;
    if (best > 0 && s.from - beatFrames[best - 1]! < beatFrames[best]! - s.from) best--;
    return best;
  });
  const segments: TempoSegment[] = [];
  const downbeats: number[] = [];
  found.forEach((s, i) => {
    const first = firsts[i]!;
    const last = firsts[i + 1] ?? beatFrames.length;
    const own = beats.slice(first, last);
    const tempo = tempoFromBeats(own, (rate * 60) / s.period);
    const start = i === 0 ? 0 : (beats[first] ?? frameTime(s.from, rate));
    segments.push({ start, end: duration, tempo, beatPeriod: 60 / tempo });
    const phase = findDownbeatPhase(beatFrames.slice(first, last), frames);
    downbeats.push(...own.filter((_, k) => k >= phase && (k - phase) % 4 === 0));
  });
  // Segments a tracked beat apart at most are one: no beats of their own to time by.
  const merged = segments.filter((s, i) => i === 0 || s.start > segments[i - 1]!.start);
  merged.forEach((s, i) => (s.end = merged[i + 1]?.start ?? duration));
  return { segments: merged, beats, downbeats };
}
