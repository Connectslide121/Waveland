import type { Difficulty, LevelMap } from '../../../core';
import type { PlatformerLevel } from './level';

/** What the page sends the level worker. */
export interface LevelWorkerRequest {
  map: LevelMap;
  difficulty: Difficulty;
}

/** What the level worker sends back. */
export type LevelWorkerReply =
  { type: 'done'; level: PlatformerLevel } | { type: 'error'; message: string };
