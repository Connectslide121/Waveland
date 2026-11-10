/// <reference lib="webworker" />
/**
 * The analysis worker: takes mono samples, sends progress while it works and the
 * analysis at the end, so the menu keeps animating while a song is analysed.
 */
import { analyseSamples } from './analyse';
import type { WorkerReply, WorkerRequest } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const reply = (message: WorkerReply, transfer: Transferable[] = []) =>
  scope.postMessage(message, transfer);

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { samples, sampleRate } = event.data;
  try {
    let last = -1;
    const analysis = analyseSamples(samples, sampleRate, (done) => {
      // A few dozen updates are plenty for a progress bar.
      if (done - last < 0.02 && done < 1) return;
      last = done;
      reply({ type: 'progress', done });
    });
    const curves = [analysis.energy, analysis.bands.low, analysis.bands.mid, analysis.bands.high];
    reply(
      { type: 'done', analysis },
      curves.map((c) => c.values.buffer as ArrayBuffer),
    );
  } catch (error) {
    reply({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
