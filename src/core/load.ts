import { toMono } from './analysis/analyse';
import type { WorkerReply, WorkerRequest } from './analysis/protocol';
import { getAudioContext } from './audio-clock';
import { hashBytes, readCachedAnalysis, writeCachedAnalysis } from './cache';
import type { Song } from './song';
import type { SongAnalysis } from './types';

/** A song with its analysis: what the games start from. */
export interface AnalysedSong extends Song {
  /** SHA-256 of the file, the cache key. */
  hash: string;
  analysis: SongAnalysis;
}

/** Share of the progress bar before the worker starts: reading, hashing and decoding. */
const BEFORE_WORKER = 0.15;

const decoded = new WeakMap<File, Promise<AudioBuffer>>();

/** The song decoded for playback, once per file: analysis and playback share it. */
export function decodeSong(song: Song): Promise<AudioBuffer> {
  let buffer = decoded.get(song.file);
  if (!buffer) {
    buffer = song.file.arrayBuffer().then((bytes) => getAudioContext().decodeAudioData(bytes));
    // A failed decode can be tried again.
    buffer.catch(() => decoded.delete(song.file));
    decoded.set(song.file, buffer);
  }
  return buffer;
}

/** Analyse mono samples in a worker, reporting progress from 0 to 1. */
function analyseInWorker(
  samples: Float32Array,
  sampleRate: number,
  onProgress: (done: number) => void,
): Promise<SongAnalysis> {
  const worker = new Worker(new URL('./analysis/worker.ts', import.meta.url), { type: 'module' });
  return new Promise<SongAnalysis>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'progress') onProgress(reply.done);
      else if (reply.type === 'done') resolve(reply.analysis);
      else reject(new Error(reply.message));
    };
    worker.onerror = (event) => reject(new Error(event.message || 'The analysis worker failed'));
    const request: WorkerRequest = { samples, sampleRate };
    worker.postMessage(request, [samples.buffer as ArrayBuffer]);
  }).finally(() => worker.terminate());
}

/**
 * Analyse a song, or take its analysis from the cache when this exact file was analysed
 * before. Reports progress from 0 to 1 as it goes.
 */
export async function analyseSong(
  song: Song,
  onProgress: (done: number) => void = () => {},
): Promise<AnalysedSong> {
  const bytes = await song.file.arrayBuffer();
  const hash = await hashBytes(bytes);
  const cached = await readCachedAnalysis(hash);
  if (cached) {
    onProgress(1);
    return { ...song, hash, analysis: cached };
  }
  onProgress(0.03);

  const buffer = await decodeSong(song);
  onProgress(BEFORE_WORKER);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
    // A copy, so sending it to the worker leaves the playback buffer intact.
    buffer.getChannelData(i).slice(),
  );
  const analysis = await analyseInWorker(toMono(channels), buffer.sampleRate, (done) =>
    onProgress(BEFORE_WORKER + (1 - BEFORE_WORKER) * done),
  );
  await writeCachedAnalysis(hash, analysis);
  return { ...song, hash, analysis };
}
