import * as Phaser from 'phaser';
import { getEffects, onSettingsChange, type LevelMap } from '../../core';
import { palette, paletteNumbers } from '../../theme/palette';
import {
  lowerBound,
  MAX_SOLID_WIDTH,
  solidTop,
  spikesOut,
  type PlatformerLevel,
  type Solid,
} from './level';
import { FrameMonitor, QUALITY, type Quality } from './perf';
import {
  ANCHOR_X,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  SPIKE_HEIGHT,
  VIEW_HEIGHT,
  VIEW_WIDTH,
} from './physics';
import { DEATH_TIME, type PlatformerRun, type RunEvent } from './run';

/**
 * Draws the platformer in the Neon arcade look (docs/concept/look.html) from song time:
 * the synth grid, wave lines and the speaker pulsing on every kick behind; the level as it
 * is at that moment; the player, its trail and the particles; the drop's set piece. Nothing
 * here moves by frame time: every frame the session hands it the audio clock's time and it
 * draws what is there then, so a pause freezes it and a rewind plays it again.
 *
 * Glow comes from bloom on the camera, over wide faint strokes under thin bright ones.
 * With effects reduced there are no flashes and no screen shake.
 *
 * Kept cheap (docs/platformer.md, "Frame budget"): ground, steps and ledges never move, so
 * they are drawn once into tile textures that scroll with the camera; bridges are pooled
 * images of one dot; everything else is culled to the view by binary search, and the frame
 * loop allocates nothing. The bloom runs at a share of the screen's resolution, and when
 * frames stay over budget the quality steps down (`perf.ts`).
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
/** A full jump's time in the air, for the flip: up and down at the jump speed. */
const FLIP_TIME = 0.68;
/** How long the trail behind the player is, in song seconds. */
const TRAIL_TIME = 0.35;
/** Trail points kept: enough for TRAIL_TIME at 240 fps. */
const TRAIL_CAPACITY = 128;
/** Floating score texts rise for this long. */
const FLOAT_TIME = 0.8;
/** Floating texts kept for reuse; the oldest is reused when they are all showing. */
const FLOATERS = 8;
const SHARDS = 12;
/** How long a speaker ring spreads out after a kick, in beats. */
const RING_BEATS = 1.2;
/** How long the drop takes to calm down after its set piece, in bars. */
const CALM_BARS = 2;
/** A bridge blinks in for this long before it comes out, in beats. */
const BRIDGE_WARN_BEATS = 0.5;
const FONT = 'Bahnschrift, "DIN Alternate", "Segoe UI", system-ui, sans-serif';
const RADIAL = 'wl-radial';
/** A bridge's dot, lit with its halo, and its faint outline where it will be. */
const DOT = 'wl-dot';
const DOT_OUTLINE = 'wl-dot-outline';
/** A dot's texture size in world px (lit: the dot and 3 px of halo around it). */
const DOT_W = 11;
const DOT_H = 7;
const DOT_HALO = 3;
/** Texels per world px of the dot textures, so they stay sharp when zoomed. */
const DOT_RES = 4;
/** Static ground is drawn into tiles this wide, world px, from the view's top to the pits. */
const TILE_WIDTH = 512;
const TILE_HEIGHT = WORLD_TOP - PIT_DEPTH;
/** Tile texels per world px at most (a 4K screen is zoom 4). */
const MAX_TILE_RES = 3;
/** The bloom's threshold pass, writing to a smaller target so the blur is cheaper. */
const BLOOM_THRESHOLD = 'WaveBloomThreshold';
/** The bloom's blur radius at full resolution, screen px. */
const BLOOM_RADIUS = 3;
/** Pickups are found by song time; this much room either way covers the gems' offsets. */
const PICKUP_MARGIN = 200;

/** Turns world heights (up from the base line) into the view's y (down from its top). */
const sy = (y: number) => WORLD_TOP - y;

/** A steady pseudo-random number in [0, 1) for particle `i` of a burst. */
const hash = (seed: number, i: number) => {
  const v = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/** True when long ground split into pieces runs on from `a` into `b`: drawn as one. */
function joins(a: Solid, b: Solid | undefined): boolean {
  return (
    b !== undefined &&
    b.kind === a.kind &&
    !b.keys &&
    !a.keys &&
    b.top === a.top &&
    (Math.abs(b.x1 - a.x0) < 0.5 || Math.abs(b.x0 - a.x1) < 0.5)
  );
}

/** Solids that never move or vanish, drawn once into the tiles. */
const isStatic = (s: Solid) => !s.keys && !s.windows;

interface Floater {
  text: Phaser.GameObjects.Text;
  x: number;
  y: number;
  /** Song time it appeared; -Infinity when free. */
  at: number;
}

/** A burst of particles in world space, drawn from its song time. */
interface Burst {
  kind: 'land' | 'spark' | 'drop';
  x: number;
  y: number;
  at: number;
  seed: number;
}

/** How long each kind of burst lasts, how many particles and how fast they fly. */
const BURSTS = {
  land: { life: 0.35, count: 10, speed: 140 },
  spark: { life: 0.45, count: 12, speed: 220 },
  drop: { life: 0.6, count: 20, speed: 360 },
} as const;
const DROP_COLORS = [paletteNumbers.cyan, paletteNumbers.magenta, paletteNumbers.violet];

/** A tile of static ground: its texture, the image showing it, and which tile it holds. */
interface Tile {
  texture: Phaser.Textures.DynamicTexture;
  image: Phaser.GameObjects.Image;
  /** Tile number along the level (x / TILE_WIDTH), or NaN when it holds none. */
  index: number;
}

export interface FrameState {
  time: number;
  run: PlatformerRun;
  /** Which beat of the bar, 0–3 (or -1 before the first). */
  beatInBar: number;
  /** 0 on the beat, rising to 1 at the next. */
  beatPhase: number;
  /** The pause menu is open: frames don't count toward the quality. */
  paused: boolean;
}

/** The song moments the backdrop reacts to, from the level map. */
interface Music {
  /** Kick times and strengths, sorted. */
  kicks: { time: number; intensity: number }[];
  /** The drop set pieces' song time spans. */
  drops: { start: number; end: number }[];
  /** Overall energy per grid beat, 0 to 1. */
  energy: number[];
}

/** Just what the bloom's threshold pass needs from Phaser's filter render nodes. */
interface FilterNode {
  run(
    controller: unknown,
    input: { width: number; height: number },
    output: unknown,
    padding: unknown,
  ): unknown;
}

export class PlatformerScene extends Phaser.Scene {
  #skyBase!: Phaser.GameObjects.Graphics;
  #sky!: Phaser.GameObjects.Graphics;
  #flash!: Phaser.GameObjects.Image;
  #back!: Phaser.GameObjects.Graphics;
  #layer!: Phaser.GameObjects.Container;
  #tileLayer!: Phaser.GameObjects.Container;
  #dots!: Phaser.GameObjects.Container;
  #world!: Phaser.GameObjects.Graphics;
  #fx!: Phaser.GameObjects.Graphics;
  #player!: Phaser.GameObjects.Graphics;
  #callout!: Phaser.GameObjects.Text;
  #front!: Phaser.GameObjects.Graphics;
  /** Draws a tile's ground before it is copied into the tile's texture; never shown. */
  #bake!: Phaser.GameObjects.Graphics;
  #tiles: Tile[] = [];
  /** Tile texels per world px; the tiles are drawn again when it changes. */
  #tileRes = 0;
  #dotImages: Phaser.GameObjects.Image[] = [];
  #dotsShown = 0;
  #floaters: Floater[] = [];
  #bursts: Burst[] = [];
  /** The trail, a ring of song times and places. */
  readonly #trailT = new Float64Array(TRAIL_CAPACITY);
  readonly #trailX = new Float64Array(TRAIL_CAPACITY);
  readonly #trailY = new Float64Array(TRAIL_CAPACITY);
  #trailStart = 0;
  #trailLength = 0;
  /** A trail edge, reused: its two ends across the ribbon. */
  readonly #edge = { ax: 0, ay: 0, bx: 0, by: 0 };
  /** Corner radii for rounded caps, reused. */
  readonly #corners = { tl: 0, tr: 0, bl: 0, br: 0 };
  /** Per solid: does it run on into the one before, and the one after. */
  readonly #joinedLeft: Uint8Array;
  readonly #joinedRight: Uint8Array;
  readonly #music: Music;
  #zoom = 1;
  #offsetX = 0;
  #offsetY = 0;
  /** Where the player died, for the shards. */
  #death = { x: 0, y: 0, shown: false };
  /** The last landing and drop beat seen, to burst once for each. */
  #landingSeen = -Infinity;
  #dropBeatSeen = -1;
  #reduced = getEffects() === 'reduced';
  #stopListening: (() => void) | null = null;
  #quality: Quality = QUALITY[0]!;
  #bloom: Phaser.Types.Actions.AddEffectBloomReturn | null = null;
  /** When this frame's step started, and the one before, for the monitor. */
  #stepStart = 0;
  #lastStepStart = 0;
  #counting = false;
  /** How long frames take; lowers the quality when they stay over budget. */
  readonly monitor: FrameMonitor;

  constructor(
    private readonly level: PlatformerLevel,
    map: LevelMap,
    /** Called every frame; the session moves the run on and hands back what to draw. */
    private readonly frame: () => FrameState,
    /** Called when the quality steps down on its own. */
    onLowered: () => void = () => {},
  ) {
    super('platformer');
    this.#music = {
      kicks: map.events
        .filter((e) => e.kind === 'kick')
        .map((e) => ({ time: e.time, intensity: e.intensity })),
      drops: level.chunks
        .filter((c) => c.kind === 'drop' || c.planned === 'drop')
        .map((c) => ({ start: c.start, end: c.end })),
      energy: map.energy,
    };
    const solids = level.solids;
    this.#joinedLeft = new Uint8Array(solids.length);
    this.#joinedRight = new Uint8Array(solids.length);
    for (let i = 0; i < solids.length; i++) {
      this.#joinedLeft[i] = joins(solids[i]!, solids[i - 1]) ? 1 : 0;
      this.#joinedRight[i] = joins(solids[i]!, solids[i + 1]) ? 1 : 0;
    }
    this.monitor = new FrameMonitor((level) => {
      this.#setQuality(QUALITY[level]!);
      onLowered();
    });
  }

  create(): void {
    this.#makeTextures();
    this.#skyBase = this.add.graphics();
    this.#sky = this.add.graphics();
    this.#flash = this.add.image(0, 0, RADIAL).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0);
    this.#back = this.add.graphics();
    this.#tileLayer = this.add.container(0, 0);
    this.#dots = this.add.container(0, 0);
    this.#world = this.add.graphics();
    this.#fx = this.add.graphics();
    this.#player = this.add.graphics();
    this.#drawCube(this.#player);
    this.#layer = this.add.container(0, 0, [
      this.#tileLayer,
      this.#dots,
      this.#world,
      this.#fx,
      this.#player,
    ]);
    this.#bake = this.make.graphics({}, false);
    this.#callout = this.add
      .text(0, 0, 'DROP', {
        fontFamily: FONT,
        fontSize: '40px',
        fontStyle: '700',
        color: palette.flare,
        letterSpacing: 20,
        resolution: 2,
      })
      .setOrigin(0.5)
      .setShadow(0, 0, palette.magenta, 18, false, true)
      .setAlpha(0);
    for (let i = 0; i < FLOATERS; i++)
      this.#floaters.push({
        text: this.add
          .text(0, 0, '', {
            fontFamily: FONT,
            fontSize: '15px',
            fontStyle: '600',
            letterSpacing: 2,
            resolution: 2,
          })
          .setOrigin(0.5, 1)
          .setVisible(false),
        x: 0,
        y: 0,
        at: -Infinity,
      });
    this.#front = this.add.graphics();

    // Bloom: what is bright spreads its light, over a smaller copy of the frame.
    const [bloom] = Phaser.Actions.AddEffectBloom(this.cameras.main, {
      threshold: 0.42,
      blurRadius: BLOOM_RADIUS,
      blurSteps: 4,
      blurQuality: 1,
      blendAmount: 1,
    });
    if (bloom) {
      bloom.blur.strength = 1.5;
      this.#bloom = bloom;
      this.#scaleBloom(bloom);
    }
    this.#setQuality(this.#quality);

    // Frame timing: from the start of a step (update and render) to the end of its render.
    const events = this.game.events;
    const preStep = () => {
      this.#lastStepStart = this.#stepStart;
      this.#stepStart = performance.now();
    };
    const postRender = () => {
      if (this.#counting)
        this.monitor.frame(
          this.#stepStart - this.#lastStepStart,
          performance.now() - this.#stepStart,
        );
    };
    events.on(Phaser.Core.Events.PRE_STEP, preStep);
    events.on(Phaser.Core.Events.POST_RENDER, postRender);

    this.scale.on(Phaser.Scale.Events.RESIZE, this.#layout, this);
    this.#layout();
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => (this.#reduced = getEffects() === 'reduced');
    media.addEventListener('change', update);
    const stop = onSettingsChange(update);
    this.#stopListening = () => {
      media.removeEventListener('change', update);
      stop();
      events.off(Phaser.Core.Events.PRE_STEP, preStep);
      events.off(Phaser.Core.Events.POST_RENDER, postRender);
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.#stopListening?.());
  }

  update(): void {
    const state = this.frame();
    // Paused frames are quick and say nothing about play; a pause starts a new window.
    if (state.paused && this.#counting) this.monitor.reset();
    this.#counting = !state.paused;
    this.#draw(state);
  }

  /** The run's events, for the effects. */
  effects(events: RunEvent[], time: number, run: PlatformerRun): void {
    for (const e of events) {
      if (e.type === 'death') {
        this.#death.x = e.x + PLAYER_WIDTH / 2;
        this.#death.y = e.y + PLAYER_HEIGHT / 2;
        this.#death.shown = true;
      } else if (e.type === 'land' && e.quality !== 'miss')
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
        this.#burst('spark', k.x, k.y, time);
      }
    }
  }

  /** Forget effects tied to song times that are being played again. */
  reset(): void {
    this.#death.shown = false;
    for (const f of this.#floaters) {
      f.at = -Infinity;
      f.text.setVisible(false);
    }
    this.#bursts.length = 0;
    this.#trailLength = 0;
    this.#landingSeen = -Infinity;
    this.#dropBeatSeen = -1;
    // A seek: the next frame's gap is the seek, not a slow frame.
    this.monitor.reset();
  }

  #setQuality(quality: Quality): void {
    this.#quality = quality;
    const blur = this.#bloom?.blur;
    if (!blur) return;
    // Fewer passes spread less: a wider radius keeps the glow about as wide.
    const radius = BLOOM_RADIUS * quality.bloomScale * Math.sqrt(4 / quality.blurSteps);
    blur.steps = quality.blurSteps;
    blur.x = radius;
    blur.y = radius;
  }

  /**
   * Run the bloom's threshold into a target `bloomScale` the size of the frame: the blur
   * after it then works on a quarter of the pixels (at half scale), and the blend back
   * over the frame scales it up. WebGL only; elsewhere the bloom stays as Phaser made it.
   */
  #scaleBloom(bloom: Phaser.Types.Actions.AddEffectBloomReturn): void {
    const renderer = this.game.renderer;
    if (!(renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer)) return;
    const nodes = renderer.renderNodes;
    const base = nodes.getNode('FilterThreshold') as unknown as FilterNode | null;
    if (!base) return;
    const pool = renderer.drawingContextPool;
    const scaled = Object.create(base) as FilterNode;
    scaled.run = (controller, input, output, padding) => {
      const scale = this.#quality.bloomScale;
      if (!output && scale < 1)
        output = pool.get(
          Math.max(1, Math.ceil(input.width * scale)),
          Math.max(1, Math.ceil(input.height * scale)),
        );
      return base.run(controller, input, output, padding);
    };
    if (!nodes.getNode(BLOOM_THRESHOLD))
      nodes.addNode(
        BLOOM_THRESHOLD,
        scaled as unknown as Phaser.Renderer.WebGL.RenderNodes.RenderNode,
      );
    bloom.threshold.renderNode = BLOOM_THRESHOLD;
  }

  /** The radial glow for the drop's flash, and the bridge's dots. */
  #makeTextures(): void {
    if (!this.textures.exists(RADIAL)) {
      const texture = this.textures.createCanvas(RADIAL, 256, 256)!;
      const ctx = texture.getContext();
      const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
      gradient.addColorStop(0, 'rgb(255 255 255 / 1)');
      gradient.addColorStop(0.45, 'rgb(255 255 255 / 0.45)');
      gradient.addColorStop(1, 'rgb(255 255 255 / 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 256, 256);
      texture.refresh();
    }
    if (!this.textures.exists(DOT)) {
      const w = DOT_W + 2 * DOT_HALO;
      const h = DOT_H + 2 * DOT_HALO;
      const texture = this.textures.createCanvas(DOT, w * DOT_RES, h * DOT_RES)!;
      const ctx = texture.getContext();
      ctx.scale(DOT_RES, DOT_RES);
      ctx.fillStyle = palette.cyan;
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, 4);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.roundRect(DOT_HALO, DOT_HALO, DOT_W, DOT_H, 2);
      ctx.fill();
      texture.refresh();
    }
    if (!this.textures.exists(DOT_OUTLINE)) {
      const texture = this.textures.createCanvas(DOT_OUTLINE, DOT_W * DOT_RES, DOT_H * DOT_RES)!;
      const ctx = texture.getContext();
      ctx.scale(DOT_RES, DOT_RES);
      ctx.strokeStyle = palette.cyan;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([2, 1.6]);
      ctx.beginPath();
      ctx.roundRect(0.6, 0.6, DOT_W - 1.2, DOT_H - 1.2, 2);
      ctx.stroke();
      texture.refresh();
    }
  }

  #burst(kind: Burst['kind'], x: number, y: number, at: number): void {
    this.#bursts.push({ kind, x, y, at, seed: (at * 1000) % 997 });
  }

  /** Show a floating text, reusing a free one, or the oldest when none is free. */
  #float(text: string, x: number, y: number, at: number, color: string): void {
    let floater = this.#floaters[0]!;
    for (const f of this.#floaters) if (f.at < floater.at) floater = f;
    floater.text.setText(text).setColor(color).setShadow(0, 0, color, 10, false, true);
    floater.x = x;
    floater.y = y;
    floater.at = at;
  }

  #layout(): void {
    const { width, height } = this.scale;
    this.#zoom = Math.min(width / VIEW_WIDTH, height / VIEW_HEIGHT);
    this.#offsetX = (width - VIEW_WIDTH * this.#zoom) / 2;
    this.#offsetY = (height - VIEW_HEIGHT * this.#zoom) / 2;
    this.#drawSkyBase();
    // Tiles drawn for another zoom are drawn again, sharp at this one.
    const res = Math.min(MAX_TILE_RES, Math.max(1, Math.ceil(this.#zoom * 4) / 4));
    if (res !== this.#tileRes) {
      this.#tileRes = res;
      for (const tile of this.#tiles) {
        tile.index = NaN;
        tile.texture.setSize(Math.ceil(TILE_WIDTH * res), Math.ceil(TILE_HEIGHT * res));
        tile.image.setScale(1 / res);
      }
    }
  }

  /** How strong the drop's set piece is at `t`: 1 through it, easing off after. */
  #dropLevel(t: number): number {
    const bar = 4 * this.level.beatPeriod;
    let level = 0;
    for (const d of this.#music.drops) {
      if (t < d.start) break;
      if (t < d.end) return 1;
      level = Math.max(level, 1 - (t - d.end) / (CALM_BARS * bar));
    }
    return level;
  }

  #draw(state: FrameState): void {
    const { time, run } = state;
    const level = this.level;
    // The camera's left edge, shaken for a moment after a death.
    let camera = level.speed * time;
    let shakeY = 0;
    const sinceDeath = run.phase === 'dying' ? time - run.diedAt : Infinity;
    if (sinceDeath < 0.3 && !this.#reduced) {
      const k = 1 - sinceDeath / 0.3;
      camera += Math.sin(sinceDeath * 90) * 7 * k;
      shakeY = Math.cos(sinceDeath * 70) * 5 * k;
    }
    const drop = this.#dropLevel(time);
    const beat = Math.floor((time - level.gridStart) / level.beatPeriod + 1e-6);

    // Bursts for what happened since the last frame: a landing, a beat of the drop.
    if (run.landedAt > this.#landingSeen && run.player.alive) {
      this.#landingSeen = run.landedAt;
      if (time - run.landedAt < 0.1)
        this.#burst('land', run.player.x + PLAYER_WIDTH / 2, run.player.y, run.landedAt);
    }
    if (drop === 1 && beat !== this.#dropBeatSeen && run.player.alive) {
      this.#dropBeatSeen = beat;
      const p = run.player;
      this.#burst('drop', p.x + PLAYER_WIDTH / 2, p.y + PLAYER_HEIGHT / 2, time);
    }

    this.#drawSky(state, camera, drop);
    this.#drawBack(state, camera, drop);

    this.#layer
      .setScale(this.#zoom)
      .setPosition(this.#offsetX - camera * this.#zoom, this.#offsetY + shakeY * this.#zoom);
    const { width } = this.scale;
    const x0 = camera - this.#offsetX / this.#zoom - 40;
    const x1 = camera + (width - this.#offsetX) / this.#zoom + 40;
    this.#placeTiles(x0, x1);

    const g = this.#world.clear();
    this.#dotsShown = 0;
    const solids = level.solids;
    for (let i = lowerBound(solids, x0 - MAX_SOLID_WIDTH); i < solids.length; i++) {
      const solid = solids[i]!;
      if (solid.x0 > x1) break;
      if (solid.x1 < x0) continue;
      if (solid.kind === 'bridge') this.#placeBridge(solid, time);
      else if (solid.kind === 'eq') this.#drawSolid(g, i, time, state.beatPhase, drop);
      else if (solid.kind === 'step') this.#drawStepFlare(g, i, state.beatPhase, drop);
      // Ground and ledges are in the tiles.
    }
    const dots = this.#dotImages;
    for (let i = this.#dotsShown; i < dots.length && dots[i]!.visible; i++)
      dots[i]!.setVisible(false);
    this.#drawSpikes(g, time, x0, x1);
    this.#drawPickups(g, run, state, x0, x1);

    const fx = this.#fx.clear();
    this.#drawTrail(fx, run, time);
    this.#drawBursts(fx, time);
    if (this.#death.shown && run.phase === 'dying') this.#drawShards(fx, sinceDeath);
    this.#placePlayer(run, time, state.beatPhase);

    // Floating texts, in screen space at their world spot.
    for (const f of this.#floaters) {
      if (f.at === -Infinity) continue;
      const age = time - f.at;
      if (age < 0 || age > FLOAT_TIME) {
        f.at = -Infinity;
        f.text.setVisible(false);
        continue;
      }
      f.text
        .setVisible(true)
        .setPosition(
          this.#offsetX + (f.x - camera) * this.#zoom,
          this.#offsetY + (sy(f.y + age * 50) + shakeY) * this.#zoom,
        )
        .setScale(this.#zoom)
        .setAlpha(1 - age / FLOAT_TIME);
    }

    // The DROP callout thumps on every beat of the set piece, then goes quickly: a faded
    // white callout over the dark sky would read as grey.
    const thump = 0.9 + 0.35 * Math.max(0, 1 - state.beatPhase * 2.5);
    this.#callout
      .setPosition(this.#offsetX + (VIEW_WIDTH / 2) * this.#zoom, this.#offsetY + 96 * this.#zoom)
      .setScale(this.#zoom * (drop === 1 ? thump : 0.9))
      .setAlpha(Math.max(0, (drop - 0.8) * 5));

    // Flash on death, and darken what lies outside the 16:9 play area.
    const f = this.#front.clear();
    if (sinceDeath < DEATH_TIME && !this.#reduced)
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

  /** The tiles of static ground covering world x from `x0` to `x1`, drawn as they come in. */
  #placeTiles(x0: number, x1: number): void {
    const first = Math.floor(x0 / TILE_WIDTH);
    const last = Math.floor(x1 / TILE_WIDTH);
    const tiles = this.#tiles;
    while (tiles.length < last - first + 1) {
      const key = `wl-tile-${tiles.length}`;
      const res = this.#tileRes;
      const texture = this.textures.addDynamicTexture(
        key,
        Math.ceil(TILE_WIDTH * res),
        Math.ceil(TILE_HEIGHT * res),
      )!;
      const image = this.add
        .image(0, 0, key)
        .setOrigin(0, 0)
        .setScale(1 / res);
      this.#tileLayer.add(image);
      tiles.push({ texture, image, index: NaN });
    }
    // Tiles out of the view are free for the ones coming in.
    for (const tile of tiles) if (!(tile.index >= first && tile.index <= last)) tile.index = NaN;
    for (let index = first; index <= last; index++) {
      let held = false;
      for (const tile of tiles) if (tile.index === index) held = true;
      if (held) continue;
      for (const tile of tiles)
        if (Number.isNaN(tile.index)) {
          this.#bakeTile(tile, index);
          break;
        }
    }
    for (const tile of tiles) tile.image.setVisible(!Number.isNaN(tile.index));
  }

  /** Draw the ground, steps and ledges of tile `index` into its texture, once. */
  #bakeTile(tile: Tile, index: number): void {
    const left = index * TILE_WIDTH;
    const res = this.#tileRes;
    const g = this.#bake
      .clear()
      .setScale(res)
      .setPosition(-left * res, 0);
    const solids = this.level.solids;
    for (let i = lowerBound(solids, left - MAX_SOLID_WIDTH); i < solids.length; i++) {
      const s = solids[i]!;
      if (s.x0 > left + TILE_WIDTH + 8) break;
      if (s.x1 < left - 8 || !isStatic(s)) continue;
      // At rest: no beat flare (the steps' flare is drawn over them each frame).
      this.#drawSolid(g, i, 0, 1, 0);
    }
    tile.texture.clear().draw(g).render();
    tile.image.setPosition(left, 0);
    tile.index = index;
  }

  /** The night sky's gradient, drawn again only when the screen's size changes. */
  #drawSkyBase(): void {
    const { width, height } = this.scale;
    const g = this.#skyBase.clear();
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
  }

  #gridLine(
    g: Phaser.GameObjects.Graphics,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    a: number,
  ): void {
    g.lineStyle(6, paletteNumbers.violet, a * 0.15).lineBetween(ax, ay, bx, by);
    g.lineStyle(1.5, paletteNumbers.violet, a).lineBetween(ax, ay, bx, by);
  }

  /** The floor grid rolling toward the player, the horizon's flare and the drop's flash. */
  #drawSky({ beatPhase, beatInBar }: FrameState, camera: number, drop: number): void {
    const { width, height } = this.scale;
    const g = this.#sky.clear();
    const horizon = height * HORIZON;

    // The drop's flash: the sky lights up magenta and violet in turn on every beat.
    const flash = this.#flash;
    if (drop > 0 && !this.#reduced) {
      const hit = Math.pow(Math.max(0, 1 - beatPhase), 2);
      flash
        .setPosition(width / 2, height * 0.6)
        .setDisplaySize(width * 1.5, height * 1.4)
        .setTint(beatInBar % 2 === 0 ? paletteNumbers.magenta : paletteNumbers.violet)
        .setAlpha(drop * (0.12 + 0.4 * hit));
    } else if (drop > 0) {
      // Reduced: a steady glow instead of flashes.
      flash
        .setPosition(width / 2, height * 0.6)
        .setDisplaySize(width * 1.5, height * 1.4)
        .setTint(paletteNumbers.violet)
        .setAlpha(drop * 0.18);
    } else flash.setAlpha(0);

    // Rows roll toward the player, one per beat; columns slide with the camera.
    const depth = height - horizon;
    for (let i = 0; i < GRID_ROWS; i++) {
      const z = (i + beatPhase) / GRID_ROWS;
      const y = horizon + depth * z * z;
      this.#gridLine(g, 0, y, width, y, 0.08 + 0.45 * z);
    }
    const vanish = width / 2;
    const spacing = (width * 3) / GRID_COLUMNS;
    const slide = (camera * this.#zoom * 1.4) % spacing;
    for (let i = 0; i <= GRID_COLUMNS + 1; i++) {
      const x = vanish - width * 1.5 + i * spacing - slide;
      this.#gridLine(g, vanish + (x - vanish) * 0.04, horizon, x, height, 0.32);
    }
    // The horizon flares on every beat, brightest on the bar's first.
    const flare =
      Math.max(0, 1 - beatPhase * 2.5) * (beatInBar === 0 ? 1 : 0.55) * (this.#reduced ? 0.4 : 1);
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

  /** A faint wave line across the sky, drifting with the song. */
  #wave(
    g: Phaser.GameObjects.Graphics,
    camera: number,
    y: number,
    amp: number,
    phase: number,
    color: number,
    w: number,
    a: number,
  ): void {
    const z = this.#zoom;
    const width = this.scale.width;
    const points = this.#quality.wavePoints;
    const top = this.#offsetY + y * z;
    g.lineStyle(w * z, color, a);
    g.beginPath();
    for (let i = 0; i <= points; i++) {
      const x = (i / points) * width;
      const u = (x / z + camera * 0.15) / 300 + phase;
      const yy = top + Math.sin(u * Math.PI) * amp * z;
      if (i === 0) g.moveTo(x, yy);
      else g.lineTo(x, yy);
    }
    g.strokePath();
  }

  /** One of the drop's big waveforms, `sign` up or down, swelling with the beat. */
  #bigWave(
    g: Phaser.GameObjects.Graphics,
    time: number,
    sign: number,
    swell: number,
    color: number,
    w: number,
    alpha: number,
  ): void {
    const z = this.#zoom;
    const width = this.scale.width;
    const points = this.#quality.dropWavePoints;
    const middle = this.#offsetY + 232 * z;
    g.lineStyle(w * z, color, alpha);
    g.beginPath();
    for (let i = 0; i <= points; i++) {
      const x = (i / points) * width;
      const u = x / z / 180 + time * 1.2;
      const yy = middle + sign * Math.sin(u * Math.PI) * 100 * swell * z;
      if (i === 0) g.moveTo(x, yy);
      else g.lineTo(x, yy);
    }
    g.strokePath();
  }

  /** Faint wave lines, the speaker with its rings, and the drop's big waveforms. */
  #drawBack({ time, beatPhase }: FrameState, camera: number, drop: number): void {
    const g = this.#back.clear();
    const z = this.#zoom;
    const level = this.level;
    const beatIndex = Math.floor((time - level.gridStart) / level.beatPeriod);
    const energy = this.#music.energy[Math.max(0, beatIndex)] ?? 0.4;

    // Two faint wave lines across the sky, drifting with the song, taller when it's loud.
    const amp = 18 + 22 * energy;
    this.#wave(g, camera, 156, amp, time * 0.4, paletteNumbers.violet, 1.5, 0.35);
    this.#wave(g, camera, 180, amp * 0.8, time * 0.4 + 0.35, paletteNumbers.magenta, 1, 0.22);

    // The speaker: a violet light that thumps on every kick, sending out rings.
    const cx = this.#offsetX + VIEW_WIDTH * 0.77 * z;
    const cy = this.#offsetY + VIEW_HEIGHT * 0.37 * z;
    const radius = VIEW_WIDTH * 0.11 * z;
    const kicks = this.#music.kicks;
    const ringLife = RING_BEATS * level.beatPeriod;
    let last = -1;
    for (let lo = 0, hi = kicks.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1;
      if (kicks[mid]!.time <= time) {
        last = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let thump = 0;
    for (let i = last; i >= 0; i--) {
      const kick = kicks[i]!;
      const age = time - kick.time;
      if (age > ringLife) break;
      const k = age / ringLife;
      const strength = 0.5 + 0.5 * kick.intensity;
      if (i === last) thump = Math.max(0, 1 - age / (0.4 * level.beatPeriod)) * strength;
      const r = radius * (0.3 + 1.1 * (1 - Math.pow(1 - k, 2)));
      g.lineStyle(7 * z, paletteNumbers.violet, 0.12 * (1 - k) * strength).strokeCircle(cx, cy, r);
      g.lineStyle(2 * z, paletteNumbers.violet, 0.9 * (1 - k) * strength).strokeCircle(cx, cy, r);
    }
    const core = radius * 0.24 * (0.9 + 0.35 * thump);
    g.fillStyle(paletteNumbers.violet, 0.12 + 0.1 * thump).fillCircle(cx, cy, core * 2.6);
    g.fillStyle(paletteNumbers.violet, 0.5).fillCircle(cx, cy, core * 1.5);
    g.fillStyle(paletteNumbers.violet, 1).fillCircle(cx, cy, core);
    g.fillStyle(paletteNumbers.flare, 0.6 + 0.4 * thump).fillCircle(cx, cy, core * 0.45);

    // The drop: two big waveforms ripple across the sky, swelling on every beat.
    if (drop > 0) {
      const swell = 0.4 + 0.75 * (0.5 - 0.5 * Math.cos(beatPhase * Math.PI * 2));
      this.#bigWave(g, time, 1, swell, paletteNumbers.magenta, 12, 0.12 * 0.9 * drop);
      this.#bigWave(g, time, 1, swell, paletteNumbers.magenta, 3, 0.9 * drop);
      this.#bigWave(g, time, -1, swell, paletteNumbers.cyan, 12, 0.12 * 0.7 * drop);
      this.#bigWave(g, time, -1, swell, paletteNumbers.cyan, 3, 0.7 * drop);
    }
  }

  /** Rounded corners only where a piece ends, not where it runs on into the next. */
  #cornersFor(r: number, joinedLeft: boolean, joinedRight: boolean) {
    const c = this.#corners;
    c.tl = c.bl = joinedLeft ? 0 : r;
    c.tr = c.br = joinedRight ? 0 : r;
    return c;
  }

  /** A column (ground, step, equaliser) or a ledge, as it is at `t`. */
  #drawSolid(
    g: Phaser.GameObjects.Graphics,
    index: number,
    t: number,
    beatPhase: number,
    drop: number,
  ): void {
    const s = this.level.solids[index]!;
    const top = solidTop(s, t);
    if (top === null) return;
    const w = s.x1 - s.x0;
    if (s.kind === 'ledge') {
      g.fillStyle(paletteNumbers.cyan, 0.2).fillRoundedRect(s.x0 - 4, sy(top) - 4, w + 8, 17, 8);
      g.fillStyle(paletteNumbers.cyan, 1).fillRoundedRect(s.x0, sy(top), w, 9, 4.5);
      return;
    }
    const joinedLeft = this.#joinedLeft[index] === 1;
    const joinedRight = this.#joinedRight[index] === 1;
    // The drop's staircase in the drop colour; the rest is the world's violet.
    const color = s.kind === 'step' ? paletteNumbers.magenta : paletteNumbers.violet;
    const y = sy(top);
    const bottom = sy(PIT_DEPTH);
    const pulse = Math.max(0, 1 - beatPhase * 3);
    // Joined pieces run into each other; free ends get an edge and a rounded cap.
    const a = joinedLeft ? s.x0 : s.x0 + 1;
    const b = joinedRight ? s.x1 : s.x1 - 1;
    // The body fades into the pit, with faint edges; ground is a little more solid.
    const body = s.kind === 'ground' ? 0.2 : 0.3;
    g.fillGradientStyle(color, color, color, color, body, body, 0, 0).fillRect(
      a,
      y,
      b - a,
      bottom - y,
    );
    g.lineStyle(1, color, 0.3);
    if (!joinedLeft) g.lineBetween(s.x0 + 1.5, y, s.x0 + 1.5, bottom);
    if (!joinedRight) g.lineBetween(s.x1 - 1.5, y, s.x1 - 1.5, bottom);
    // The cap: a halo, the bright edge and a hot line on it. Equalisers and the
    // staircase flare on the beat, the staircase more through the drop.
    const flare =
      s.kind === 'eq' ? 0.35 * pulse : s.kind === 'step' ? (0.3 + 0.5 * drop) * pulse : 0;
    const haloA = joinedLeft ? s.x0 : s.x0 - 2;
    const haloB = joinedRight ? s.x1 : s.x1 + 2;
    g.fillStyle(color, 0.22 + flare).fillRoundedRect(
      haloA,
      y - 7,
      haloB - haloA,
      16,
      this.#cornersFor(5, joinedLeft, joinedRight),
    );
    g.fillStyle(color, 1).fillRoundedRect(
      a,
      y,
      b - a,
      6,
      this.#cornersFor(2, joinedLeft, joinedRight),
    );
    const insetA = joinedLeft ? s.x0 : s.x0 + 4;
    const insetB = joinedRight ? s.x1 : s.x1 - 4;
    g.fillStyle(paletteNumbers.flare, 0.35 + 0.4 * flare).fillRect(
      insetA,
      y + 1,
      insetB - insetA,
      1.5,
    );
  }

  /** A step's beat flare, over its cap drawn at rest in the tiles. */
  #drawStepFlare(
    g: Phaser.GameObjects.Graphics,
    index: number,
    beatPhase: number,
    drop: number,
  ): void {
    const flare = (0.3 + 0.5 * drop) * Math.max(0, 1 - beatPhase * 3);
    if (flare < 0.01) return;
    const s = this.level.solids[index]!;
    const joinedLeft = this.#joinedLeft[index] === 1;
    const joinedRight = this.#joinedRight[index] === 1;
    const y = sy(s.top);
    const haloA = joinedLeft ? s.x0 : s.x0 - 2;
    const haloB = joinedRight ? s.x1 : s.x1 + 2;
    g.fillStyle(paletteNumbers.magenta, flare).fillRoundedRect(
      haloA,
      y - 7,
      haloB - haloA,
      16,
      this.#cornersFor(5, joinedLeft, joinedRight),
    );
    const insetA = joinedLeft ? s.x0 : s.x0 + 4;
    const insetB = joinedRight ? s.x1 : s.x1 - 4;
    g.fillStyle(paletteNumbers.flare, 0.4 * flare).fillRect(insetA, y + 1, insetB - insetA, 1.5);
  }

  #dot(texture: string): Phaser.GameObjects.Image {
    let image = this.#dotImages[this.#dotsShown];
    if (!image) {
      image = this.add.image(0, 0, texture).setOrigin(0, 0);
      this.#dots.add(image);
      this.#dotImages.push(image);
    }
    this.#dotsShown++;
    return image.setTexture(texture).setVisible(true);
  }

  /**
   * A dotted bridge: lit while it is there; a faint dotted outline where it will be, so the
   * gap shows; blinking in over the half beat before it comes out on its snare.
   */
  #placeBridge(s: Solid, t: number): void {
    const w = s.x1 - s.x0;
    const count = Math.max(2, Math.round(w / 18));
    const step = w / count;
    const dot = step * 0.62;
    const y = sy(s.top);
    let lit = solidTop(s, t) === null ? 0 : 1;
    if (lit === 0) {
      // Coming out soon: fades in, blinking on the sixteenths (steady with effects reduced).
      const period = this.level.beatPeriod;
      let next = Infinity;
      for (const [from] of s.windows!) if (from > t && from < next) next = from;
      const ahead = (next - t) / period;
      if (ahead < BRIDGE_WARN_BEATS) {
        const fade = 1 - ahead / BRIDGE_WARN_BEATS;
        const blink = this.#reduced || (ahead * 4) % 1 < 0.5 ? 1 : 0.35;
        lit = 0.6 * fade * blink;
      }
    }
    for (let i = 0; i < count; i++) {
      const x = s.x0 + i * step + (step - dot) / 2;
      if (lit < 1)
        this.#dot(DOT_OUTLINE).setPosition(x, y).setDisplaySize(dot, DOT_H).setAlpha(0.45);
      if (lit > 0)
        this.#dot(DOT)
          .setPosition(x - DOT_HALO, y - DOT_HALO)
          .setDisplaySize(dot + 2 * DOT_HALO, DOT_H + 2 * DOT_HALO)
          .setAlpha(lit);
    }
  }

  #drawSpikes(g: Phaser.GameObjects.Graphics, t: number, x0: number, x1: number): void {
    const out = spikesOut(this.level, t);
    const phase = (t - this.level.gridStart) / this.level.beatPeriod;
    const p = phase - Math.floor(phase);
    // Tucked in on the beat, rising a little just before the off-beat as a warning, then
    // out (and deadly) until the next beat.
    const warn = Math.max(0, Math.min(1, (p - 0.3) / 0.2));
    const height = SPIKE_HEIGHT * (out ? 1 : 0.18 + 0.22 * warn * warn);
    const spikes = this.level.spikes;
    for (let i = lowerBound(spikes, x0 - VIEW_WIDTH); i < spikes.length; i++) {
      const s = spikes[i]!;
      if (s.x0 > x1) break;
      if (s.x1 < x0) continue;
      const count = Math.max(1, Math.round((s.x1 - s.x0) / 12));
      const step = (s.x1 - s.x0) / count;
      const base = sy(s.top);
      if (out)
        g.fillStyle(paletteNumbers.orange, 0.2).fillRoundedRect(
          s.x0 - 2,
          base - height - 6,
          s.x1 - s.x0 + 4,
          height + 6,
          4,
        );
      g.fillStyle(paletteNumbers.orange, out ? 1 : 0.7);
      for (let k = 0; k < count; k++) {
        const a = s.x0 + k * step;
        g.fillTriangle(a, base, a + step / 2, base - height, a + step, base);
      }
    }
  }

  #drawPickups(
    g: Phaser.GameObjects.Graphics,
    run: PlatformerRun,
    { time, beatPhase }: FrameState,
    x0: number,
    x1: number,
  ): void {
    const bob = Math.sin(beatPhase * Math.PI * 2) * 3;
    const pickups = run.level.pickups;
    // Sorted by song time, and each near where the anchored player is then.
    const speed = this.level.speed;
    const from = (x0 - ANCHOR_X - PICKUP_MARGIN) / speed;
    const to = (x1 - ANCHOR_X + PICKUP_MARGIN) / speed;
    let lo = 0;
    for (let hi = pickups.length; lo < hi;) {
      const mid = (lo + hi) >> 1;
      if (pickups[mid]!.time < from) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < pickups.length; i++) {
      const k = pickups[i]!;
      if (k.time > to) break;
      if (k.x < x0 || k.x > x1 || run.isCollected(i)) continue;
      const r = k.kind === 'gem' ? 12 : 7;
      const x = k.x;
      const y = sy(k.y) + bob;
      // Spinning: the diamond narrows and widens.
      const spin = 0.55 + 0.45 * Math.abs(Math.cos(time * 3 + i));
      const rx = r * spin;
      g.fillStyle(paletteNumbers.magenta, 0.18).fillCircle(x, y, r * 1.9);
      g.fillStyle(paletteNumbers.magenta, 1).fillTriangle(x - rx, y, x, y - r * 1.3, x + rx, y);
      g.fillTriangle(x - rx, y, x, y + r * 1.3, x + rx, y);
      if (k.kind === 'gem') g.fillStyle(paletteNumbers.flare, 0.9).fillCircle(x, y, 3);
    }
  }

  /** The cube, drawn once around its centre; it is moved, turned and squashed each frame. */
  #drawCube(g: Phaser.GameObjects.Graphics): void {
    const w = PLAYER_WIDTH;
    const h = PLAYER_HEIGHT;
    const r = 8;
    g.fillStyle(paletteNumbers.cyan, 0.16).fillRoundedRect(
      -w / 2 - 7,
      -h / 2 - 7,
      w + 14,
      h + 14,
      14,
    );
    g.fillStyle(paletteNumbers.cyan, 1).fillRoundedRect(-w / 2, -h / 2, w, h, r);
    g.lineStyle(2.5, paletteNumbers.rim, 1).strokeRoundedRect(
      -w / 2 + 2.5,
      -h / 2 + 2.5,
      w - 5,
      h - 5,
      r - 2,
    );
    // Eyes, looking ahead.
    g.fillStyle(paletteNumbers.night, 1);
    g.fillRoundedRect(w * 0.12, -h * 0.22, 4.5, h * 0.24, 1.5);
    g.fillRoundedRect(w * 0.12 - 10, -h * 0.22, 4.5, h * 0.24, 1.5);
  }

  /** The cube's place, turn and squash at song time `t`. */
  #placePlayer(run: PlatformerRun, t: number, beatPhase: number): void {
    const p = run.player;
    const cube = this.#player;
    if (!p.alive) {
      cube.setVisible(false);
      return;
    }
    // Squash on landing, stretch on the way up.
    let sx = 1;
    let sY = 1;
    const sinceLanding = t - run.landedAt;
    if (sinceLanding >= 0 && sinceLanding < SQUASH_TIME) {
      const k = 1 - sinceLanding / SQUASH_TIME;
      sx = 1 + 0.3 * k;
      sY = 1 - 0.25 * k;
    } else if (!p.grounded && p.vy > 0) {
      const k = Math.min(1, p.vy / 820);
      sx = 1 - 0.14 * k;
      sY = 1 + 0.16 * k;
    }
    // A jump flips the cube once, finishing quickly on landing if it came down early.
    let angle = 0;
    if (p.jumped && !p.grounded) angle = Math.min(1, (t - run.jumpedAt) / FLIP_TIME) * 360;
    else if (!p.grounded) angle = Math.max(-12, Math.min(12, -p.vy / 40));
    else if (run.jumpedAt < run.landedAt && sinceLanding < SQUASH_TIME) {
      const airborne = (run.landedAt - run.jumpedAt) / FLIP_TIME;
      const from = Math.min(1, airborne) * 360;
      angle = from + (360 - from) * Math.min(1, sinceLanding / SQUASH_TIME);
      if (angle >= 359.5) angle = 0;
    }
    const facing = p.vx < 0 ? -1 : 1;
    // Blink with the beat while counting in.
    const alpha = run.phase === 'countin' ? 0.55 + 0.45 * Math.max(0, 1 - beatPhase * 2) : 1;
    const centreY = sy(p.y + (PLAYER_HEIGHT * sY) / 2);
    cube
      .setVisible(true)
      .setPosition(p.x + PLAYER_WIDTH / 2, centreY)
      .setScale(sx * facing, sY)
      .setAngle(angle * facing)
      .setAlpha(alpha);
  }

  /** Trail point `i` (0 the oldest), as an index into the ring. */
  #trailAt(i: number): number {
    return (this.#trailStart + i) % TRAIL_CAPACITY;
  }

  /** Where the ribbon's edge crosses trail point `i`, into `#edge`. */
  #trailEdge(i: number, t: number): void {
    const n = this.#trailLength;
    const s = this.#trailAt(i);
    const next = this.#trailAt(Math.min(i + 1, n - 1));
    const prev = this.#trailAt(Math.max(i - 1, 0));
    const xs = this.#trailX;
    const ys = this.#trailY;
    const dx = xs[next]! - xs[prev]!;
    const dy = sy(ys[next]!) - sy(ys[prev]!);
    const length = Math.hypot(dx, dy) || 1;
    const half = (PLAYER_HEIGHT / 2) * (0.25 + 0.6 * (1 - (t - this.#trailT[s]!) / TRAIL_TIME));
    const nx = (-dy / length) * half;
    const ny = (dx / length) * half;
    const e = this.#edge;
    e.ax = xs[s]! + nx;
    e.ay = sy(ys[s]!) + ny;
    e.bx = xs[s]! - nx;
    e.by = sy(ys[s]!) - ny;
  }

  /** A light trail: where the cube was a moment ago, fading out. */
  #drawTrail(g: Phaser.GameObjects.Graphics, run: PlatformerRun, t: number): void {
    const p = run.player;
    const times = this.#trailT;
    // Played again from earlier (a rewind): the trail starts over.
    if (this.#trailLength && times[this.#trailAt(this.#trailLength - 1)]! > t)
      this.#trailLength = 0;
    if (p.alive && run.phase !== 'countin') {
      if (this.#trailLength === TRAIL_CAPACITY) {
        this.#trailStart = (this.#trailStart + 1) % TRAIL_CAPACITY;
        this.#trailLength--;
      }
      const at = this.#trailAt(this.#trailLength++);
      times[at] = t;
      this.#trailX[at] = p.x + PLAYER_WIDTH / 2;
      this.#trailY[at] = p.y + PLAYER_HEIGHT / 2;
    }
    while (this.#trailLength && t - times[this.#trailStart]! > TRAIL_TIME) {
      this.#trailStart = (this.#trailStart + 1) % TRAIL_CAPACITY;
      this.#trailLength--;
    }
    if (!p.alive || this.#trailLength < 2) return;
    // A ribbon narrowing and fading with age: quads sharing their edges, so nothing
    // overlaps and the alpha stays even at any frame rate.
    const e = this.#edge;
    this.#trailEdge(0, t);
    let ax = e.ax;
    let ay = e.ay;
    let bx = e.bx;
    let by = e.by;
    for (let i = 0; i < this.#trailLength - 1; i++) {
      this.#trailEdge(i + 1, t);
      const k = 1 - (t - times[this.#trailAt(i)]!) / TRAIL_TIME;
      g.fillStyle(paletteNumbers.cyan, 0.4 * k);
      g.fillTriangle(ax, ay, e.ax, e.ay, e.bx, e.by);
      g.fillTriangle(ax, ay, e.bx, e.by, bx, by);
      ax = e.ax;
      ay = e.ay;
      bx = e.bx;
      by = e.by;
    }
  }

  #drawBursts(g: Phaser.GameObjects.Graphics, t: number): void {
    const bursts = this.#bursts;
    const share = this.#quality.particles;
    // Drawn and kept in place: the ones still going move to the front.
    let kept = 0;
    for (const b of bursts) {
      const spec = BURSTS[b.kind];
      const age = t - b.at;
      if (age < 0 || age > spec.life) continue;
      bursts[kept++] = b;
      const k = age / spec.life;
      const fade = 1 - k;
      const count = Math.max(1, Math.round(spec.count * share));
      for (let i = 0; i < count; i++) {
        const r1 = hash(b.seed, i);
        const r2 = hash(b.seed, i + 50);
        let angle: number;
        if (b.kind === 'land') angle = Math.PI * (r1 < 0.5 ? 0.05 + r1 * 0.4 : 0.55 + r1 * 0.4);
        else angle = (i / count) * Math.PI * 2 + r1 * 0.4;
        const speed = spec.speed * (0.55 + 0.6 * r2);
        // Eased out: fast at first, slowing as they fade.
        const d = speed * spec.life * (1 - Math.pow(1 - k, 2));
        const gravity = b.kind === 'land' ? 0 : 260 * age * age;
        const x = b.x + Math.cos(angle) * d;
        const y = b.y + Math.sin(angle) * d - gravity;
        const size = (b.kind === 'land' ? 4 : b.kind === 'drop' ? 9 : 6) * (1 - 0.6 * k);
        const color =
          b.kind === 'land'
            ? paletteNumbers.cyan
            : b.kind === 'spark'
              ? i % 3 === 0
                ? paletteNumbers.flare
                : paletteNumbers.magenta
              : DROP_COLORS[i % 3]!;
        g.fillStyle(color, 0.25 * fade).fillRect(x - size, sy(y) - size, size * 2, size * 2);
        g.fillStyle(color, fade).fillRect(x - size / 2, sy(y) - size / 2, size, size);
      }
    }
    bursts.length = kept;
  }

  #drawShards(g: Phaser.GameObjects.Graphics, age: number): void {
    const at = this.#death;
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
