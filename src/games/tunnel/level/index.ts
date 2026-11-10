import type { Difficulty, LevelMap } from '../../../core';
import type { TrackWorkerReply, TrackWorkerRequest } from './protocol';
import type { TunnelTrack } from './track';

export * from './generate';
export * from './track';
export * from './validate';

/** Generate a track in a worker, so the page keeps drawing while it is built and checked. */
export function generateLevelInWorker(map: LevelMap, difficulty: Difficulty): Promise<TunnelTrack> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return new Promise<TunnelTrack>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<TrackWorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'done') resolve(reply.track);
      else reject(new Error(reply.message));
    };
    worker.onerror = (event) => reject(new Error(event.message || 'The track worker failed'));
    const request: TrackWorkerRequest = { map, difficulty };
    worker.postMessage(request);
  }).finally(() => worker.terminate());
}
