import type { AnalysedSong, ControlAction } from '../core';

/**
 * A running game. The game owns its keys, Escape included (for its own pause menu), and
 * calls the `exit` it was started with to go back to the menu; the shell then stops it.
 */
export interface GameSession {
  stop(): void;
}

interface GameBase {
  /** Stable id, also the folder name under `src/games/`. */
  id: string;
  name: string;
  /** One short line for the mode card. */
  blurb: string;
  /** Inline SVG markup for the mode card, drawn in the palette. */
  icon: string;
  /** The control actions the game uses, in the order Settings and its pause menu list them. */
  controls: readonly ControlAction[];
}

/** A game the player can start. */
export interface ReadyGame extends GameBase {
  status: 'ready';
  /**
   * Start the game for a song inside the container; resolves once it is running. The game
   * calls `exit` when the player quits to the menu.
   */
  start(song: AnalysedSong, container: HTMLElement, exit: () => void): Promise<GameSession>;
}

/** A game that is shown but can't be played yet. */
export interface SoonGame extends GameBase {
  status: 'soon';
  /** Why it can't be played yet, in plain words for the mode card. */
  reason: string;
}

export type GameDefinition = ReadyGame | SoonGame;

/** The games in menu order. Ids must be unique. */
export class GameRegistry {
  readonly #games = new Map<string, GameDefinition>();

  register(game: GameDefinition): this {
    if (this.#games.has(game.id))
      throw new Error(`A game with id "${game.id}" is already registered`);
    this.#games.set(game.id, game);
    return this;
  }

  get(id: string): GameDefinition | undefined {
    return this.#games.get(id);
  }

  all(): GameDefinition[] {
    return [...this.#games.values()];
  }

  /** The first game that can be played, the menu's default pick. */
  firstReady(): ReadyGame | undefined {
    return this.all().find((game): game is ReadyGame => game.status === 'ready');
  }
}
