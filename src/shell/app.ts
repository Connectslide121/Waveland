import { games, type GameSession } from '../games';
import './base.css';
import { createTitleScreen } from './title-screen';

/** Wire the title screen to the games: pick a mode and a song, play, and come back with Escape. */
export function startApp(root: HTMLElement): void {
  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.hidden = true;
  const canvas = document.createElement('div');
  canvas.className = 'stage__canvas';
  const menu = document.createElement('button');
  menu.type = 'button';
  menu.className = 'stage__menu';
  menu.innerHTML = '<span>Menu</span><kbd>Esc</kbd>';
  stage.append(canvas, menu);

  let session: GameSession | null = null;

  const title = createTitleScreen({
    games: games.all(),
    async onPlay(game, song) {
      // Start under the title screen so the game can size itself, then reveal it.
      stage.hidden = false;
      try {
        session = await game.start(song, canvas);
      } catch (error) {
        stage.hidden = true;
        canvas.replaceChildren();
        throw error;
      }
      title.element.hidden = true;
      menu.focus();
    },
  });

  const backToMenu = () => {
    if (!session) return;
    session.stop();
    session = null;
    canvas.replaceChildren();
    stage.hidden = true;
    title.element.hidden = false;
  };
  menu.addEventListener('click', backToMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') backToMenu();
  });

  root.replaceChildren(stage, title.element);
}
