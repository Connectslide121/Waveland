import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysedSong, Song, SongAnalysis } from '../core';
import { LIBRARY, type LibrarySong } from '../core/library/songs';
import type { ReadyGame } from '../games';
import { createTitleScreen, type TitleScreen } from './title-screen';

const game: ReadyGame = {
  id: 'platformer',
  name: 'Platformer',
  blurb: 'Run and jump.',
  icon: '<svg></svg>',
  status: 'ready',
  controls: ['jump'],
  difficulty: { easy: 'Run easy', normal: 'Run normal', hard: 'Run hard' },
  start: vi.fn(),
};

const analyse = async (song: Song): Promise<AnalysedSong> => ({
  ...song,
  hash: 'h',
  analysis: { duration: 200, tempo: 120, beats: [0, 0.5] } as SongAnalysis,
});

let screen: TitleScreen | null = null;
afterEach(() => {
  screen?.destroy();
  screen = null;
});

function mount(compose: (song: LibrarySong) => Promise<File>) {
  screen = createTitleScreen({
    games: [game],
    onPlay: vi.fn(async () => {}),
    analyse,
    onDetails: vi.fn(),
    library: { songs: LIBRARY, compose },
  });
  document.body.append(screen.element);
  const q = <T extends Element>(selector: string) => screen!.element.querySelector<T>(selector)!;
  return {
    toggle: q<HTMLButtonElement>('.library__toggle'),
    list: q<HTMLElement>('.library__list'),
    songs: [...screen.element.querySelectorAll<HTMLButtonElement>('.library__song')],
    play: q<HTMLButtonElement>('.play'),
    hint: q<HTMLElement>('.play-row__hint'),
    zone: q<HTMLElement>('.dropzone'),
  };
}

const wav = (song: LibrarySong) => new File(['x'], `${song.title}.wav`, { type: 'audio/wav' });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the title screen’s song library', () => {
  it('lists every song behind a toggle, with its style, tempo and length', () => {
    const ui = mount(async (song) => wav(song));
    expect(ui.list.hidden).toBe(true);
    expect(ui.toggle.textContent).toContain('20 songs');
    ui.toggle.click();
    expect(ui.list.hidden).toBe(false);
    expect(ui.toggle.getAttribute('aria-expanded')).toBe('true');
    expect(ui.songs).toHaveLength(20);
    expect(ui.songs[0]!.textContent).toContain('Neon Overpass');
    expect(ui.songs[0]!.textContent).toMatch(/Electro · 126 BPM · \d:\d\d/);
  });

  it('composes the picked song and loads it like a dropped file', async () => {
    const compose = vi.fn(async (song: LibrarySong) => wav(song));
    const ui = mount(compose);
    ui.toggle.click();
    ui.songs[8]!.click();
    expect(ui.hint.textContent).toBe('Composing Static Riot');
    expect(ui.play.disabled).toBe(true);
    expect(ui.songs[8]!.getAttribute('aria-busy')).toBe('true');
    await settle();
    await settle();
    expect(compose).toHaveBeenCalledWith(LIBRARY[8]);
    expect(ui.zone.textContent).toContain('Static Riot');
    expect(ui.play.disabled).toBe(false);
    expect(ui.list.hidden).toBe(true);
    expect(ui.songs[8]!.getAttribute('aria-pressed')).toBe('true');
  });

  it('says so when a song can’t be composed, and lets the player try again', async () => {
    const compose = vi
      .fn<(song: LibrarySong) => Promise<File>>()
      .mockRejectedValueOnce(new Error('no worker'))
      .mockImplementation(async (song) => wav(song));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ui = mount(compose);
    ui.toggle.click();
    ui.songs[0]!.click();
    await settle();
    expect(ui.hint.textContent).toContain('could not be composed');
    expect(ui.songs[0]!.disabled).toBe(false);
    ui.songs[0]!.click();
    await settle();
    await settle();
    expect(ui.zone.textContent).toContain('Neon Overpass');
    error.mockRestore();
  });
});
