import { describe, expect, it } from 'vitest';
import { waveformOf } from './waveform';

describe('waveformOf', () => {
  it('keeps the loudest sample of each slice over all channels, scaled to 1', () => {
    const left = Float32Array.of(0.1, -0.4, 0, 0.2);
    const right = Float32Array.of(0, 0, -0.8, 0);
    const buffer = {
      numberOfChannels: 2,
      sampleRate: 4,
      length: 4,
      getChannelData: (c: number) => (c === 0 ? left : right),
    };
    const wave = waveformOf(buffer, 2);
    expect(wave.step).toBe(0.5);
    expect([...wave.peaks]).toEqual([0.5, 1]);
  });
});
