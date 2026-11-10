import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysedSong, SongAnalysis } from '../core';
import { createSongDetails, formatTime, type SongDetails } from './song-details';

const curve = { step: 0.02, values: new Float32Array(10) };
const analysis: SongAnalysis = {
  duration: 125.25,
  tempo: 127.96,
  beats: [0.5, 1, 1.5, 2],
  downbeats: [0.5],
  onsets: { low: [{ time: 0.5, strength: 1 }], mid: [], high: [] },
  energy: curve,
  bands: { low: curve, mid: curve, high: curve },
  sections: [{ start: 0, end: 125.25, kind: 'main', energy: 0.5 }],
  drops: [{ time: 60, strength: 0.8 }],
};
const song: AnalysedSong = {
  file: new File(['x'], 'Midnight Drive.mp3'),
  title: 'Midnight Drive',
  hash: 'h',
  analysis,
};

let view: SongDetails | null = null;

beforeEach(() => {
  // jsdom draws nothing; the view skips drawing without a 2D context.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  view?.destroy();
  view = null;
  vi.restoreAllMocks();
});

function mount(decode: () => Promise<AudioBuffer> = () => new Promise(() => {})) {
  const onBack = vi.fn();
  view = createSongDetails({ song, onBack, decode });
  document.body.append(view.element);
  const q = <T extends Element>(selector: string) => view!.element.querySelector<T>(selector)!;
  return { onBack, q };
}

describe('formatTime', () => {
  it('shows minutes, seconds and tenths', () => {
    expect(formatTime(0)).toBe('0:00.0');
    expect(formatTime(65.43)).toBe('1:05.4');
    expect(formatTime(-1)).toBe('0:00.0');
    expect(formatTime(59.96)).toBe('1:00.0');
  });
});

describe('song details', () => {
  it('names the song in the breadcrumb, which leads back to the menu', () => {
    const { onBack, q } = mount();
    expect(q('[aria-current=page]').textContent).toBe('Midnight Drive');
    q<HTMLButtonElement>('.crumbs__link').click();
    expect(onBack).toHaveBeenCalled();
  });

  it('shows what the analysis found', () => {
    const { q } = mount();
    const text = q('.stats').textContent;
    expect(text).toContain('128.0BPM');
    expect(text).toContain('2:05.3');
    expect(text).toContain('Drops1');
  });

  it('holds Play and says why while the audio loads', () => {
    const { q } = mount();
    const play = q<HTMLButtonElement>('.transport__play');
    expect(play.disabled).toBe(true);
    expect(play.getAttribute('aria-busy')).toBe('true');
    expect(q('.transport__status').textContent).toBe('Loading the audio');
  });

  it('says so when the audio cannot be played', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { q } = mount(() => Promise.reject(new Error('bad')));
    await vi.waitFor(() =>
      expect(q('.transport__status').textContent).toBe("This file couldn't be played"),
    );
    expect(q<HTMLButtonElement>('.transport__play').disabled).toBe(true);
  });
});
