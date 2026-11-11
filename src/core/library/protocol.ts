import type { LibrarySong } from './songs';

/** The sample rate library songs are composed at. */
export const LIBRARY_RATE = 44100;

/** What the page sends the library worker. */
export interface LibraryWorkerRequest {
  song: LibrarySong;
}

/** What the library worker sends back: the song as a WAV file's bytes. */
export type LibraryWorkerReply =
  { type: 'done'; wav: ArrayBuffer } | { type: 'error'; message: string };
