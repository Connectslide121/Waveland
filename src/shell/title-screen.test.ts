import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameDefinition, ReadyGame } from '../games';
import { createTitleScreen, type TitleScreen } from './title-screen';

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

function mount(onPlay = vi.fn(async () => {})) {
  screen = createTitleScreen({ games: [ready, soon], onPlay });
  document.body.append(screen.element);
  const q = <T extends Element>(selector: string) => screen!.element.querySelector<T>(selector)!;
  return {
    onPlay,
    play: q<HTMLButtonElement>('.play'),
    hint: q<HTMLElement>('.play-row__hint'),
    fileInput: q<HTMLInputElement>('input[type=file]'),
    zone: q<HTMLElement>('.dropzone'),
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

  it('enables Play once a song is picked and starts the picked game with it', async () => {
    const { play, fileInput, zone, onPlay } = mount();
    pick(fileInput, 'Midnight Drive.mp3');
    expect(zone.dataset.state).toBe('ready');
    expect(zone.textContent).toContain('Midnight Drive');
    expect(play.disabled).toBe(false);

    play.click();
    expect(play.getAttribute('aria-busy')).toBe('true');
    expect(play.disabled).toBe(true);
    await vi.waitFor(() => expect(play.getAttribute('aria-busy')).toBe('false'));
    expect(onPlay).toHaveBeenCalledWith(
      ready,
      expect.objectContaining({ title: 'Midnight Drive' }),
    );
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
    play.click();
    await vi.waitFor(() => expect(hint.textContent).toBe("Platformer couldn't start. Try again."));
    expect(play.disabled).toBe(false);
  });
});
