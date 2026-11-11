/// <reference lib="webworker" />
/**
 * The library worker: writing a four-minute song takes a second or two, so it is
 * composed here and the page keeps drawing. It hands back the song as WAV bytes.
 */
import { wavBytes } from '../analysis/test-songs';
import { composeSong } from './compose';
import { LIBRARY_RATE, type LibraryWorkerReply, type LibraryWorkerRequest } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<LibraryWorkerRequest>) => {
  try {
    const { samples } = composeSong(event.data.song, LIBRARY_RATE);
    const wav = wavBytes(samples, LIBRARY_RATE);
    const reply: LibraryWorkerReply = { type: 'done', wav };
    scope.postMessage(reply, [wav]);
  } catch (error) {
    const reply: LibraryWorkerReply = {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(reply);
  }
};
