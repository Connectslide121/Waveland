import { analyseSong, type AnalysedSong } from '../core';
import { composeInWorker, LIBRARY } from '../core/library';
import { games, type GameSession } from '../games';
import './base.css';
import { createSongDetails, type SongDetails } from './song-details';
import { createTitleScreen } from './title-screen';

/**
 * Wire the title screen to the games and the song details: pick a mode and a song, play,
 * and come back from the game's own menu, or from the details with Escape.
 */
export function startApp(root: HTMLElement): void {
  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.hidden = true;
  const canvas = document.createElement('div');
  canvas.className = 'stage__canvas';
  stage.append(canvas);

  let session: GameSession | null = null;
  let details: SongDetails | null = null;

  const openDetails = (song: AnalysedSong) => {
    details?.destroy();
    details = createSongDetails({ song, onBack: backToMenu });
    title.element.hidden = true;
    root.append(details.element);
    details.element.querySelector<HTMLElement>('.crumbs__link')?.focus();
  };

  const title = createTitleScreen({
    games: games.all(),
    analyse: analyseSong,
    onDetails: openDetails,
    library: { songs: LIBRARY, compose: composeInWorker },
    async onPlay(game, song) {
      // Start under the title screen so the game can size itself, then reveal it.
      stage.hidden = false;
      try {
        session = await game.start(song, canvas, backToMenu);
      } catch (error) {
        stage.hidden = true;
        canvas.replaceChildren();
        throw error;
      }
      title.element.hidden = true;
    },
  });

  function backToMenu(): void {
    if (details) {
      details.destroy();
      details = null;
      title.element.hidden = false;
      title.element.querySelector<HTMLElement>('.details-link')?.focus();
    }
    if (session) {
      session.stop();
      session = null;
      canvas.replaceChildren();
      stage.hidden = true;
      title.element.hidden = false;
    }
  }
  document.addEventListener('keydown', (event) => {
    // A running game handles Escape itself (its pause menu).
    if (event.key === 'Escape' && details) backToMenu();
  });

  root.replaceChildren(stage, title.element);
}
