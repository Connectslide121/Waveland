import { AUDIO_ACCEPT, songFromFile, type AnalysedSong, type Song } from '../core';
import type { GameDefinition, ReadyGame } from '../games';
import './title-screen.css';

export interface TitleScreenOptions {
  games: GameDefinition[];
  /** Analyse a picked song (or take it from the cache), reporting progress from 0 to 1. */
  analyse(song: Song, onProgress: (done: number) => void): Promise<AnalysedSong>;
  /** Start the picked game with the song; the Play button shows it's working until this settles. */
  onPlay(game: ReadyGame, song: AnalysedSong): Promise<void>;
  /** Open the song details view for an analysed song. */
  onDetails(song: AnalysedSong): void;
}

export interface TitleScreen {
  element: HTMLElement;
  destroy(): void;
}

/** Bar heights of the waveform horizon, in percent, from the look concept. */
const HORIZON_BARS = [18, 30, 46, 62, 80, 95, 70, 52, 84, 100, 76, 58, 88, 64, 42, 60, 36, 24, 14];

const NOTE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="16" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;
const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>`;
const WAVE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h2M7 8v8M11 4v16M15 7v10M19 10v4M21 12h0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const SPINNER_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" class="spin"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="40 14" stroke-linecap="round"/></svg>`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function modeCard(game: GameDefinition, checked: boolean): HTMLLabelElement {
  const card = el('label', `mode mode--${game.status}`);
  const input = el('input');
  input.type = 'radio';
  input.name = 'mode';
  input.value = game.id;
  input.className = 'visually-hidden';
  input.checked = checked;
  input.disabled = game.status !== 'ready';

  const icon = el('span', 'mode__icon');
  icon.innerHTML = game.icon;

  const text = el('span', 'mode__text');
  text.append(el('span', 'mode__name', game.name), el('span', 'mode__blurb', game.blurb));
  if (game.status === 'soon') {
    text.append(el('span', 'mode__reason', game.reason));
    card.append(el('span', 'mode__chip', 'Soon'));
  }

  card.prepend(input, icon, text);
  return card;
}

export function createTitleScreen({
  games,
  analyse,
  onPlay,
  onDetails,
}: TitleScreenOptions): TitleScreen {
  let song: Song | null = null;
  /** The picked song once analysed; null while it is being analysed or when that failed. */
  let analysed: AnalysedSong | null = null;
  /** Progress of the running analysis, 0 to 1, or null when none runs. */
  let progress: number | null = null;
  let analysisFailed = false;
  let starting = false;
  let selected = games.find((g): g is ReadyGame => g.status === 'ready') ?? null;

  const root = el('main', 'title');
  root.setAttribute('aria-labelledby', 'title-logo');

  const floor = el('div', 'title__floor');
  floor.setAttribute('aria-hidden', 'true');

  const head = el('header', 'title__head');
  const logo = el('h1', 'logo', 'Waveland');
  logo.id = 'title-logo';
  head.append(logo, el('p', 'tag', 'Every song is a level'));

  const horizon = el('div', 'horizon');
  horizon.setAttribute('aria-hidden', 'true');
  HORIZON_BARS.forEach((height, i) => {
    const bar = el('i');
    bar.style.setProperty('--h', `${height}%`);
    bar.style.setProperty('--d', `${-0.05 * i}s`);
    horizon.append(bar);
  });

  // Mode cards: native radios, so the whole card is the target and arrow keys work.
  const modes = el('div', 'modes');
  modes.setAttribute('role', 'radiogroup');
  modes.setAttribute('aria-label', 'Mode');
  for (const game of games) modes.append(modeCard(game, game === selected));
  modes.addEventListener('change', (event) => {
    const id = (event.target as HTMLInputElement).value;
    const game = games.find((g) => g.id === id);
    if (game?.status === 'ready') selected = game;
    render();
  });

  // Song drop zone: a label around the file input, so the whole zone opens the picker.
  const zone = el('label', 'dropzone');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = AUDIO_ACCEPT;
  fileInput.className = 'visually-hidden';
  const zoneIcon = el('span', 'dropzone__icon');
  zoneIcon.innerHTML = NOTE_ICON;
  const zoneText = el('span', 'dropzone__text');
  const zoneMain = el('span', 'dropzone__main');
  const zoneSub = el('span', 'dropzone__sub');
  zoneText.append(zoneMain, zoneSub);
  const zoneKey = el('span', 'dropzone__key');
  // The analysis progress: a bar along the zone's bottom edge, its space always reserved.
  const meter = el('span', 'dropzone__meter');
  meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-label', 'Analysing the song');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  const meterFill = el('span', 'dropzone__meter-fill');
  meter.append(meterFill);
  zone.append(fileInput, zoneIcon, zoneText, zoneKey, meter);

  let rejected: string | null = null;
  /** Bumped per picked song, so a slower earlier analysis can't overwrite a newer one. */
  let pickId = 0;
  const startAnalysis = async (picked: Song) => {
    const id = ++pickId;
    analysed = null;
    analysisFailed = false;
    progress = 0;
    render();
    try {
      const result = await analyse(picked, (done) => {
        if (id !== pickId) return;
        progress = done;
        renderProgress();
      });
      if (id !== pickId) return;
      analysed = result;
    } catch (error) {
      if (id !== pickId) return;
      console.error(error);
      analysisFailed = true;
    }
    progress = null;
    render();
  };
  const takeFile = (file: File | undefined) => {
    if (!file || starting) return;
    const picked = songFromFile(file);
    if (picked) {
      song = picked;
      rejected = null;
      void startAnalysis(picked);
    } else {
      rejected = file.name;
    }
    render();
  };
  fileInput.addEventListener('change', () => {
    takeFile(fileInput.files?.[0]);
    fileInput.value = '';
  });

  // Play row: the button, and next to it why it can't be pressed yet.
  const playRow = el('div', 'play-row');
  const play = el('button', 'play');
  play.type = 'button';
  const playIcon = el('span', 'play__icon');
  play.append(playIcon, el('span', 'play__label', 'Play'));
  const hint = el('p', 'play-row__hint');
  hint.id = 'play-hint';
  hint.setAttribute('aria-live', 'polite');
  play.setAttribute('aria-describedby', hint.id);
  // Song details: always in the row, shown once the song is analysed, so nothing moves.
  const details = el('button', 'details-link');
  details.type = 'button';
  details.setAttribute('aria-label', 'Song details');
  details.innerHTML = `${WAVE_ICON}<span>Song details</span>`;
  details.addEventListener('click', () => {
    if (analysed) onDetails(analysed);
  });
  playRow.append(play, hint, details);

  let failed = false;
  play.addEventListener('click', async () => {
    if (!analysed || !selected || starting) return;
    starting = true;
    failed = false;
    render();
    try {
      await onPlay(selected, analysed);
    } catch (error) {
      console.error(error);
      failed = true;
    } finally {
      starting = false;
      render();
    }
  });

  const panel = el('section', 'title__panel');
  panel.setAttribute('aria-label', 'Pick a mode and a song');
  panel.append(modes, zone, playRow);
  root.append(floor, head, horizon, panel);

  function renderProgress(): void {
    const analysing = progress !== null;
    meter.dataset.active = String(analysing);
    meterFill.style.transform = `scaleX(${progress ?? 0})`;
    if (analysing) meter.setAttribute('aria-valuenow', String(Math.round((progress ?? 0) * 100)));
    else meter.removeAttribute('aria-valuenow');
    meter.setAttribute('aria-hidden', String(!analysing));
  }

  function render(): void {
    const dragging = zone.classList.contains('dropzone--over');
    const analysing = progress !== null;
    const unreadable = !rejected && song && analysisFailed;
    zone.dataset.state = rejected || unreadable ? 'error' : song ? 'ready' : 'empty';
    if (dragging) {
      zoneMain.textContent = 'Let go to load the song';
      zoneSub.textContent = 'MP3, WAV or OGG';
    } else if (rejected) {
      zoneMain.textContent = `${rejected} can't be played`;
      zoneSub.textContent = 'Pick an MP3, WAV or OGG file instead';
    } else if (song && unreadable) {
      zoneMain.textContent = `${song.title} couldn't be read`;
      zoneSub.textContent = 'The file may be damaged. Pick another song';
    } else if (song && analysing) {
      zoneMain.textContent = song.title;
      zoneSub.textContent = 'Listening for the beat, the sections and the drops';
    } else if (song) {
      zoneMain.textContent = song.title;
      zoneSub.textContent = 'Drop another song or click to change it';
    } else {
      zoneMain.textContent = 'Drop a song here';
      zoneSub.textContent = 'or choose one from your computer';
    }
    zoneKey.textContent = song && !rejected && !dragging ? 'Change' : 'MP3 · WAV · OGG';
    zone.title = song && !rejected ? song.file.name : '';
    renderProgress();

    play.disabled = !analysed || !selected || starting;
    play.setAttribute('aria-busy', String(starting));
    playIcon.innerHTML = starting ? SPINNER_ICON : PLAY_ICON;
    hint.classList.toggle('play-row__hint--error', failed || Boolean(unreadable));
    if (!selected) hint.textContent = 'No mode can be played yet';
    else if (!song || rejected) hint.textContent = 'Drop a song first';
    else if (unreadable) hint.textContent = 'Pick a song that can be read';
    else if (analysing) hint.textContent = `Analysing ${song.title} first`;
    else if (starting) hint.textContent = `Building the level for ${song.title}`;
    else if (failed) hint.textContent = `${selected.name} couldn't start. Try again.`;
    else hint.textContent = `Ready to play ${selected.name}`;

    const canShowDetails = Boolean(analysed) && !rejected;
    details.dataset.shown = String(canShowDetails);
    details.disabled = !canShowDetails || starting;
    details.setAttribute('aria-hidden', String(!canShowDetails));
    details.tabIndex = canShowDetails ? 0 : -1;
  }

  // Drop anywhere on the page while the title screen shows; highlight the zone meanwhile.
  let dragDepth = 0;
  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
  const setOver = (over: boolean) => {
    zone.classList.toggle('dropzone--over', over);
    render();
  };
  const onDragEnter = (event: DragEvent) => {
    if (root.hidden || !hasFiles(event)) return;
    event.preventDefault();
    if (dragDepth++ === 0) setOver(true);
  };
  const onDragOver = (event: DragEvent) => {
    if (root.hidden || !hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent) => {
    if (root.hidden || !hasFiles(event)) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      setOver(false);
    }
  };
  const onDrop = (event: DragEvent) => {
    if (root.hidden || !hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    zone.classList.remove('dropzone--over');
    takeFile(event.dataTransfer?.files[0]);
  };
  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);

  render();

  return {
    element: root,
    destroy() {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      root.remove();
    },
  };
}
