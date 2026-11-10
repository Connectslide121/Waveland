import type { Difficulty, LevelMap } from '../../../core';
import type { TunnelTrack } from './track';

/** What the page sends the track worker. */
export interface TrackWorkerRequest {
  map: LevelMap;
  difficulty: Difficulty;
}

/** What the track worker sends back. */
export type TrackWorkerReply =
  { type: 'done'; track: TunnelTrack } | { type: 'error'; message: string };
