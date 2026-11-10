/** A song's waveform at a fixed rate: the loudest sample (absolute) of each slice, 0 to 1. */
export interface Waveform {
  /** Seconds per value. */
  step: number;
  peaks: Float32Array;
}

/** The waveform of decoded audio, all channels together, at `perSecond` values a second. */
export function waveformOf(
  buffer: Pick<AudioBuffer, 'numberOfChannels' | 'sampleRate' | 'length' | 'getChannelData'>,
  perSecond = 200,
): Waveform {
  const slice = Math.max(1, Math.round(buffer.sampleRate / perSecond));
  const peaks = new Float32Array(Math.ceil(buffer.length / slice));
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]!);
      const at = (i / slice) | 0;
      if (v > peaks[at]!) peaks[at] = v;
    }
  }
  let loudest = 0;
  for (const p of peaks) if (p > loudest) loudest = p;
  if (loudest > 0) for (let i = 0; i < peaks.length; i++) peaks[i] = peaks[i]! / loudest;
  return { step: slice / buffer.sampleRate, peaks };
}
