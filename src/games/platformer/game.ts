import * as Phaser from 'phaser';
import type { Song } from '../../core';
import { MENU_BEAT_SECONDS, palette, paletteNumbers } from '../../theme/palette';
import type { GameSession } from '../registry';

/** Where the horizon sits, as a share of the height. */
const HORIZON = 0.56;
/** Horizontal grid lines between the horizon and the bottom edge. */
const ROWS = 14;
/** Vertical grid lines fanning out from the vanishing point. */
const COLUMNS = 24;

/**
 * The platformer's empty stage for now: the neon synth grid rolling toward the player.
 * The grid scrolls one row per beat at the menu tempo; once the song plays, the beat
 * comes from the audio clock instead.
 */
class SynthGridScene extends Phaser.Scene {
  #sky!: Phaser.GameObjects.Graphics;
  #grid!: Phaser.GameObjects.Graphics;
  #title!: Phaser.GameObjects.Text;

  constructor(private readonly song: Song) {
    super('synth-grid');
  }

  create(): void {
    this.#sky = this.add.graphics();
    this.#grid = this.add.graphics();
    this.#title = this.add
      .text(0, 0, this.song.title.toUpperCase(), {
        fontFamily: 'Bahnschrift, "Segoe UI", system-ui, sans-serif',
        fontSize: '15px',
        color: palette.ink,
        letterSpacing: 2,
      })
      .setOrigin(0.5, 0)
      .setAlpha(0.85);

    this.scale.on(Phaser.Scale.Events.RESIZE, this.#layout, this);
    this.#layout();
  }

  update(time: number): void {
    const phase = (time / 1000 / MENU_BEAT_SECONDS) % 1;
    this.#drawGrid(phase);
  }

  #layout(): void {
    const { width, height } = this.scale;
    const horizon = height * HORIZON;
    this.#sky.clear();
    // The deep violet glow rising from below the horizon, on night.
    this.#sky.fillStyle(paletteNumbers.night, 1).fillRect(0, 0, width, height);
    this.#sky
      .fillGradientStyle(
        paletteNumbers.night,
        paletteNumbers.night,
        paletteNumbers.dusk,
        paletteNumbers.dusk,
        0,
        0,
        1,
        1,
      )
      .fillRect(0, horizon - height * 0.35, width, height * 0.35);
    this.#sky.fillStyle(paletteNumbers.dusk, 0.6).fillRect(0, horizon, width, height - horizon);
    this.#title.setPosition(width / 2, 24);
  }

  #drawGrid(phase: number): void {
    const { width, height } = this.scale;
    const horizon = height * HORIZON;
    const depth = height - horizon;
    const g = this.#grid.clear();
    const line = (x1: number, y1: number, x2: number, y2: number, alpha: number) => {
      // A wide faint stroke under a thin bright one reads as glow.
      g.lineStyle(6, paletteNumbers.violet, alpha * 0.18).lineBetween(x1, y1, x2, y2);
      g.lineStyle(1.5, paletteNumbers.violet, alpha).lineBetween(x1, y1, x2, y2);
    };

    // Rows: evenly spaced in depth, squeezed toward the horizon by perspective.
    for (let i = 0; i < ROWS; i++) {
      const z = (i + phase) / ROWS;
      const y = horizon + depth * z * z;
      line(0, y, width, y, 0.15 + 0.75 * z);
    }

    // Columns: fan out from the vanishing point well past the screen edges.
    const vanishX = width / 2;
    const spread = width * 3;
    for (let i = 0; i <= COLUMNS; i++) {
      const x = vanishX + (i / COLUMNS - 0.5) * spread;
      line(vanishX, horizon, x, height, 0.55);
    }

    // The horizon itself, in the beat colour.
    g.lineStyle(8, paletteNumbers.magenta, 0.2).lineBetween(0, horizon, width, horizon);
    g.lineStyle(2, paletteNumbers.magenta, 0.9).lineBetween(0, horizon, width, horizon);
  }
}

export function startPlatformer(song: Song, container: HTMLElement): Promise<GameSession> {
  return new Promise((resolve) => {
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: container,
      backgroundColor: palette.night,
      scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
      banner: false,
      scene: new SynthGridScene(song),
      callbacks: {
        postBoot: () => resolve({ stop: () => game.destroy(true) }),
      },
    });
  });
}
