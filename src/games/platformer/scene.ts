import * as Phaser from 'phaser';
import { getEffects, onSettingsChange, type LevelMap } from '../../core';
import { palette, paletteNumbers } from '../../theme/palette';
import { solidTop, spikesOut, type PlatformerLevel, type Solid } from './level';
import { PLAYER_HEIGHT, PLAYER_WIDTH, SPIKE_HEIGHT, VIEW_HEIGHT, VIEW_WIDTH } from './physics';
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
/** Floating score texts rise for this long. */
const FLOAT_TIME = 0.8;
const SHARDS = 12;
/** How long a speaker ring spreads out after a kick, in beats. */
const RING_BEATS = 1.2;
/** How long the drop takes to calm down after its set piece, in bars. */
const CALM_BARS = 2;
const FONT = 'Bahnschrift, "DIN Alternate", "Segoe UI", system-ui, sans-serif';
const RADIAL = 'wl-radial';

/** Turns world heights (up from the base line) into the view's y (down from its top). */
const sy = (y: number) => WORLD_TOP - y;

/** A steady pseudo-random number in [0, 1) for particle `i` of a burst. */
const hash = (seed: number, i: number) => {
  const v = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

interface Floater {
  text: Phaser.GameObjects.Text;
  x: number;
  y: number;
  /** Song time it appeared. */
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

export interface FrameState {
  time: number;
  run: PlatformerRun;
  /** Which beat of the bar, 0–3 (or -1 before the first). */
  beatInBar: number;
  /** 0 on the beat, rising to 1 at the next. */
  beatPhase: number;
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

export class PlatformerScene extends Phaser.Scene {
  #sky!: Phaser.GameObjects.Graphics;
  #flash!: Phaser.GameObjects.Image;
  #back!: Phaser.GameObjects.Graphics;
  #layer!: Phaser.GameObjects.Container;
  #world!: Phaser.GameObjects.Graphics;
  #fx!: Phaser.GameObjects.Graphics;
  #player!: Phaser.GameObjects.Graphics;
  #callout!: Phaser.GameObjects.Text;
  #front!: Phaser.GameObjects.Graphics;
  #floaters: Floater[] = [];
  #bursts: Burst[] = [];
  #trail: { t: number; x: number; y: number }[] = [];
  readonly #music: Music;
  #zoom = 1;
  #offsetX = 0;
  #offsetY = 0;
  /** Where the player died, for the shards. */
  #death: { x: number; y: number } | null = null;
  /** The last landing and drop beat seen, to burst once for each. */
  #landingSeen = -Infinity;
  #dropBeatSeen = -1;
  #reduced = getEffects() === 'reduced';
  #stopListening: (() => void) | null = null;

  constructor(
    private readonly level: PlatformerLevel,
    map: LevelMap,
    /** Called every frame; the session moves the run on and hands back what to draw. */
    private readonly frame: () => FrameState,
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
  }

  create(): void {
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
    this.#sky = this.add.graphics();
    this.#flash = this.add.image(0, 0, RADIAL).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0);
    this.#back = this.add.graphics();
    this.#world = this.add.graphics();
    this.#fx = this.add.graphics();
    this.#player = this.add.graphics();
    this.#drawCube(this.#player);
    this.#layer = this.add.container(0, 0, [this.#world, this.#fx, this.#player]);
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
    this.#front = this.add.graphics();

    // Bloom: what is bright spreads its light. One pass over the whole frame.
    const [bloom] = Phaser.Actions.AddEffectBloom(this.cameras.main, {
      threshold: 0.42,
      blurRadius: 3,
      blurSteps: 4,
      blurQuality: 1,
      blendAmount: 1,
    });
    if (bloom) bloom.blur.strength = 1.5;

    this.scale.on(Phaser.Scale.Events.RESIZE, this.#layout, this);
    this.#layout();
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => (this.#reduced = getEffects() === 'reduced');
    media.addEventListener('change', update);
    const stop = onSettingsChange(update);
    this.#stopListening = () => {
      media.removeEventListener('change', update);
      stop();
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.#stopListening?.());
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
        this.#burst('spark', k.x, k.y, time);
      }
    }
  }

  /** Forget effects tied to song times that are being played again. */
  reset(): void {
    this.#death = null;
    for (const f of this.#floaters) f.text.destroy();
    this.#floaters = [];
    this.#bursts = [];
    this.#trail = [];
    this.#landingSeen = -Infinity;
    this.#dropBeatSeen = -1;
  }

  #burst(kind: Burst['kind'], x: number, y: number, at: number): void {
    this.#bursts.push({ kind, x, y, at, seed: (at * 1000) % 997 });
  }

  #float(text: string, x: number, y: number, at: number, color: string): void {
    const object = this.add
      .text(0, 0, text, {
        fontFamily: FONT,
        fontSize: '15px',
        fontStyle: '600',
        color,
        letterSpacing: 2,
        resolution: 2,
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
    const g = this.#world.clear();
    const { width } = this.scale;
    const x0 = camera - this.#offsetX / this.#zoom - 40;
    const x1 = camera + (width - this.#offsetX) / this.#zoom + 40;
    const solids = level.solids;
    for (let i = 0; i < solids.length; i++) {
      const solid = solids[i]!;
      if (solid.x1 < x0) continue;
      if (solid.x0 > x1) break;
      // Long ground is split into pieces; draw them as one, with no seams.
      const joins = (other: Solid | undefined) =>
        other !== undefined &&
        other.kind === solid.kind &&
        !other.keys &&
        !solid.keys &&
        other.top === solid.top &&
        (Math.abs(other.x1 - solid.x0) < 0.5 || Math.abs(other.x0 - solid.x1) < 0.5);
      this.#drawSolid(
        g,
        solid,
        time,
        state.beatPhase,
        drop,
        joins(solids[i - 1]),
        joins(solids[i + 1]),
      );
    }
    this.#drawSpikes(g, time, x0, x1);
    this.#drawPickups(g, run, state, x0, x1);

    const fx = this.#fx.clear();
    this.#drawTrail(fx, run, time);
    this.#drawBursts(fx, time);
    if (this.#death && run.phase === 'dying') this.#drawShards(fx, this.#death, sinceDeath);
    this.#placePlayer(run, time, state.beatPhase);

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

  /** The night sky, the floor grid rolling toward the player and the horizon's flare. */
  #drawSky({ beatPhase, beatInBar }: FrameState, camera: number, drop: number): void {
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
    const line = (ax: number, ay: number, bx: number, by: number, a: number) => {
      g.lineStyle(6, paletteNumbers.violet, a * 0.15).lineBetween(ax, ay, bx, by);
      g.lineStyle(1.5, paletteNumbers.violet, a).lineBetween(ax, ay, bx, by);
    };
    for (let i = 0; i < GRID_ROWS; i++) {
      const z = (i + beatPhase) / GRID_ROWS;
      const y = horizon + depth * z * z;
      line(0, y, width, y, 0.08 + 0.45 * z);
    }
    const vanish = width / 2;
    const spacing = (width * 3) / GRID_COLUMNS;
    const slide = (camera * this.#zoom * 1.4) % spacing;
    for (let i = 0; i <= GRID_COLUMNS + 1; i++) {
      const x = vanish - width * 1.5 + i * spacing - slide;
      line(vanish + (x - vanish) * 0.04, horizon, x, height, 0.32);
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

  /** Faint wave lines, the speaker with its rings, and the drop's big waveforms. */
  #drawBack({ time, beatPhase }: FrameState, camera: number, drop: number): void {
    const g = this.#back.clear();
    const z = this.#zoom;
    const vx = (x: number) => this.#offsetX + x * z;
    const vy = (y: number) => this.#offsetY + y * z;
    const { width } = this.scale;
    const level = this.level;
    const beatIndex = Math.floor((time - level.gridStart) / level.beatPeriod);
    const energy = this.#music.energy[Math.max(0, beatIndex)] ?? 0.4;

    // Two faint wave lines across the sky, drifting with the song, taller when it's loud.
    const wave = (y: number, amp: number, phase: number, color: number, w: number, a: number) => {
      g.lineStyle(w * z, color, a);
      g.beginPath();
      for (let i = 0; i <= 64; i++) {
        const x = (i / 64) * width;
        const u = (x / z + camera * 0.15) / 300 + phase;
        const yy = vy(y) + Math.sin(u * Math.PI) * amp * z;
        if (i === 0) g.moveTo(x, yy);
        else g.lineTo(x, yy);
      }
      g.strokePath();
    };
    const amp = 18 + 22 * energy;
    wave(156, amp, time * 0.4, paletteNumbers.violet, 1.5, 0.35);
    wave(180, amp * 0.8, time * 0.4 + 0.35, paletteNumbers.magenta, 1, 0.22);

    // The speaker: a violet light that thumps on every kick, sending out rings.
    const cx = vx(VIEW_WIDTH * 0.77);
    const cy = vy(VIEW_HEIGHT * 0.37);
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
      const big = (sign: number, color: number, a: number) => {
        const path = (w: number, alpha: number) => {
          g.lineStyle(w * z, color, alpha * drop);
          g.beginPath();
          for (let i = 0; i <= 96; i++) {
            const x = (i / 96) * width;
            const u = x / z / 180 + time * 1.2;
            const yy = vy(232) + sign * Math.sin(u * Math.PI) * 100 * swell * z;
            if (i === 0) g.moveTo(x, yy);
            else g.lineTo(x, yy);
          }
          g.strokePath();
        };
        path(12, 0.12 * a);
        path(3, a);
      };
      big(1, paletteNumbers.magenta, 0.9);
      big(-1, paletteNumbers.cyan, 0.7);
    }
  }

  #drawSolid(
    g: Phaser.GameObjects.Graphics,
    s: Solid,
    t: number,
    beatPhase: number,
    drop: number,
    joinedLeft: boolean,
    joinedRight: boolean,
  ): void {
    const top = solidTop(s, t);
    const w = s.x1 - s.x0;
    if (s.kind === 'bridge') {
      // A dotted bridge, only there on the snare; faint where it will be.
      const count = Math.max(2, Math.round(w / 18));
      const step = w / count;
      const dot = step * 0.62;
      if (top === null) {
        g.fillStyle(paletteNumbers.cyan, 0.1);
        for (let i = 0; i < count; i++)
          g.fillRoundedRect(s.x0 + i * step + (step - dot) / 2, sy(s.top), dot, 7, 2);
        return;
      }
      for (let i = 0; i < count; i++) {
        const x = s.x0 + i * step + (step - dot) / 2;
        g.fillStyle(paletteNumbers.cyan, 0.22).fillRoundedRect(x - 3, sy(top) - 3, dot + 6, 13, 4);
        g.fillStyle(paletteNumbers.cyan, 1).fillRoundedRect(x, sy(top), dot, 7, 2);
      }
      return;
    }
    if (s.kind === 'ledge') {
      if (top === null) return;
      g.fillStyle(paletteNumbers.cyan, 0.2).fillRoundedRect(s.x0 - 4, sy(top) - 4, w + 8, 17, 8);
      g.fillStyle(paletteNumbers.cyan, 1).fillRoundedRect(s.x0, sy(top), w, 9, 4.5);
      return;
    }
    if (top === null) return;
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
    const corner = (r: number) => ({
      tl: joinedLeft ? 0 : r,
      tr: joinedRight ? 0 : r,
      bl: joinedLeft ? 0 : r,
      br: joinedRight ? 0 : r,
    });
    const halo = { a: joinedLeft ? s.x0 : s.x0 - 2, b: joinedRight ? s.x1 : s.x1 + 2 };
    g.fillStyle(color, 0.22 + flare).fillRoundedRect(halo.a, y - 7, halo.b - halo.a, 16, corner(5));
    g.fillStyle(color, 1).fillRoundedRect(a, y, b - a, 6, corner(2));
    const inset = { a: joinedLeft ? s.x0 : s.x0 + 4, b: joinedRight ? s.x1 : s.x1 - 4 };
    g.fillStyle(paletteNumbers.flare, 0.35 + 0.4 * flare).fillRect(
      inset.a,
      y + 1,
      inset.b - inset.a,
      1.5,
    );
  }

  #drawSpikes(g: Phaser.GameObjects.Graphics, t: number, x0: number, x1: number): void {
    const out = spikesOut(this.level, t);
    const phase = (t - this.level.gridStart) / this.level.beatPeriod;
    const p = phase - Math.floor(phase);
    // Tucked in on the beat, rising a little just before the off-beat as a warning, then
    // out (and deadly) until the next beat.
    const warn = Math.max(0, Math.min(1, (p - 0.3) / 0.2));
    const height = SPIKE_HEIGHT * (out ? 1 : 0.18 + 0.22 * warn * warn);
    for (const s of this.level.spikes) {
      if (s.x1 < x0) continue;
      if (s.x0 > x1) break;
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
      for (let i = 0; i < count; i++) {
        const a = s.x0 + i * step;
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
    run.level.pickups.forEach((k, i) => {
      if (k.x < x0 || k.x > x1 || run.isCollected(i)) return;
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
    });
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

  /** A light trail: where the cube was a moment ago, fading out. */
  #drawTrail(g: Phaser.GameObjects.Graphics, run: PlatformerRun, t: number): void {
    const p = run.player;
    const trail = this.#trail;
    // Played again from earlier (a rewind): the trail starts over.
    if (trail.length && trail[trail.length - 1]!.t > t) trail.length = 0;
    if (p.alive && run.phase !== 'countin')
      trail.push({ t, x: p.x + PLAYER_WIDTH / 2, y: p.y + PLAYER_HEIGHT / 2 });
    while (trail.length && t - trail[0]!.t > TRAIL_TIME) trail.shift();
    if (!p.alive || trail.length < 2) return;
    // A ribbon narrowing and fading with age: quads sharing their edges, so nothing
    // overlaps and the alpha stays even at any frame rate.
    const edge = (i: number) => {
      const s = trail[i]!;
      const n = trail[Math.min(i + 1, trail.length - 1)]!;
      const m = trail[Math.max(i - 1, 0)]!;
      const dx = n.x - m.x;
      const dy = sy(n.y) - sy(m.y);
      const length = Math.hypot(dx, dy) || 1;
      const half = (PLAYER_HEIGHT / 2) * (0.25 + 0.6 * (1 - (t - s.t) / TRAIL_TIME));
      const nx = (-dy / length) * half;
      const ny = (dx / length) * half;
      return { ax: s.x + nx, ay: sy(s.y) + ny, bx: s.x - nx, by: sy(s.y) - ny };
    };
    let from = edge(0);
    for (let i = 0; i < trail.length - 1; i++) {
      const to = edge(i + 1);
      const k = 1 - (t - trail[i]!.t) / TRAIL_TIME;
      g.fillStyle(paletteNumbers.cyan, 0.4 * k);
      g.fillTriangle(from.ax, from.ay, to.ax, to.ay, to.bx, to.by);
      g.fillTriangle(from.ax, from.ay, to.bx, to.by, from.bx, from.by);
      from = to;
    }
  }

  #drawBursts(g: Phaser.GameObjects.Graphics, t: number): void {
    const colors = [paletteNumbers.cyan, paletteNumbers.magenta, paletteNumbers.violet];
    this.#bursts = this.#bursts.filter((b) => {
      const spec = BURSTS[b.kind];
      const age = t - b.at;
      if (age < 0 || age > spec.life) return false;
      const k = age / spec.life;
      const fade = 1 - k;
      for (let i = 0; i < spec.count; i++) {
        const r1 = hash(b.seed, i);
        const r2 = hash(b.seed, i + 50);
        let angle: number;
        if (b.kind === 'land') angle = Math.PI * (r1 < 0.5 ? 0.05 + r1 * 0.4 : 0.55 + r1 * 0.4);
        else angle = (i / spec.count) * Math.PI * 2 + r1 * 0.4;
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
              : colors[i % 3]!;
        g.fillStyle(color, 0.25 * fade).fillRect(x - size, sy(y) - size, size * 2, size * 2);
        g.fillStyle(color, fade).fillRect(x - size / 2, sy(y) - size / 2, size, size);
      }
      return true;
    });
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
