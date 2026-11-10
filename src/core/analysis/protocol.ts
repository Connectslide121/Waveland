import type { SongAnalysis } from '../types';

/** What the page sends the analysis worker. */
export interface WorkerRequest {
  samples: Float32Array;
  sampleRate: number;
}

/** What the analysis worker sends back: progress, then the analysis or an error. */
export type WorkerReply =
  | { type: 'progress'; done: number }
  | { type: 'done'; analysis: SongAnalysis }
  | { type: 'error'; message: string };
