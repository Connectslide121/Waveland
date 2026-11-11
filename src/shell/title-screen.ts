import {
  AUDIO_ACCEPT,
  beatFit,
  describeTempos,
  DIFFICULTIES,
  DIFFICULTY_NAMES,
  getDifficulty,
  MIN_SONG_SECONDS,
  setDifficulty,
  songFromFile,
  type AnalysedSong,
  type Difficulty,
  type Song,
} from '../core';
import { songSeconds, STYLE_NAMES, type LibrarySong } from '../core/library/songs';
import type { GameDefinition, ReadyGame } from '../games';
import { openSettings } from './settings';
import './title-screen.css';

export interface TitleScreenOptions {
  games: GameDefinition[];
  /** Analyse a picked song (or take it from the cache), reporting progress from 0 to 1. */
  analyse(song: Song, onProgress: (done: number) => void): Promise<AnalysedSong>;
  /** Start the picked game with the song; the Play button shows it's working until this settles. */
  onPlay(game: ReadyGame, song: AnalysedSong): Promise<void>;
  /** Open the song details view for an analysed song. */
  onDetails(song: AnalysedSong): void;
  /** The song library: its songs, and how one is composed into a file to load. */
  library?: { songs: readonly LibrarySong[]; compose(song: LibrarySong): Promise<File> };
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
const GEAR_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const CHEVRON_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
  library,
}: TitleScreenOptions): TitleScreen {
  let song: Song | null = null;
  /** The picked song once analysed; null while it is being analysed or when that failed. */
  let analysed: AnalysedSong | null = null;
  /** Progress of the running analysis, 0 to 1, or null when none runs. */
  let progress: number | null = null;
  /** Why the picked song can't be played, once that's known: no sound in it, or too short. */
  let problem: 'unreadable' | 'empty' | 'short' | null = null;
  let starting = false;
  let selected = games.find((g): g is ReadyGame => g.status === 'ready') ?? null;

  const root = el('main', 'title');
  root.setAttribute('aria-labelledby', 'title-logo');

  const settings = el('button', 'title__settings');
  settings.type = 'button';
  settings.setAttribute('aria-label', 'Settings');
  settings.innerHTML = `${GEAR_ICON}<span>Settings</span>`;
  settings.addEventListener('click', () => openSettings({ game: selected?.id }));

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
    problem = null;
    progress = 0;
    render();
    if (picked.file.size === 0) {
      problem = 'empty';
      progress = null;
      render();
      return;
    }
    try {
      const result = await analyse(picked, (done) => {
        if (id !== pickId) return;
        progress = done;
        renderProgress();
      });
      if (id !== pickId) return;
      if (result.analysis.duration < MIN_SONG_SECONDS) problem = 'short';
      else analysed = result;
    } catch (error) {
      if (id !== pickId) return;
      console.error(error);
      problem = 'unreadable';
    }
    progress = null;
    render();
  };
  const takeFile = (file: File | undefined, listed = false) => {
    if (!file || starting) return;
    if (!listed) fromLibrary = null;
    const picked = songFromFile(file);
    if (picked) {
      song = picked;
      rejected = null;
      void startAnalysis(picked);
    } else {
      // A file that can't be played replaces the song: Play never starts a song not shown.
      rejected = file.name;
      song = null;
      analysed = null;
      problem = null;
      progress = null;
      pickId++;
    }
    render();
  };
  fileInput.addEventListener('change', () => {
    takeFile(fileInput.files?.[0]);
    fileInput.value = '';
  });

  // The library: songs the game writes itself, behind a toggle so the screen stays short.
  // Picking one composes it and loads it like a dropped file.
  let libraryOpen = false;
  /** The library song being composed, the one loaded, and whether the last one failed. */
  let composing: LibrarySong | null = null;
  let fromLibrary: LibrarySong | null = null;
  let composeFailed = false;
  const libraryBox = el('section', 'library');
  libraryBox.setAttribute('aria-label', 'Song library');
  const libraryToggle = el('button', 'library__toggle');
  libraryToggle.type = 'button';
  libraryToggle.setAttribute('aria-expanded', 'false');
  libraryToggle.setAttribute('aria-controls', 'library-list');
  const toggleIcon = el('span', 'library__chevron');
  toggleIcon.innerHTML = CHEVRON_ICON;
  libraryToggle.append(
    el('span', 'library__label', 'Or play one from the library'),
    el('span', 'library__count', `${library?.songs.length ?? 0} songs`),
    toggleIcon,
  );
  const libraryList = el('div', 'library__list');
  libraryList.id = 'library-list';
  libraryList.hidden = true;
  const clock = (seconds: number) =>
    `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  const libraryButtons = (library?.songs ?? []).map((entry) => {
    const button = el('button', 'library__song');
    button.type = 'button';
    button.append(
      el('span', 'library__title', entry.title),
      el(
        'span',
        'library__meta',
        `${STYLE_NAMES[entry.style]} · ${entry.bpm} BPM · ${clock(songSeconds(entry))}`,
      ),
    );
    button.addEventListener('click', () => void pickFromLibrary(entry));
    libraryList.append(button);
    return button;
  });
  libraryToggle.addEventListener('click', () => {
    libraryOpen = !libraryOpen;
    render();
  });
  libraryBox.append(libraryToggle, libraryList);
  async function pickFromLibrary(entry: LibrarySong): Promise<void> {
    if (!library || composing || starting) return;
    composing = entry;
    composeFailed = false;
    render();
    try {
      const file = await library.compose(entry);
      composing = null;
      fromLibrary = entry;
      libraryOpen = false;
      takeFile(file, true);
    } catch (error) {
      console.error(error);
      composing = null;
      composeFailed = true;
      render();
    }
  }

  // Difficulty: a radio group like the level preview's, always shown, with what it means.
  let difficulty = getDifficulty();
  const difficultyRow = el('div', 'difficulty-row');
  const difficultyLabel = el('span', 'difficulty-row__label', 'Difficulty');
  difficultyLabel.id = 'difficulty-label';
  const picker = el('div', 'segmented');
  picker.setAttribute('role', 'radiogroup');
  picker.setAttribute('aria-labelledby', difficultyLabel.id);
  const difficultyAbout = el('p', 'difficulty-row__about');
  difficultyAbout.id = 'difficulty-about';
  picker.setAttribute('aria-describedby', difficultyAbout.id);
  const difficultyButtons = DIFFICULTIES.map((d) => {
    const button = el('button', 'segmented__option', DIFFICULTY_NAMES[d]);
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.addEventListener('click', () => pickDifficulty(d));
    picker.append(button);
    return button;
  });
  picker.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const n = DIFFICULTIES.length;
    const i = (DIFFICULTIES.indexOf(difficulty) + step + n) % n;
    pickDifficulty(DIFFICULTIES[i]!);
    difficultyButtons[i]!.focus();
  });
  difficultyRow.append(difficultyLabel, picker, difficultyAbout);
  function pickDifficulty(next: Difficulty): void {
    difficulty = next;
    setDifficulty(next);
    renderDifficulty();
  }
  function renderDifficulty(): void {
    difficultyButtons.forEach((button, i) => {
      const on = DIFFICULTIES[i] === difficulty;
      button.setAttribute('aria-checked', String(on));
      button.tabIndex = on ? 0 : -1;
      button.disabled = starting;
    });
    // What the difficulty means in the picked game; the line keeps its space without one.
    difficultyAbout.textContent = selected?.difficulty[difficulty] ?? '';
  }

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
  panel.append(modes, zone, ...(library ? [libraryBox] : []), difficultyRow, playRow);
  root.append(floor, settings, head, horizon, panel);

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
    zone.dataset.state = rejected || problem ? 'error' : song ? 'ready' : 'empty';
    if (dragging) {
      zoneMain.textContent = 'Let go to load the song';
      zoneSub.textContent = 'MP3, WAV or OGG';
    } else if (rejected) {
      zoneMain.textContent = `${rejected} can't be played`;
      zoneSub.textContent = 'Pick an MP3, WAV or OGG file instead';
    } else if (song && problem === 'empty') {
      zoneMain.textContent = `${song.file.name} is empty`;
      zoneSub.textContent = 'There is no sound in it. Pick another song';
    } else if (song && problem === 'short') {
      zoneMain.textContent = `${song.file.name} is too short to play`;
      zoneSub.textContent = `Pick a song of at least ${MIN_SONG_SECONDS} seconds`;
    } else if (song && problem) {
      zoneMain.textContent = `${song.file.name} couldn't be read`;
      zoneSub.textContent = 'It may be damaged. Pick another song';
    } else if (song && analysing) {
      zoneMain.textContent = song.title;
      zoneSub.textContent = 'Listening for the beat, the sections and the drops';
    } else if (song) {
      zoneMain.textContent = song.title;
      // The games follow the song's tempo map: say when it changes, or has no clear beat.
      const fit = analysed ? beatFit(analysed.analysis) : 'steady';
      const bpm = Math.round(analysed?.analysis.tempo ?? 120);
      zoneSub.textContent =
        fit === 'none'
          ? `No clear beat · the level keeps ${bpm} BPM`
          : fit === 'loose'
            ? `Loose beat · the level keeps about ${bpm} BPM`
            : fit === 'changing'
              ? `Tempo changes, ${describeTempos(analysed!.analysis.segments)} BPM · the level follows it`
              : 'Drop another song or click to change it';
    } else {
      zoneMain.textContent = 'Drop a song here';
      zoneSub.textContent = 'or choose one from your computer';
    }
    zoneKey.textContent = song && !rejected && !dragging ? 'Change' : 'MP3 · WAV · OGG';
    zone.title = song && !rejected ? song.file.name : '';
    renderProgress();

    libraryToggle.setAttribute('aria-expanded', String(libraryOpen));
    libraryList.hidden = !libraryOpen;
    libraryBox.classList.toggle('library--open', libraryOpen);
    libraryButtons.forEach((button, i) => {
      const entry = library!.songs[i]!;
      button.disabled = starting || composing !== null;
      button.setAttribute('aria-pressed', String(entry === fromLibrary));
      button.setAttribute('aria-busy', String(entry === composing));
    });

    play.disabled = !analysed || !selected || starting || composing !== null;
    play.setAttribute('aria-busy', String(starting));
    playIcon.innerHTML = starting ? SPINNER_ICON : PLAY_ICON;
    hint.classList.toggle('play-row__hint--error', failed || Boolean(problem) || composeFailed);
    if (composing) hint.textContent = `Composing ${composing.title}`;
    else if (composeFailed) hint.textContent = 'That song could not be composed. Try again.';
    else if (!selected) hint.textContent = 'No mode can be played yet';
    else if (!song)
      hint.textContent = library ? 'Drop a song or pick one first' : 'Drop a song first';
    else if (problem) hint.textContent = 'Pick a song that can be played';
    else if (analysing) hint.textContent = `Analysing ${song.title} first`;
    else if (starting) hint.textContent = `Building the level for ${song.title}`;
    else if (failed) hint.textContent = `${selected.name} couldn't start. Try again.`;
    else hint.textContent = `Ready to play ${selected.name}`;

    const canShowDetails = Boolean(analysed);
    details.dataset.shown = String(canShowDetails);
    details.disabled = !canShowDetails || starting;
    details.setAttribute('aria-hidden', String(!canShowDetails));
    details.tabIndex = canShowDetails ? 0 : -1;
    renderDifficulty();
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
