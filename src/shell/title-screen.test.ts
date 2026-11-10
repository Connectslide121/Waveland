import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysedSong, Song, SongAnalysis } from '../core';
import type { GameDefinition, ReadyGame } from '../games';
import { createTitleScreen, type TitleScreen, type TitleScreenOptions } from './title-screen';

const ready: ReadyGame = {
  id: 'platformer',
  name: 'Platformer',
  blurb: 'Run and jump.',
  icon: '<svg></svg>',
  status: 'ready',
  start: vi.fn(),
};
const soon: GameDefinition = {
  id: 'tunnel',
  name: 'Tunnel',
  blurb: 'Race.',
  icon: '<svg></svg>',
  status: 'soon',
  reason: 'Comes after the platformer.',
};

let screen: TitleScreen | null = null;

/** An analysis that finishes at once, as from the cache. */
const instant = async (song: Song): Promise<AnalysedSong> => ({
  ...song,
  hash: 'h',
  analysis: {} as SongAnalysis,
});

/** An analysis the test finishes (or fails) by hand, reporting progress meanwhile. */
function controlled() {
  let progress: (done: number) => void = () => {};
  let finish: (song: AnalysedSong) => void = () => {};
  let fail: (error: Error) => void = () => {};
  let picked: Song | null = null;
  const analyse = vi.fn(
    (song: Song, onProgress: (done: number) => void) =>
      new Promise<AnalysedSong>((resolve, reject) => {
        picked = song;
        progress = onProgress;
        finish = resolve;
        fail = reject;
      }),
  );
  return {
    analyse,
    progress: (done: number) => progress(done),
    finish: () => finish({ ...picked!, hash: 'h', analysis: {} as SongAnalysis }),
    fail: () => fail(new Error('bad file')),
  };
}

function mount(
  onPlay = vi.fn(async () => {}),
  analyse: TitleScreenOptions['analyse'] = instant,
  onDetails = vi.fn(),
) {
  screen = createTitleScreen({ games: [ready, soon], onPlay, analyse, onDetails });
  document.body.append(screen.element);
  const q = <T extends Element>(selector: string) => screen!.element.querySelector<T>(selector)!;
  return {
    onPlay,
    onDetails,
    play: q<HTMLButtonElement>('.play'),
    hint: q<HTMLElement>('.play-row__hint'),
    fileInput: q<HTMLInputElement>('input[type=file]'),
    zone: q<HTMLElement>('.dropzone'),
    meter: q<HTMLElement>('[role=progressbar]'),
    details: q<HTMLButtonElement>('.details-link'),
    radios: [...screen.element.querySelectorAll<HTMLInputElement>('input[name=mode]')],
  };
}

function pick(input: HTMLInputElement, name: string) {
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File(['x'], name, { type: 'audio/mpeg' })],
  });
  input.dispatchEvent(new Event('change'));
}

afterEach(() => {
  screen?.destroy();
  screen = null;
});

describe('title screen', () => {
  it('shows the logo, the tag line and a card per game', () => {
    mount();
    const text = screen!.element.textContent;
    expect(text).toContain('Waveland');
    expect(text).toContain('Every song is a level');
    expect(text).toContain('Platformer');
    expect(text).toContain('Tunnel');
  });

  it('keeps Play disabled and says why until a song is dropped', () => {
    const { play, hint } = mount();
    expect(play.disabled).toBe(true);
    expect(hint.textContent).toBe('Drop a song first');
  });

  it('greys out a soon game with a chip and its reason, and picks the ready one', () => {
    const { radios } = mount();
    const [platformer, tunnel] = radios;
    expect(platformer!.checked).toBe(true);
    expect(tunnel!.disabled).toBe(true);
    const card = tunnel!.closest('.mode')!;
    expect(card.querySelector('.mode__chip')?.textContent).toBe('Soon');
    expect(card.textContent).toContain('Comes after the platformer.');
  });

  it('enables Play once a song is analysed and starts the picked game with it', async () => {
    const { play, fileInput, zone, onPlay } = mount();
    pick(fileInput, 'Midnight Drive.mp3');
    expect(zone.dataset.state).toBe('ready');
    expect(zone.textContent).toContain('Midnight Drive');
    await vi.waitFor(() => expect(play.disabled).toBe(false));

    play.click();
    expect(play.getAttribute('aria-busy')).toBe('true');
    expect(play.disabled).toBe(true);
    await vi.waitFor(() => expect(play.getAttribute('aria-busy')).toBe('false'));
    expect(onPlay).toHaveBeenCalledWith(
      ready,
      expect.objectContaining({ title: 'Midnight Drive', hash: 'h' }),
    );
  });

  it('shows the analysis on a progress bar and holds Play until it is done', async () => {
    const analysis = controlled();
    const { play, hint, fileInput, meter, details } = mount(undefined, analysis.analyse);
    expect(meter.dataset.active).toBe('false');

    pick(fileInput, 'Midnight Drive.mp3');
    expect(meter.dataset.active).toBe('true');
    expect(play.disabled).toBe(true);
    expect(hint.textContent).toBe('Analysing Midnight Drive first');
    expect(details.dataset.shown).toBe('false');

    analysis.progress(0.4);
    expect(meter.getAttribute('aria-valuenow')).toBe('40');

    analysis.finish();
    await vi.waitFor(() => expect(play.disabled).toBe(false));
    expect(meter.dataset.active).toBe('false');
    expect(hint.textContent).toBe('Ready to play Platformer');
  });

  it('offers the song details once the song is analysed', async () => {
    const { fileInput, details, onDetails } = mount();
    expect(details.dataset.shown).toBe('false');
    expect(details.disabled).toBe(true);
    pick(fileInput, 'Midnight Drive.mp3');
    await vi.waitFor(() => expect(details.dataset.shown).toBe('true'));
    details.click();
    expect(onDetails).toHaveBeenCalledWith(expect.objectContaining({ title: 'Midnight Drive' }));
  });

  it('says so when the song could not be analysed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const analysis = controlled();
    const { play, hint, fileInput, zone } = mount(undefined, analysis.analyse);
    pick(fileInput, 'broken.mp3');
    analysis.fail();
    await vi.waitFor(() => expect(zone.dataset.state).toBe('error'));
    expect(zone.textContent).toContain("broken couldn't be read");
    expect(hint.textContent).toBe('Pick a song that can be read');
    expect(play.disabled).toBe(true);
  });

  it('keeps the newest song when an older analysis finishes late', async () => {
    const first = controlled();
    const second = controlled();
    let calls = 0;
    const analyse: TitleScreenOptions['analyse'] = (song, onProgress) =>
      ++calls === 1 ? first.analyse(song, onProgress) : second.analyse(song, onProgress);
    const { fileInput, zone, play } = mount(undefined, analyse);
    pick(fileInput, 'Old.mp3');
    pick(fileInput, 'New.mp3');
    second.finish();
    await vi.waitFor(() => expect(play.disabled).toBe(false));
    first.finish();
    await Promise.resolve();
    expect(zone.textContent).toContain('New');
    expect(zone.textContent).not.toContain('Old');
  });

  it('says so when the file is not a song it can play', () => {
    const { play, fileInput, zone } = mount();
    pick(fileInput, 'cover.png');
    expect(zone.dataset.state).toBe('error');
    expect(zone.textContent).toContain("cover.png can't be played");
    expect(play.disabled).toBe(true);
  });

  it('tells the player when the game could not start', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { play, hint, fileInput } = mount(vi.fn(async () => Promise.reject(new Error('boom'))));
    pick(fileInput, 'a.ogg');
    await vi.waitFor(() => expect(play.disabled).toBe(false));
    play.click();
    await vi.waitFor(() => expect(hint.textContent).toBe("Platformer couldn't start. Try again."));
    expect(play.disabled).toBe(false);
  });
});
