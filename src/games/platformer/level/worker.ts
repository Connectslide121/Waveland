/// <reference lib="webworker" />
/**
 * The level worker: generating and checking a long song's level takes a second or so,
 * so it runs here and the page keeps drawing.
 */
import { generateLevel } from './generate';
import type { LevelWorkerReply, LevelWorkerRequest } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<LevelWorkerRequest>) => {
  const { map, difficulty } = event.data;
  try {
    const reply: LevelWorkerReply = { type: 'done', level: generateLevel(map, difficulty) };
    scope.postMessage(reply);
  } catch (error) {
    const reply: LevelWorkerReply = {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(reply);
  }
};
