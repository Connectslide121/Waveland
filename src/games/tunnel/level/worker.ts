/// <reference lib="webworker" />
/**
 * The track worker: generating and checking a long song's track takes a moment, so it
 * runs here and the page keeps drawing.
 */
import { generateLevel } from './generate';
import type { TrackWorkerReply, TrackWorkerRequest } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<TrackWorkerRequest>) => {
  const { map, difficulty } = event.data;
  try {
    const reply: TrackWorkerReply = { type: 'done', track: generateLevel(map, difficulty) };
    scope.postMessage(reply);
  } catch (error) {
    const reply: TrackWorkerReply = {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(reply);
  }
};
