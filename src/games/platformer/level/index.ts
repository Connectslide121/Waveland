import type { Difficulty, LevelMap } from '../../../core';
import type { PlatformerLevel } from './level';
import type { LevelWorkerReply, LevelWorkerRequest } from './protocol';

export * from './generate';
export * from './level';
export * from './validate';

/** Generate a level in a worker, so the page keeps drawing while it is built and checked. */
export function generateLevelInWorker(
  map: LevelMap,
  difficulty: Difficulty,
): Promise<PlatformerLevel> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return new Promise<PlatformerLevel>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<LevelWorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'done') resolve(reply.level);
      else reject(new Error(reply.message));
    };
    worker.onerror = (event) => reject(new Error(event.message || 'The level worker failed'));
    const request: LevelWorkerRequest = { map, difficulty };
    worker.postMessage(request);
  }).finally(() => worker.terminate());
}
