import type { LibraryWorkerReply, LibraryWorkerRequest } from './protocol';
import type { LibrarySong } from './songs';

export * from './songs';

/**
 * Compose a library song in a worker and hand it back as a WAV file named after it, to
 * load like any song the player drops in. The composer and its sounds stay out of the
 * page's own bundle.
 */
export function composeInWorker(song: LibrarySong): Promise<File> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return new Promise<File>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<LibraryWorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'done')
        resolve(new File([reply.wav], `${song.title}.wav`, { type: 'audio/wav' }));
      else reject(new Error(reply.message));
    };
    worker.onerror = (event) => reject(new Error(event.message || 'The library worker failed'));
    const request: LibraryWorkerRequest = { song };
    worker.postMessage(request);
  }).finally(() => worker.terminate());
}
