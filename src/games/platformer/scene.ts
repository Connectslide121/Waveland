import * as Phaser from 'phaser';
import {
  beatAt,
  curveAt,
  getEffects,
  onSettingsChange,
  periodAt,
  type LevelMap,
  type MoodCurves,
} from '../../core';
import { palette, paletteNumbers } from '../../theme/palette';
import {
  cameraAt,
  lowerBound,
  MAX_SOLID_WIDTH,
  solidTop,
  spikesOut,
  timeAtX,
  type PlatformerLevel,
  type Solid,
} from './level';
import { FrameMonitor, QUALITY, type Quality } from './perf';
import {
  DASH_TIME,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  SPIKE_HEIGHT,
  VIEW_HEIGHT,
  VIEW_WIDTH,
} from './physics';
import { DEATH_TIME, MAGNET_RADIUS, type PlatformerRun, type RunEvent } from './run';

/**
 * Draws the platformer in the Neon arcade look (docs/concept/look.html) from song time:
 * the synth grid, wave lines and the speaker pulsing on every kick behind; the level as it
 * is at that moment; the player, its trail and the particles; the drop's set piece. Nothing
 * here moves by frame time: every frame the session hands it the audio clock's time and it
 * draws what is there then, so a pause freezes it and a rewind plays it again.
 *
 * Glow comes from bloom on the camera, over wide faint strokes under thin bright ones.
 * The look follows the song's mood (`LevelMap.mood`): the louder the music, the faster
 * the grid rolls, the stronger the glow, the thicker its lines, the taller the waves and
 * the harder the speaker thumps, and the more magenta comes in over the world's violet.
 * Every platform in view pulses on the kick (its cap squashes and glows) and its edges
 * flash on the snare; drawn only, so collisions stay exact. With effects reduced there
 * are no flashes and no screen shake.
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
const FLOATERS = 10;
/** A banner (a clean section, overdrive) shows for this long, in song seconds. */
const BANNER_TIME = 1.6;
/** A coin pulled by the magnet flies to the cube in this long. */
const ZIP_TIME = 0.2;
const ZIPS = 8;
/** Overdrive fades in and out over this long, in song seconds. */
const OVERDRIVE_FADE = 0.3;
/** The shield's ring around the cube, px. */
const SHIELD_RADIUS = 34;
/** Each booster's colour: the shield and the extra dash the player's, the magnet the score's. */
const BOOSTER_COLOR = {
  shield: { fill: paletteNumbers.cyan, text: palette.cyan },
  magnet: { fill: paletteNumbers.magenta, text: palette.magenta },
  dash: { fill: paletteNumbers.cyan, text: palette.cyan },
} as const;
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
/** A dash leaves this many afterimages, and speed lines behind the cube. */
const AFTERIMAGES = 4;
const SPEED_LINES = 6;
/** A smashed gate's pieces fly for this long, and a slam's shockwave spreads this long. */
const SMASH_TIME = 0.4;
const SHOCK_TIME = 0.45;

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
    b.bottom === a.bottom &&
    (Math.abs(b.x1 - a.x0) < 0.5 || Math.abs(b.x0 - a.x1) < 0.5)
  );
}

/** True when any of the few solids before (`step` -1) or after (+1) `i` joins it: an overhang can sit between two pieces of ground. */
function joinsNear(solids: Solid[], i: number, step: 1 | -1): boolean {
  for (let k = 1; k <= 3; k++) if (joins(solids[i]!, solids[i + step * k])) return true;
  return false;
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

/** `a` and `b` (0xRRGGBB) mixed, `k` of the way to `b`. */
function mix(a: number, b: number, k: number): number {
  const c = Math.max(0, Math.min(1, k));
  const ch = (shift: number) => {
    const x = (a >> shift) & 0xff;
    const y = (b >> shift) & 0xff;
    return Math.round(x + (y - x) * c) << shift;
  };
  return ch(16) | ch(8) | ch(0);
}

/** The index of the last item at or before `time` in a list sorted by time, or -1. */
function latest(list: readonly { time: number }[], time: number): number {
  let last = -1;
  for (let lo = 0, hi = list.length - 1; lo <= hi;) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.time <= time) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return last;
}

/** How long a platform's kick pulse and snare flash last, in beats and seconds. */
const PULSE_BEATS = 0.35;
const FLASH_TIME = 0.14;
/** Grid rows rolling by per beat: calm to loud. */
const ROLL_CALM = 0.5;
const ROLL_LOUD = 1.5;

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
  drop: { life: 0.7, count: 28, speed: 420 },
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
  /** Snare times and strengths, sorted (the clear ones). */
  snares: { time: number; intensity: number }[];
  /** The song's mood per grid beat. */
  mood: MoodCurves;
  /** Grid rows rolled by the start of each beat, faster where the song is louder. */
  roll: Float64Array;
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
  /** The cube burning magenta in overdrive, shown over the cyan one. */
  #hot!: Phaser.GameObjects.Graphics;
  #callout!: Phaser.GameObjects.Text;
  /** A clean section's or an overdrive's banner, and the song time it came. */
  #banner!: Phaser.GameObjects.Text;
  #bannerAt = -Infinity;
  /** Coins the magnet pulled, flying to the cube: where from, and when. */
  readonly #zips = Array.from({ length: ZIPS }, () => ({ x: 0, y: 0, at: -Infinity }));
  /** How strong overdrive is this frame, 0 to 1. */
  #overdrive = 0;
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
  /** The mood this frame: intensity, brightness and the grid's roll, refreshed in `#draw`. */
  readonly #mood = { intensity: 0.5, brightness: 0.5, roll: 0 };
  /** Where the player died, for the shards. */
  #death = { x: 0, y: 0, shown: false };
  /** The last slam's shockwave: where, when, and whether it landed on the beat. */
  #shock = { x: 0, y: 0, at: -Infinity, onBeat: false };
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
      snares: map.events
        .filter((e) => e.kind === 'snare' && e.intensity >= 0.3)
        .map((e) => ({ time: e.time, intensity: e.intensity })),
      mood: map.mood,
      roll: new Float64Array(map.beats.length + 1),
    };
    const roll = this.#music.roll;
    for (let k = 0; k < map.beats.length; k++)
      roll[k + 1] = roll[k]! + ROLL_CALM + (ROLL_LOUD - ROLL_CALM) * (map.mood.intensity[k] ?? 0.5);
    const solids = level.solids;
    this.#joinedLeft = new Uint8Array(solids.length);
    this.#joinedRight = new Uint8Array(solids.length);
    for (let i = 0; i < solids.length; i++) {
      this.#joinedLeft[i] = joinsNear(solids, i, -1) ? 1 : 0;
      this.#joinedRight[i] = joinsNear(solids, i, 1) ? 1 : 0;
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
    this.#drawCube(this.#player, paletteNumbers.cyan, paletteNumbers.rim);
    this.#hot = this.add.graphics().setVisible(false);
    this.#drawCube(this.#hot, paletteNumbers.magenta, paletteNumbers.flare);
    this.#layer = this.add.container(0, 0, [
      this.#tileLayer,
      this.#dots,
      this.#world,
      this.#fx,
      this.#player,
      this.#hot,
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
    this.#banner = this.add
      .text(0, 0, '', {
        fontFamily: FONT,
        fontSize: '22px',
        fontStyle: '700',
        color: palette.flare,
        letterSpacing: 8,
        resolution: 2,
      })
      .setOrigin(0.5)
      .setShadow(0, 0, palette.magenta, 14, false, true)
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
      } else if (e.type === 'beat') {
        if (e.action === 'slam') {
          const s = this.#shock;
          s.x = e.x;
          s.y = e.y;
          s.at = time;
          s.onBeat = e.quality !== 'miss';
        }
        // A small word at the cube: how close it was, ACCENT on an accent, magenta when perfect.
        const y = e.y + PLAYER_HEIGHT + 24;
        if (e.quality === 'miss') this.#float('MISS', e.x, y, time, palette.muted);
        else {
          const word = e.accent ? 'ACCENT' : e.quality === 'perfect' ? 'PERFECT' : 'GOOD';
          const hot = e.quality === 'perfect' || e.accent;
          this.#float(`${word} +${e.points}`, e.x, y, time, hot ? palette.magenta : palette.ink);
        }
      } else if (e.type === 'pickup') {
        const k = run.level.pickups[e.index]!;
        if (k.kind === 'coin' || k.kind === 'gem') {
          this.#float(`+${e.points}`, k.x, k.y + 18, time, palette.magenta);
          if (e.pulled) this.#zip(k.x, k.y, time);
          else this.#burst('spark', k.x, k.y, time);
        } else {
          const name = { shield: 'SHIELD', magnet: 'MAGNET', dash: 'DASH +1' }[k.kind];
          this.#float(name, k.x, k.y + 22, time, BOOSTER_COLOR[k.kind].text);
          this.#burst('spark', k.x, k.y, time);
        }
      } else if (e.type === 'streak') {
        this.#float(
          `STREAK ${e.count} +${e.points}`,
          e.x,
          e.y + PLAYER_HEIGHT + 52,
          time,
          palette.flare,
        );
        this.#burst('drop', e.x, e.y + PLAYER_HEIGHT / 2, time);
      } else if (e.type === 'overdrive') {
        this.#showBanner('OVERDRIVE', time);
        if (e.downbeat)
          this.#float(`DOWNBEAT +${e.points}`, e.x, e.y + PLAYER_HEIGHT + 52, time, palette.flare);
        this.#burst('drop', e.x, e.y + PLAYER_HEIGHT / 2, time);
      } else if (e.type === 'clean') {
        this.#showBanner(`CLEAN SECTION +${e.points}`, time);
      } else if (e.type === 'shield') {
        this.#float('SHIELD', e.x, e.y + PLAYER_HEIGHT + 24, time, palette.cyan);
        this.#burst('land', e.x, e.y, time);
      }
    }
  }

  /** Forget effects tied to song times that are being played again. */
  reset(): void {
    this.#death.shown = false;
    this.#shock.at = -Infinity;
    for (const f of this.#floaters) {
      f.at = -Infinity;
      f.text.setVisible(false);
    }
    this.#bursts.length = 0;
    this.#bannerAt = -Infinity;
    this.#banner.setAlpha(0);
    for (const z of this.#zips) z.at = -Infinity;
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

  /** A coin pulled by the magnet: it flies from where it was to the cube. */
  #zip(x: number, y: number, at: number): void {
    let zip = this.#zips[0]!;
    for (const z of this.#zips) if (z.at < zip.at) zip = z;
    zip.x = x;
    zip.y = y;
    zip.at = at;
  }

  #showBanner(text: string, at: number): void {
    this.#banner.setText(text);
    this.#bannerAt = at;
  }

  /** How strong overdrive is at `t`: fading in as it starts and out as it ends. */
  #overdriveAt(run: PlatformerRun, t: number): number {
    const { from, until } = run.overdrive;
    if (t < from || t > until + OVERDRIVE_FADE) return 0;
    return Math.max(
      0,
      Math.min(1, (t - from) / OVERDRIVE_FADE, (until + OVERDRIVE_FADE - t) / OVERDRIVE_FADE),
    );
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
    let level = 0;
    for (const d of this.#music.drops) {
      if (t < d.start) break;
      if (t < d.end) return 1;
      const bars = (beatAt(this.level.grid, t) - beatAt(this.level.grid, d.end)) / 4;
      level = Math.max(level, 1 - bars / CALM_BARS);
    }
    return level;
  }

  #draw(state: FrameState): void {
    const { time, run } = state;
    const level = this.level;
    // The camera's left edge, shaken for a moment after a death.
    let camera = cameraAt(level, time);
    let shakeY = 0;
    const sinceDeath = run.phase === 'dying' ? time - run.diedAt : Infinity;
    if (sinceDeath < 0.3 && !this.#reduced) {
      const k = 1 - sinceDeath / 0.3;
      camera += Math.sin(sinceDeath * 90) * 7 * k;
      shakeY = Math.cos(sinceDeath * 70) * 5 * k;
    }
    const drop = this.#dropLevel(time);
    const beats = beatAt(level.grid, time);
    const beat = Math.floor(beats + 1e-6);
    const mood = this.#mood;
    const music = this.#music;
    mood.intensity = Math.max(curveAt(music.mood.intensity, beats), drop);
    mood.brightness = curveAt(music.mood.brightness, beats);
    const k = Math.max(0, Math.min(music.roll.length - 2, Math.floor(beats)));
    mood.roll = music.roll[k]! + (music.roll[k + 1]! - music.roll[k]!) * Math.max(0, beats - k);
    // The glow follows the mood: soft in calm parts, strong when it is loud, and overdrive.
    const od = (this.#overdrive = this.#overdriveAt(run, time));
    if (this.#bloom) this.#bloom.blur.strength = 1.1 + 0.9 * mood.intensity + 0.4 * od;

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
      // What moves (equalisers, heaving and floating ground, ground reshaping) every frame.
      else if (solid.keys) this.#drawSolid(g, i, time, state.beatPhase, drop);
      else if (solid.kind === 'step') this.#drawStepFlare(g, i, state.beatPhase, drop);
      // Still ground and ledges are in the tiles.
    }
    this.#drawPulse(g, time, x0, x1);
    const dots = this.#dotImages;
    for (let i = this.#dotsShown; i < dots.length && dots[i]!.visible; i++)
      dots[i]!.setVisible(false);
    this.#drawSpikes(g, time, x0, x1);
    this.#drawGates(g, run, state, x0, x1);
    this.#drawPickups(g, run, state, x0, x1);

    const fx = this.#fx.clear();
    this.#drawTrail(fx, run, time);
    this.#drawDash(fx, run, time);
    this.#drawSlam(fx, run, time);
    this.#drawBoosters(fx, run, time, state.beatPhase);
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
    // A banner under it: in quickly, held, then out.
    const bannerAge = time - this.#bannerAt;
    const bannerAlpha =
      bannerAge < 0 || bannerAge > BANNER_TIME
        ? 0
        : Math.min(1, bannerAge / 0.08, (BANNER_TIME - bannerAge) / 0.4);
    this.#banner
      .setPosition(this.#offsetX + (VIEW_WIDTH / 2) * this.#zoom, this.#offsetY + 150 * this.#zoom)
      .setScale(this.#zoom * (1 + 0.15 * Math.max(0, 1 - bannerAge / 0.15)))
      .setAlpha(bannerAlpha);

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

  /** The grid's colour, line width and brightness this frame, from the mood. */
  readonly #grid = { color: paletteNumbers.violet, width: 1, alpha: 1 };

  #gridLine(
    g: Phaser.GameObjects.Graphics,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    a: number,
  ): void {
    const { color, width, alpha } = this.#grid;
    g.lineStyle(6 * width, color, a * alpha * 0.15).lineBetween(ax, ay, bx, by);
    g.lineStyle(1.5 * width, color, Math.min(1, a * alpha)).lineBetween(ax, ay, bx, by);
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
        .setAlpha(drop * (0.15 + 0.5 * hit));
    } else if (drop > 0) {
      // Reduced: a steady glow instead of flashes.
      flash
        .setPosition(width / 2, height * 0.6)
        .setDisplaySize(width * 1.5, height * 1.4)
        .setTint(paletteNumbers.violet)
        .setAlpha(drop * 0.18);
    } else if (this.#overdrive > 0) {
      // Overdrive: the world flares magenta with the beat, hardest on the bar's first
      // (a steady glow with effects reduced).
      const hit = this.#reduced
        ? 0.3
        : Math.pow(Math.max(0, 1 - beatPhase), 3) * (beatInBar === 0 ? 1 : 0.7);
      flash
        .setPosition(width / 2, height * 0.7)
        .setDisplaySize(width * 1.5, height * 1.2)
        .setTint(paletteNumbers.magenta)
        .setAlpha(this.#overdrive * (0.06 + 0.34 * hit));
    } else flash.setAlpha(0);

    // The grid follows the mood: dim, thin and violet when calm; bright, thick and
    // magenta-tinged when loud.
    const loud = this.#mood.intensity;
    const grid = this.#grid;
    grid.color = mix(
      paletteNumbers.violet,
      paletteNumbers.magenta,
      ((loud - 0.5) / 0.5) * 0.55 + 0.45 * this.#overdrive,
    );
    grid.width = 0.7 + 0.8 * loud;
    grid.alpha = 0.55 + 0.6 * loud;

    // Rows roll toward the player, faster the louder it is; columns slide with the camera.
    const depth = height - horizon;
    const roll = this.#mood.roll - Math.floor(this.#mood.roll);
    for (let i = 0; i < GRID_ROWS; i++) {
      const z = (i + roll) / GRID_ROWS;
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
    const glow = 0.5 + 0.6 * loud;
    g.lineStyle(8 + 10 * flare, paletteNumbers.magenta, (0.15 + 0.2 * flare) * glow).lineBetween(
      0,
      horizon,
      width,
      horizon,
    );
    g.lineStyle(2 * grid.width, paletteNumbers.magenta, (0.6 + 0.4 * flare) * glow).lineBetween(
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
      const yy = middle + sign * Math.sin(u * Math.PI) * 130 * swell * z;
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
    const period = periodAt(level.grid, time);
    const loud = this.#mood.intensity;

    // Two faint wave lines across the sky, drifting with the song, taller and thicker when
    // it's loud; the magenta one comes up as it gets louder.
    const amp = 10 + 40 * loud;
    const line = 0.8 + 0.6 * loud;
    const magenta = 0.08 + 0.32 * loud;
    this.#wave(g, camera, 156, amp, time * 0.4, paletteNumbers.violet, 1.5 * line, 0.35);
    this.#wave(g, camera, 180, amp * 0.8, time * 0.4 + 0.35, paletteNumbers.magenta, line, magenta);

    // The speaker: a violet light that thumps on every kick, sending out rings: softly when
    // the song is calm, hard when it is loud.
    const cx = this.#offsetX + VIEW_WIDTH * 0.77 * z;
    const cy = this.#offsetY + VIEW_HEIGHT * 0.37 * z;
    const radius = VIEW_WIDTH * 0.11 * z;
    const kicks = this.#music.kicks;
    const ringLife = RING_BEATS * period;
    const last = latest(kicks, time);
    const follow = 0.35 + 0.85 * loud;
    let thump = 0;
    for (let i = last; i >= 0; i--) {
      const kick = kicks[i]!;
      const age = time - kick.time;
      if (age > ringLife) break;
      const k = age / ringLife;
      const strength = (0.5 + 0.5 * kick.intensity) * follow;
      if (i === last) thump = Math.max(0, 1 - age / (0.4 * period)) * strength;
      const r = radius * (0.3 + 1.1 * (1 - Math.pow(1 - k, 2)));
      g.lineStyle(7 * z, paletteNumbers.violet, Math.min(1, 0.12 * (1 - k) * strength));
      g.strokeCircle(cx, cy, r);
      g.lineStyle(2 * z * line, paletteNumbers.violet, Math.min(1, 0.9 * (1 - k) * strength));
      g.strokeCircle(cx, cy, r);
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

  /** A column (ground, step, equaliser, heaving column), a ledge or a floating slab, at `t`. */
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
    if (s.kind === 'float') {
      this.#drawFloat(g, s, sy(top));
      return;
    }
    if (s.kind === 'ledge') {
      g.fillStyle(paletteNumbers.cyan, 0.2).fillRoundedRect(s.x0 - 4, sy(top) - 4, w + 8, 17, 8);
      g.fillStyle(paletteNumbers.cyan, 1).fillRoundedRect(s.x0, sy(top), w, 9, 4.5);
      return;
    }
    const joinedLeft = this.#joinedLeft[index] === 1;
    const joinedRight = this.#joinedRight[index] === 1;
    if (s.bottom !== undefined) {
      this.#drawOverhang(g, s, joinedLeft, joinedRight);
      return;
    }
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
    // The cap: a halo, the bright edge and a hot line on it. Equalisers, heaving columns
    // and the staircase flare on the beat, the staircase more through the drop.
    const flare =
      s.kind === 'eq' || s.kind === 'heave'
        ? 0.35 * pulse
        : s.kind === 'step'
          ? (0.3 + 0.5 * drop) * pulse
          : 0;
    const haloA = joinedLeft ? s.x0 : s.x0 - 2;
    const haloB = joinedRight ? s.x1 : s.x1 + 2;
    if (s.kind === 'heave') {
      // Heaving columns stand a few px apart and many are in view, every frame: square
      // caps, much cheaper than rounded ones and the same at that size.
      g.fillStyle(color, 0.22 + flare).fillRect(haloA, y - 7, haloB - haloA, 16);
      g.fillStyle(color, 1).fillRect(a, y, b - a, 6);
    } else {
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
    }
    const insetA = joinedLeft ? s.x0 : s.x0 + 4;
    const insetB = joinedRight ? s.x1 : s.x1 - 4;
    g.fillStyle(paletteNumbers.flare, 0.35 + 0.4 * flare).fillRect(
      insetA,
      y + 1,
      insetB - insetA,
      1.5,
    );
  }

  /**
   * An overhang: the world's violet hanging from the sky, fading upward, with its bright
   * edge underneath (where the cube passes) and an orange face where it would hit.
   */
  #drawOverhang(
    g: Phaser.GameObjects.Graphics,
    s: Solid,
    joinedLeft: boolean,
    joinedRight: boolean,
  ): void {
    const color = paletteNumbers.violet;
    const top = sy(WORLD_TOP);
    const y = sy(s.bottom!);
    const a = joinedLeft ? s.x0 : s.x0 + 1;
    const b = joinedRight ? s.x1 : s.x1 - 1;
    g.fillGradientStyle(color, color, color, color, 0, 0, 0.32, 0.32).fillRect(
      a,
      top,
      b - a,
      y - top,
    );
    g.fillStyle(color, 0.22).fillRoundedRect(
      joinedLeft ? s.x0 : s.x0 - 2,
      y - 9,
      (joinedRight ? s.x1 : s.x1 + 2) - (joinedLeft ? s.x0 : s.x0 - 2),
      16,
      this.#cornersFor(5, joinedLeft, joinedRight),
    );
    g.fillStyle(color, 1).fillRoundedRect(
      a,
      y - 6,
      b - a,
      6,
      this.#cornersFor(2, joinedLeft, joinedRight),
    );
    g.fillStyle(paletteNumbers.flare, 0.35).fillRect(
      joinedLeft ? s.x0 : s.x0 + 4,
      y - 2.5,
      (joinedRight ? s.x1 : s.x1 - 4) - (joinedLeft ? s.x0 : s.x0 + 4),
      1.5,
    );
    if (!joinedLeft) {
      // The face that kills: orange, brightest at the bottom where a jump would meet it.
      const face = paletteNumbers.orange;
      g.fillGradientStyle(face, face, face, face, 0, 0.25, 0, 0.25).fillRect(
        s.x0 - 3,
        top,
        6,
        y - top,
      );
      g.lineStyle(2, face, 0.9).lineBetween(s.x0 + 1, y - 80, s.x0 + 1, y);
    }
  }

  /**
   * Dash gates: orange barriers from their ground into the sky, humming on the beat. Once
   * the player has dashed through one, its pieces fly on ahead for a moment, then it is
   * gone; a death at it leaves it standing.
   */
  #drawGates(
    g: Phaser.GameObjects.Graphics,
    run: PlatformerRun,
    { time, beatPhase }: FrameState,
    x0: number,
    x1: number,
  ): void {
    const gates = this.level.gates;
    const orange = paletteNumbers.orange;
    const pulse = Math.max(0, 1 - beatPhase * 2.5);
    const top = sy(WORLD_TOP);
    let lo = 0;
    for (let hi = gates.length; lo < hi;) {
      const mid = (lo + hi) >> 1;
      if (gates[mid]!.x < x0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < gates.length; i++) {
      const gate = gates[i]!;
      if (gate.x > x1) break;
      const base = sy(gate.top);
      const stopped =
        run.phase === 'dying' && run.deathCause === 'gate' && Math.abs(run.diedAt - gate.at) < 0.05;
      const age = time - gate.at;
      if (age >= 0 && !stopped) {
        if (age > SMASH_TIME) continue;
        // Smashed: bars flying forward and up, fading.
        const k = age / SMASH_TIME;
        for (let p = 0; p < 9; p++) {
          const r = hash(gate.time * 100, p);
          const px = gate.x + (120 + 260 * r) * age;
          const py = base - 20 - p * 22 - (80 * r - 40) * age * 4 + 300 * age * age;
          g.fillStyle(orange, 1 - k).fillRect(px - 2, py - 7, 4, 14);
        }
        continue;
      }
      g.fillStyle(orange, 0.14 + 0.12 * pulse).fillRect(gate.x - 9, top, 18, base - top);
      g.fillStyle(orange, 0.35).fillRect(gate.x - 4, top, 8, base - top);
      // Bars across, like a force field.
      for (let y = base - 10; y > top; y -= 18)
        g.fillStyle(orange, 0.55 + 0.4 * pulse).fillRect(gate.x - 7, y - 2, 14, 3);
      g.fillStyle(paletteNumbers.flare, 0.7).fillRect(gate.x - 1, top, 2, base - top);
      g.fillStyle(orange, 1).fillRoundedRect(gate.x - 10, base - 6, 20, 6, 2);
    }
  }

  /**
   * A floating slab of a calm part: the world's violet, a thick slab fading downward with
   * nothing under it, and a faint line below it so it reads as floating.
   */
  #drawFloat(g: Phaser.GameObjects.Graphics, s: Solid, y: number): void {
    const color = paletteNumbers.violet;
    const w = s.x1 - s.x0;
    g.fillStyle(color, 0.16).fillRoundedRect(s.x0 - 3, y - 6, w + 6, 26, 8);
    g.fillGradientStyle(color, color, color, color, 0.34, 0.34, 0.04, 0.04);
    g.fillRect(s.x0 + 1, y, w - 2, 18);
    g.fillStyle(color, 1).fillRoundedRect(s.x0, y, w, 5, 2);
    g.fillStyle(paletteNumbers.flare, 0.35).fillRect(s.x0 + 4, y + 1, w - 8, 1.5);
    g.lineStyle(1, color, 0.22).lineBetween(s.x0 + 8, y + 26, s.x1 - 8, y + 26);
  }

  /**
   * Every platform in view pulses on the kick (its cap glows and squashes a little) and
   * its free edges flash on the snare, more the louder the music. Drawn over the tiles
   * and the moving ground; nothing moves for the physics. With effects reduced the pulse
   * is softer, without the squash, and the snare doesn't flash.
   */
  #drawPulse(g: Phaser.GameObjects.Graphics, t: number, x0: number, x1: number): void {
    const music = this.#music;
    const loud = 0.45 + 0.55 * this.#mood.intensity;
    const period = periodAt(this.level.grid, t);
    const k = latest(music.kicks, t);
    const kickAge = k < 0 ? Infinity : t - music.kicks[k]!.time;
    const kick =
      k < 0
        ? 0
        : Math.max(0, 1 - kickAge / (PULSE_BEATS * period)) *
          (0.5 + 0.5 * music.kicks[k]!.intensity) *
          loud *
          (this.#reduced ? 0.5 : 1);
    const n = this.#reduced ? -1 : latest(music.snares, t);
    const snare =
      n < 0
        ? 0
        : Math.max(0, 1 - (t - music.snares[n]!.time) / FLASH_TIME) *
          music.snares[n]!.intensity *
          loud;
    if (kick < 0.02 && snare < 0.02) return;
    const squash = this.#reduced ? 0 : 2.5 * kick;
    const solids = this.level.solids;
    for (let i = lowerBound(solids, x0 - MAX_SOLID_WIDTH); i < solids.length; i++) {
      const s = solids[i]!;
      if (s.x0 > x1) break;
      if (s.x1 < x0 || s.kind === 'bridge' || s.kind === 'overhang') continue;
      const top = solidTop(s, t);
      if (top === null) continue;
      const y = sy(top);
      const left = this.#joinedLeft[i] === 1;
      const right = this.#joinedRight[i] === 1;
      const color =
        s.kind === 'step'
          ? paletteNumbers.magenta
          : s.kind === 'ledge'
            ? paletteNumbers.cyan
            : paletteNumbers.violet;
      if (kick >= 0.02) {
        const a = left ? s.x0 : s.x0 - 3;
        const b = right ? s.x1 : s.x1 + 3;
        g.fillStyle(color, 0.32 * kick).fillRect(a, y - 3 - 8 * kick, b - a, 12 + 8 * kick);
        const inA = left ? s.x0 : s.x0 + 4;
        const inB = right ? s.x1 : s.x1 - 4;
        g.fillStyle(paletteNumbers.flare, 0.7 * kick);
        g.fillRect(inA, y + 1 + squash, inB - inA, 1.5);
      }
      if (snare >= 0.02) {
        const depth = s.kind === 'float' ? 18 : s.kind === 'ledge' ? 9 : 70;
        g.lineStyle(2, paletteNumbers.magenta, 0.9 * snare);
        if (!left) g.lineBetween(s.x0 + 1, y, s.x0 + 1, y + depth);
        if (!right) g.lineBetween(s.x1 - 1, y, s.x1 - 1, y + depth);
      }
    }
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
      let next = Infinity;
      for (const [from] of s.windows!) if (from > t && from < next) next = from;
      const ahead =
        next === Infinity ? Infinity : beatAt(this.level.grid, next) - beatAt(this.level.grid, t);
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
    const phase = beatAt(this.level.grid, t);
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
    const from = timeAtX(this.level, x0 - PICKUP_MARGIN);
    const to = timeAtX(this.level, x1 + PICKUP_MARGIN);
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
      if (k.kind !== 'coin' && k.kind !== 'gem') {
        this.#drawBooster(g, k.kind, k.x, sy(k.y) + bob, beatPhase);
        continue;
      }
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

  /**
   * A booster to pick up, as its HUD slot shows it: a glowing rounded frame around its
   * icon (a shield with a core, a horseshoe magnet, a double chevron), pulsing on the beat.
   */
  #drawBooster(
    g: Phaser.GameObjects.Graphics,
    kind: keyof typeof BOOSTER_COLOR,
    x: number,
    y: number,
    beatPhase: number,
  ): void {
    const color = BOOSTER_COLOR[kind].fill;
    const pulse = this.#reduced ? 0 : Math.max(0, 1 - beatPhase * 2.5);
    g.fillStyle(color, 0.14 + 0.1 * pulse).fillCircle(x, y, 24 + 4 * pulse);
    g.fillStyle(paletteNumbers.night, 0.75).fillRoundedRect(x - 14, y - 14, 28, 28, 7);
    g.lineStyle(2, color, 1).strokeRoundedRect(x - 14, y - 14, 28, 28, 7);
    g.lineStyle(2.5, color, 1);
    if (kind === 'shield') {
      g.beginPath();
      g.moveTo(x, y - 9);
      g.lineTo(x + 7.5, y - 6);
      g.lineTo(x + 7.5, y);
      g.lineTo(x, y + 9);
      g.lineTo(x - 7.5, y);
      g.lineTo(x - 7.5, y - 6);
      g.closePath();
      g.strokePath();
      g.fillStyle(paletteNumbers.flare, 1).fillCircle(x, y - 1, 2.5);
    } else if (kind === 'magnet') {
      g.lineStyle(4, color, 1);
      g.beginPath();
      g.arc(x, y + 1, 6, 0, Math.PI, false);
      g.strokePath();
      g.lineBetween(x - 6, y + 1, x - 6, y - 7);
      g.lineBetween(x + 6, y + 1, x + 6, y - 7);
      g.fillStyle(paletteNumbers.flare, 1);
      g.fillRect(x - 8, y - 9, 4, 3);
      g.fillRect(x + 4, y - 9, 4, 3);
    } else {
      for (let dx = -4; dx <= 4; dx += 8) {
        g.beginPath();
        g.moveTo(x + dx - 4, y - 7);
        g.lineTo(x + dx + 3, y);
        g.lineTo(x + dx - 4, y + 7);
        g.strokePath();
      }
    }
  }

  /** The cube, drawn once around its centre; it is moved, turned and squashed each frame. */
  #drawCube(g: Phaser.GameObjects.Graphics, color: number, rim: number): void {
    const w = PLAYER_WIDTH;
    const h = PLAYER_HEIGHT;
    const r = 8;
    g.fillStyle(color, 0.16).fillRoundedRect(-w / 2 - 7, -h / 2 - 7, w + 14, h + 14, 14);
    g.fillStyle(color, 1).fillRoundedRect(-w / 2, -h / 2, w, h, r);
    g.lineStyle(2.5, rim, 1).strokeRoundedRect(-w / 2 + 2.5, -h / 2 + 2.5, w - 5, h - 5, r - 2);
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
    } else if (p.dashLeft > 0) {
      // Dashing: long and flat, a burst forward.
      sx = 1.28;
      sY = 0.82;
    } else if (p.slamming) {
      sx = 0.78;
      sY = 1.26;
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
    // A dash or a slam holds the cube square to its burst.
    if (p.dashLeft > 0 || p.slamming) angle = 0;
    // Blink with the beat while counting in, and quickly while a shield bounces it to safety.
    let alpha = run.phase === 'countin' ? 0.55 + 0.45 * Math.max(0, 1 - beatPhase * 2) : 1;
    if (run.rescue) alpha = (t * 12) % 1 < 0.5 ? 1 : 0.4;
    const centreY = sy(p.y + (PLAYER_HEIGHT * sY) / 2);
    cube
      .setVisible(true)
      .setPosition(p.x + PLAYER_WIDTH / 2, centreY)
      .setScale(sx, sY)
      .setAngle(angle)
      .setAlpha(alpha);
    // Overdrive: the cube burns magenta, the hot one over the cyan one.
    const od = this.#overdrive;
    this.#hot.setVisible(od > 0);
    if (od > 0)
      this.#hot
        .setPosition(p.x + PLAYER_WIDTH / 2, centreY)
        .setScale(sx, sY)
        .setAngle(angle)
        .setAlpha(alpha * od);
  }

  /**
   * The boosters around the cube: the shield's cyan ring (pulsing on the beat, spreading
   * out when it takes a hit), the magnet's faint field with the coins it pulls flying in,
   * and the extra dash as two chevrons behind. Overdrive adds flames.
   */
  #drawBoosters(
    g: Phaser.GameObjects.Graphics,
    run: PlatformerRun,
    t: number,
    beatPhase: number,
  ): void {
    const p = run.player;
    const cx = p.x + PLAYER_WIDTH / 2;
    const cy = sy(p.y + PLAYER_HEIGHT / 2);
    const b = run.boosters;
    const pulse = this.#reduced ? 0 : Math.max(0, 1 - beatPhase * 3);
    // The hit: a ring spreading out from where the shield broke.
    const sinceHit = t - run.shieldHitAt;
    if (sinceHit >= 0 && sinceHit < 0.5) {
      const k = sinceHit / 0.5;
      g.lineStyle(4 * (1 - k) + 1, paletteNumbers.cyan, 1 - k).strokeCircle(
        cx,
        cy,
        SHIELD_RADIUS + 70 * k,
      );
    }
    if (!p.alive || run.phase === 'dying') return;
    if (b.shield || run.rescue) {
      const r = SHIELD_RADIUS + 3 * pulse;
      g.lineStyle(9, paletteNumbers.cyan, 0.12).strokeCircle(cx, cy, r);
      g.lineStyle(2, paletteNumbers.cyan, run.rescue ? 0.5 : 0.85).strokeCircle(cx, cy, r);
    }
    if (t >= b.magnetFrom && t < b.magnetUntil) {
      // A faint field, its edge dashed and turning.
      const turn = t * 1.5;
      g.lineStyle(1.5, paletteNumbers.magenta, 0.35);
      for (let i = 0; i < 12; i++) {
        const a = turn + (i / 12) * Math.PI * 2;
        g.beginPath();
        g.arc(cx, cy, MAGNET_RADIUS * 0.6, a, a + 0.28);
        g.strokePath();
      }
    }
    if (b.extraDash) {
      // Two chevrons behind the cube: a dash in reserve.
      g.lineStyle(3, paletteNumbers.cyan, 0.85);
      for (let i = 0; i < 2; i++) {
        const x = cx - PLAYER_WIDTH / 2 - 10 - i * 9;
        g.beginPath();
        g.moveTo(x - 5, cy - 7);
        g.lineTo(x, cy);
        g.lineTo(x - 5, cy + 7);
        g.strokePath();
      }
    }
    // Coins the magnet pulled, flying in and shrinking.
    for (const z of this.#zips) {
      const age = t - z.at;
      if (age < 0 || age > ZIP_TIME) continue;
      const k = age / ZIP_TIME;
      const e = k * k;
      const x = z.x + (cx - z.x) * e;
      const y = sy(z.y) + (cy - sy(z.y)) * e;
      g.lineStyle(2, paletteNumbers.magenta, 0.5 * (1 - k)).lineBetween(z.x, sy(z.y), x, y);
      g.fillStyle(paletteNumbers.magenta, 1 - 0.5 * k).fillCircle(x, y, 6 * (1 - 0.6 * k));
    }
    // Overdrive's flames: magenta tongues licking up from the cube, flickering on song time.
    const od = this.#overdrive;
    if (od > 0) {
      for (let i = 0; i < 5; i++) {
        const flick = hash(Math.floor(t * 20), i);
        const x = cx - PLAYER_WIDTH / 2 + (i + 0.5) * (PLAYER_WIDTH / 5);
        const top = sy(p.y + PLAYER_HEIGHT) - 6 - 14 * flick - 8 * pulse;
        g.fillStyle(i % 2 ? paletteNumbers.magenta : paletteNumbers.flare, 0.55 * od);
        g.fillTriangle(
          x - 4,
          sy(p.y + PLAYER_HEIGHT) + 2,
          x,
          top,
          x + 4,
          sy(p.y + PLAYER_HEIGHT) + 2,
        );
      }
    }
  }

  /**
   * A dash: afterimages of the cube trailing behind it and speed lines streaking back, so
   * it reads as a burst forward though the cube stays at the anchor. Fades as it runs out.
   */
  #drawDash(g: Phaser.GameObjects.Graphics, run: PlatformerRun, t: number): void {
    const p = run.player;
    const age = t - run.dashedAt;
    if (!p.alive || age < 0 || age > DASH_TIME + 0.12) return;
    // Cut short by a jump or a slam.
    if (age < DASH_TIME - 0.02 && p.dashLeft === 0) return;
    const fade = age < DASH_TIME ? 1 : 1 - (age - DASH_TIME) / 0.12;
    const cx = p.x + PLAYER_WIDTH / 2;
    const cy = sy(p.y + PLAYER_HEIGHT * 0.41);
    const w = PLAYER_WIDTH * 1.28;
    const h = PLAYER_HEIGHT * 0.82;
    // Spread out over the first moment of the burst, then hold.
    const spread = Math.min(1, age / 0.06);
    for (let i = AFTERIMAGES; i >= 1; i--) {
      const ox = cx - i * 15 * spread;
      g.fillStyle(paletteNumbers.cyan, (0.42 - i * 0.08) * fade).fillRoundedRect(
        ox - w / 2,
        cy - h / 2,
        w,
        h,
        7,
      );
    }
    const lines = Math.max(3, Math.round(SPEED_LINES * this.#quality.particles));
    for (let i = 0; i < lines; i++) {
      const r = hash(run.dashedAt * 100, i);
      const length = 40 + 70 * r;
      // Streaming back from the cube: each line slides away and comes round again.
      const slide = ((age * 900 + r * 140) % 140) / 140;
      const x1 = cx - w / 2 - 6 - slide * 90;
      const y = cy - h / 2 + 4 + ((h - 8) * (i + 0.5)) / lines + (r - 0.5) * 6;
      g.fillStyle(
        i % 3 === 0 ? paletteNumbers.flare : paletteNumbers.cyan,
        (1 - slide) * 0.8 * fade,
      );
      g.fillRect(x1 - length, y - 1, length, 2);
    }
  }

  /**
   * A slam: a streak above the cube while it drops; on landing, a shockwave along the
   * ground, in the beat's magenta when it landed on one and the player's cyan when not.
   */
  #drawSlam(g: Phaser.GameObjects.Graphics, run: PlatformerRun, t: number): void {
    const p = run.player;
    const cx = p.x + PLAYER_WIDTH / 2;
    if (p.alive && p.slamming) {
      const top = sy(p.y + PLAYER_HEIGHT * 1.26);
      for (let i = -2; i <= 2; i++) {
        const length = 70 - Math.abs(i) * 16;
        g.fillStyle(i === 0 ? paletteNumbers.flare : paletteNumbers.cyan, 0.6 - Math.abs(i) * 0.15);
        g.fillRect(cx + i * 6 - 1, top - length, 2, length);
      }
    }
    const s = this.#shock;
    const age = t - s.at;
    if (age < 0 || age > SHOCK_TIME) return;
    const k = age / SHOCK_TIME;
    const color = s.onBeat ? paletteNumbers.magenta : paletteNumbers.cyan;
    const reach = 26 + 150 * (1 - (1 - k) * (1 - k));
    const y = sy(s.y);
    g.fillStyle(color, 0.25 * (1 - k)).fillEllipse(s.x, y, reach * 2, 22 * (1 - k) + 6);
    g.lineStyle(3, color, 0.9 * (1 - k)).strokeEllipse(s.x, y, reach * 2, 16 * (1 - k) + 4);
    // Sparks thrown up at both ends of the wave.
    for (const side of [-1, 1]) {
      g.fillStyle(color, 1 - k).fillRect(s.x + side * reach - 3, y - 10 - 30 * k, 6, 10);
    }
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
      g.fillStyle(this.#overdrive > 0.5 ? paletteNumbers.magenta : paletteNumbers.cyan, 0.4 * k);
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
