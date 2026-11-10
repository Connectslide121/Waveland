import * as Phaser from 'phaser';
import { palette, paletteNumbers } from '../../theme/palette';
import { solidTop, spikesOut, type PlatformerLevel, type Solid } from './level';
import { PLAYER_HEIGHT, PLAYER_WIDTH, SPIKE_HEIGHT, VIEW_HEIGHT, VIEW_WIDTH } from './physics';
import { DEATH_TIME, type PlatformerRun, type RunEvent } from './run';

/**
 * Draws the platformer from song time: the synth grid, the level as it is at that moment,
 * the player, pickups and the effects. Nothing here moves by frame time; every frame the
 * session hands it the audio clock's time and it draws what is there then.
 *
 * Simple neon shapes for now: wide faint strokes under thin bright ones read as glow.
 */

/** World height drawn at the bottom of the view's 540 px, and at the top. */
const WORLD_TOP = 450;
/** How far below the view pits are drawn, so they reach past its bottom edge. */
const PIT_DEPTH = -260;
/** The grid's horizon, as a share of the view's height. */
const HORIZON = 0.62;
const GRID_ROWS = 12;
const GRID_COLUMNS = 22;
/** How long a landing squashes the player, in song seconds. */
const SQUASH_TIME = 0.14;
/** Floating score texts rise for this long. */
const FLOAT_TIME = 0.8;
const SHARDS = 12;

/** Turns world heights (up from the base line) into the view's y (down from its top). */
const sy = (y: number) => WORLD_TOP - y;

interface Floater {
  text: Phaser.GameObjects.Text;
  x: number;
  y: number;
  /** Song time it appeared. */
  at: number;
}

export interface FrameState {
  time: number;
  run: PlatformerRun;
  /** Which beat of the bar, 0–3 (or -1 before the first). */
  beatInBar: number;
  /** 0 on the beat, rising to 1 at the next. */
  beatPhase: number;
}

export class PlatformerScene extends Phaser.Scene {
  #sky!: Phaser.GameObjects.Graphics;
  #world!: Phaser.GameObjects.Graphics;
  #front!: Phaser.GameObjects.Graphics;
  #floaters: Floater[] = [];
  #zoom = 1;
  #offsetX = 0;
  #offsetY = 0;
  /** Where the player died, for the shards. */
  #death: { x: number; y: number } | null = null;

  constructor(
    private readonly level: PlatformerLevel,
    /** Called every frame; the session moves the run on and hands back what to draw. */
    private readonly frame: () => FrameState,
  ) {
    super('platformer');
  }

  create(): void {
    this.#sky = this.add.graphics();
    this.#world = this.add.graphics();
    this.#front = this.add.graphics();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.#layout, this);
    this.#layout();
  }

  update(): void {
    const state = this.frame();
    this.#draw(state);
  }

  /** The run's events, for the effects. */
  effects(events: RunEvent[], time: number, run: PlatformerRun): void {
    for (const e of events) {
      if (e.type === 'death')
        this.#death = { x: e.x + PLAYER_WIDTH / 2, y: e.y + PLAYER_HEIGHT / 2 };
      else if (e.type === 'land' && e.quality !== 'miss')
        this.#float(
          `${e.quality === 'perfect' ? 'PERFECT' : 'GOOD'} +${e.points}`,
          e.x,
          e.y + PLAYER_HEIGHT + 24,
          time,
          e.quality === 'perfect' ? palette.magenta : palette.ink,
        );
      else if (e.type === 'pickup') {
        const k = run.level.pickups[e.index]!;
        this.#float(`+${e.points}`, k.x, k.y + 18, time, palette.magenta);
      }
    }
  }

  /** Forget effects tied to song times that are being played again. */
  reset(): void {
    this.#death = null;
    for (const f of this.#floaters) f.text.destroy();
    this.#floaters = [];
  }

  #float(text: string, x: number, y: number, at: number, color: string): void {
    const object = this.add
      .text(0, 0, text, {
        fontFamily: 'Bahnschrift, "Segoe UI", system-ui, sans-serif',
        fontSize: '15px',
        fontStyle: '600',
        color,
        letterSpacing: 2,
      })
      .setOrigin(0.5, 1)
      .setShadow(0, 0, color, 10, false, true);
    this.#floaters.push({ text: object, x, y, at });
  }

  #layout(): void {
    const { width, height } = this.scale;
    this.#zoom = Math.min(width / VIEW_WIDTH, height / VIEW_HEIGHT);
    this.#offsetX = (width - VIEW_WIDTH * this.#zoom) / 2;
    this.#offsetY = (height - VIEW_HEIGHT * this.#zoom) / 2;
  }

  #draw(state: FrameState): void {
    const { time, run } = state;
    const level = this.level;
    // The camera's left edge, shaken for a moment after a death.
    let camera = level.speed * time;
    let shakeY = 0;
    const sinceDeath = run.phase === 'dying' ? time - run.diedAt : Infinity;
    if (sinceDeath < 0.3) {
      const k = 1 - sinceDeath / 0.3;
      camera += Math.sin(sinceDeath * 90) * 7 * k;
      shakeY = Math.cos(sinceDeath * 70) * 5 * k;
    }

    this.#drawSky(state);
    const g = this.#world.clear();
    this.#world
      .setScale(this.#zoom)
      .setPosition(this.#offsetX - camera * this.#zoom, this.#offsetY + shakeY * this.#zoom);
    const { width } = this.scale;
    const x0 = camera - this.#offsetX / this.#zoom - 40;
    const x1 = camera + (width - this.#offsetX) / this.#zoom + 40;

    for (const solid of level.solids) {
      if (solid.x1 < x0) continue;
      if (solid.x0 > x1) break;
      this.#drawSolid(g, solid, time, state.beatPhase);
    }
    this.#drawSpikes(g, time, x0, x1);
    this.#drawPickups(g, run, state.beatPhase, x0, x1);
    this.#drawPlayer(g, run, time, state.beatPhase);
    if (this.#death && run.phase === 'dying') this.#drawShards(g, this.#death, sinceDeath);

    // Floating texts, in screen space at their world spot.
    this.#floaters = this.#floaters.filter((f) => {
      const age = time - f.at;
      if (age < 0 || age > FLOAT_TIME) {
        f.text.destroy();
        return false;
      }
      f.text
        .setPosition(
          this.#offsetX + (f.x - camera) * this.#zoom,
          this.#offsetY + (sy(f.y + age * 50) + shakeY) * this.#zoom,
        )
        .setScale(this.#zoom)
        .setAlpha(1 - age / FLOAT_TIME);
      return true;
    });

    // Flash on death, and darken what lies outside the 16:9 play area.
    const f = this.#front.clear();
    if (sinceDeath < DEATH_TIME)
      f.fillStyle(paletteNumbers.orange, 0.28 * (1 - sinceDeath / DEATH_TIME)).fillRect(
        0,
        0,
        width,
        this.scale.height,
      );
    if (this.#offsetX > 0) {
      f.fillStyle(paletteNumbers.night, 0.55);
      f.fillRect(0, 0, this.#offsetX, this.scale.height);
      f.fillRect(width - this.#offsetX, 0, this.#offsetX, this.scale.height);
    }
  }

  #drawSky({ beatPhase, beatInBar }: FrameState): void {
    const { width, height } = this.scale;
    const g = this.#sky.clear();
    g.fillStyle(paletteNumbers.night, 1).fillRect(0, 0, width, height);
    const horizon = height * HORIZON;
    g.fillGradientStyle(
      paletteNumbers.night,
      paletteNumbers.night,
      paletteNumbers.dusk,
      paletteNumbers.dusk,
      0,
      0,
      1,
      1,
    ).fillRect(0, horizon - height * 0.3, width, height * 0.3);
    g.fillStyle(paletteNumbers.dusk, 0.5).fillRect(0, horizon, width, height - horizon);

    // Rows roll toward the player, one per beat.
    const depth = height - horizon;
    const line = (ax: number, ay: number, bx: number, by: number, a: number) => {
      g.lineStyle(6, paletteNumbers.violet, a * 0.15).lineBetween(ax, ay, bx, by);
      g.lineStyle(1.5, paletteNumbers.violet, a).lineBetween(ax, ay, bx, by);
    };
    for (let i = 0; i < GRID_ROWS; i++) {
      const z = (i + beatPhase) / GRID_ROWS;
      const y = horizon + depth * z * z;
      line(0, y, width, y, 0.08 + 0.4 * z);
    }
    const vanish = width / 2;
    for (let i = 0; i <= GRID_COLUMNS; i++) {
      const x = vanish + (i / GRID_COLUMNS - 0.5) * width * 3;
      line(vanish, horizon, x, height, 0.3);
    }
    // The horizon flares on every beat, brightest on the bar's first.
    const flare = Math.max(0, 1 - beatPhase * 2.5) * (beatInBar === 0 ? 1 : 0.55);
    g.lineStyle(8 + 10 * flare, paletteNumbers.magenta, 0.15 + 0.2 * flare).lineBetween(
      0,
      horizon,
      width,
      horizon,
    );
    g.lineStyle(2, paletteNumbers.magenta, 0.6 + 0.4 * flare).lineBetween(
      0,
      horizon,
      width,
      horizon,
    );
  }

  #drawSolid(g: Phaser.GameObjects.Graphics, s: Solid, t: number, beatPhase: number): void {
    const top = solidTop(s, t);
    const w = s.x1 - s.x0;
    if (s.kind === 'bridge' || s.kind === 'ledge') {
      // Bridges show faintly where they will be when they are gone.
      if (top === null) {
        g.lineStyle(1.5, paletteNumbers.cyan, 0.22);
        for (let x = s.x0; x < s.x1 - 4; x += 14) g.lineBetween(x, sy(s.top), x + 8, sy(s.top));
        return;
      }
      g.fillStyle(paletteNumbers.cyan, 0.18).fillRoundedRect(s.x0 - 3, sy(top) - 3, w + 6, 16, 6);
      g.fillStyle(paletteNumbers.cyan, 0.9).fillRoundedRect(s.x0, sy(top), w, 9, 3);
      return;
    }
    if (top === null) return;
    // The drop's staircase in the drop colour; the rest is the world's violet.
    const color = s.kind === 'step' ? paletteNumbers.magenta : paletteNumbers.violet;
    const bottom = sy(PIT_DEPTH);
    // The body, faint, with a bright edge on top.
    g.fillStyle(color, s.kind === 'eq' ? 0.22 : 0.12).fillRect(s.x0, sy(top), w, bottom - sy(top));
    g.lineStyle(1, color, 0.35).strokeRect(s.x0 + 0.5, sy(top), w - 1, bottom - sy(top));
    const glow = s.kind === 'eq' ? 0.25 + 0.3 * Math.max(0, 1 - beatPhase * 3) : 0.25;
    g.fillStyle(color, glow).fillRect(s.x0, sy(top) - 4, w, 10);
    g.fillStyle(color, 1).fillRect(s.x0, sy(top), w, 3);
  }

  #drawSpikes(g: Phaser.GameObjects.Graphics, t: number, x0: number, x1: number): void {
    const out = spikesOut(this.level, t);
    const height = out ? SPIKE_HEIGHT : SPIKE_HEIGHT * 0.25;
    g.fillStyle(paletteNumbers.orange, out ? 1 : 0.4);
    for (const s of this.level.spikes) {
      if (s.x1 < x0) continue;
      if (s.x0 > x1) break;
      const count = Math.max(1, Math.round((s.x1 - s.x0) / 12));
      const step = (s.x1 - s.x0) / count;
      for (let i = 0; i < count; i++) {
        const a = s.x0 + i * step;
        g.fillTriangle(a, sy(s.top), a + step / 2, sy(s.top + height), a + step, sy(s.top));
      }
      if (out)
        g.fillStyle(paletteNumbers.orange, 0.18)
          .fillRect(s.x0, sy(s.top + height + 4), s.x1 - s.x0, height + 4)
          .fillStyle(paletteNumbers.orange, 1);
    }
  }

  #drawPickups(
    g: Phaser.GameObjects.Graphics,
    run: PlatformerRun,
    beatPhase: number,
    x0: number,
    x1: number,
  ): void {
    const bob = Math.sin(beatPhase * Math.PI * 2) * 3;
    run.level.pickups.forEach((k, i) => {
      if (k.x < x0 || k.x > x1 || run.isCollected(i)) return;
      const r = k.kind === 'gem' ? 12 : 7;
      const x = k.x;
      const y = sy(k.y) + bob;
      g.fillStyle(paletteNumbers.magenta, 0.2).fillCircle(x, y, r * 1.9);
      g.fillStyle(paletteNumbers.magenta, 1).fillTriangle(x - r, y, x, y - r * 1.3, x + r, y);
      g.fillTriangle(x - r, y, x, y + r * 1.3, x + r, y);
      if (k.kind === 'gem') g.fillStyle(0xffffff, 0.9).fillCircle(x, y, 3);
    });
  }

  #drawPlayer(
    g: Phaser.GameObjects.Graphics,
    run: PlatformerRun,
    t: number,
    beatPhase: number,
  ): void {
    const p = run.player;
    if (!p.alive) return;
    // Squash on landing, stretch on the way up.
    let sx = 1;
    let sY = 1;
    const sinceLanding = t - run.landedAt;
    if (sinceLanding >= 0 && sinceLanding < SQUASH_TIME) {
      const k = 1 - sinceLanding / SQUASH_TIME;
      sx = 1 + 0.3 * k;
      sY = 1 - 0.25 * k;
    } else if (!p.grounded && p.vy > 0) {
      sx = 0.88;
      sY = 1.12;
    }
    const w = PLAYER_WIDTH * sx;
    const h = PLAYER_HEIGHT * sY;
    const x = p.x + (PLAYER_WIDTH - w) / 2;
    const top = sy(p.y + h);
    // Blink with the beat while counting in.
    const alpha = run.phase === 'countin' ? 0.55 + 0.45 * Math.max(0, 1 - beatPhase * 2) : 1;
    g.fillStyle(paletteNumbers.cyan, 0.18 * alpha).fillRoundedRect(
      x - 6,
      top - 6,
      w + 12,
      h + 12,
      12,
    );
    g.fillStyle(paletteNumbers.cyan, alpha).fillRoundedRect(x, top, w, h, 7);
    g.lineStyle(2, 0xb9fbff, alpha).strokeRoundedRect(x + 2, top + 2, w - 4, h - 4, 5);
    // Eyes, looking the way they run.
    const look = p.vx < 0 ? -1 : 1;
    const eyeX = x + w / 2 + look * w * 0.18;
    g.fillStyle(paletteNumbers.night, alpha);
    g.fillRect(eyeX - 1, top + h * 0.28, 4, h * 0.2);
    g.fillRect(eyeX - 1 - look * 9, top + h * 0.28, 4, h * 0.2);
  }

  #drawShards(g: Phaser.GameObjects.Graphics, at: { x: number; y: number }, age: number): void {
    const fade = Math.max(0, 1 - age / DEATH_TIME);
    for (let i = 0; i < SHARDS; i++) {
      const angle = (i / SHARDS) * Math.PI * 2 + 0.3;
      const speed = 260 + (i % 3) * 90;
      const x = at.x + Math.cos(angle) * speed * age;
      const y = at.y + Math.sin(angle) * speed * age - 900 * age * age;
      const size = 9 - (i % 3) * 2;
      g.fillStyle(i % 4 === 0 ? paletteNumbers.orange : paletteNumbers.cyan, fade);
      g.fillRect(x - size / 2, sy(y) - size / 2, size, size);
    }
    g.lineStyle(3, paletteNumbers.cyan, fade * 0.8).strokeCircle(at.x, sy(at.y), 20 + age * 260);
  }
}
