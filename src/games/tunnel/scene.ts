import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  beatAt,
  beatIndexAt,
  beatInBar,
  getEffects,
  onSettingsChange,
  periodAt,
  timeOfBeat,
  type LevelMap,
} from '../../core';
import { palette } from '../../theme/palette';
import { FrameMonitor } from '../shared/perf';
import {
  DROP_BARS,
  pathAt,
  timeAtZ,
  zAtTime,
  type BoosterKind,
  type Obstacle,
  type SectionLook,
  type TunnelTrack,
} from './level';
import { QUALITY, type Quality } from './perf';
import { BLOCK_DEPTH, BLOCK_HALF, LOW_WALL_HEIGHT, obstacleLaneAt, RACER_DEPTH } from './physics';
import { MAGNET_REACH, type RunEvent, type TunnelRun } from './run';

/**
 * The tunnel drawn with Three.js in the Neon arcade look: glowing rings and lane lines on
 * night, bloom on, no textures or models. The camera rides behind the craft down the
 * melody's path. Everything is placed from song time (the session's frame state) and the
 * track's data: a ring sits on its beat, an obstacle on its moment, so the picture shows
 * what the physics does.
 *
 * Colours keep their meanings: cyan the craft and the lanes (safe paths), violet the
 * tunnel and the bass pulse, magenta pickups, kicks and drops, orange obstacles.
 *
 * The tube's width follows each section's look and breathes with the bass and the kicks;
 * the lanes never move with it (the physics works in lane units). With effects reduced
 * there is no crash flash or shake, and the pulses and the drop's flashes are softer.
 */

/** What the session tells the scene each frame. */
export interface FrameState {
  /** Song time the frame is drawn for. */
  time: number;
  run: TunnelRun;
  /** The pause menu is open: frames don't count toward the quality. */
  paused: boolean;
}

/** The deck's arc: lanes sit on it one unit apart, this far below the tube's centre. */
const LANE_RADIUS = 3;
/** The tube's usual radius, before the section's look and the pulse. */
const TUBE_RADIUS = 4.6;
/** How far behind the craft things are still drawn. */
const VIEW_BEHIND = 8;
/** Units between the samples of the lane and tube lines. */
const LINE_STEP = 1.25;
/** The tube's long lines, by angle from the bottom (radians), clear of the deck. */
const TUBE_LINES = [1, 1.45, 1.9, 2.35, 2.8].flatMap((a) => [a, -a]);
/** The camera: behind the craft, above the deck, and how far ahead it looks. */
const CAMERA_BACK = 4.6;
const CAMERA_UP = 1.75;
const LOOK_AHEAD = 12;
/** How wide the camera wants to see, degrees, and the field of view's limits. */
const WANT_HFOV = 78;
const MIN_VFOV = 55;
const MAX_VFOV = 88;
/** A crash's flash and shake, seconds. */
const CRASH_TIME = 0.35;
/** A kick's pulse ring, seconds. */
const KICK_TIME = 0.4;
/** How tall a block is (a low wall is `LOW_WALL_HEIGHT`). */
const BLOCK_HEIGHT = 1.15;
/** Pickups float this high over the deck. */
const PICKUP_HEIGHT = 0.42;
/** A stop's dark: what is left of the light. */
const DARK_LIGHT = 0.07;
/** Bloom, before the section's glow. */
const BLOOM_STRENGTH = 0.6;
/** A telegraph strip's width across its lane, lanes. */
const TELEGRAPH_HALF = 0.38;
/** The wall of a lane's obstacle is announced over this many beats before it. */
const TELEGRAPH_BEATS = 1;
/** A wall's gap lanes are marked cyan over this many beats before it. */
const GAP_BEATS = 1.5;
/** Gems this close ahead of the craft (units) fly into it while the magnet is on. */
const MAGNET_PULL = 6;
/** Boost hoops: the ring's radius (lanes) and how high its middle is over the deck. */
const HOOP_RADIUS = 0.62;
const HOOP_HEIGHT = 0.55;
/** The starfield of calm parts: how many points it has. */
const MAX_STARS = 420;
/** The notched ring walls of a chorus: how many gates round the tube. */
const WALL_GATES = 6;

const MAX_RINGS = 128;
const MAX_WALLS = 64;
const MAX_HOLD_RINGS = 64;
const MAX_KICK_RINGS = 6;
const MAX_BLOCKS = 320;
const MAX_PICKUPS = 256;
const MAX_HOOPS = 32;
const MAX_BOOSTERS = 8;
const MAX_QUADS = 9000;
const MAX_PARTICLES = 700;

const UP = new THREE.Vector3(0, 1, 0);

/** The palette as linear Three colours. */
const COLOR = {
  night: new THREE.Color(palette.night),
  cyan: new THREE.Color(palette.cyan),
  magenta: new THREE.Color(palette.magenta),
  violet: new THREE.Color(palette.violet),
  orange: new THREE.Color(palette.orange),
  rim: new THREE.Color(palette.rim),
  flare: new THREE.Color(palette.flare),
};

/** Where the tunnel is at a point down it: the tube's centre and which way is which. */
interface Frame {
  c: THREE.Vector3;
  /** Forward (down the tunnel), right and up. */
  f: THREE.Vector3;
  r: THREE.Vector3;
  u: THREE.Vector3;
}

const newFrame = (): Frame => ({
  c: new THREE.Vector3(),
  f: new THREE.Vector3(),
  r: new THREE.Vector3(),
  u: new THREE.Vector3(),
});

const smoothstep = (a: number, b: number, x: number) => {
  const f = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return f * f * (3 - 2 * f);
};

/** A boxy edge glow for obstacles and the craft: bright edges, a dim fill. */
function edgeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        vUv = uv;
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
        #else
          vColor = vec3(1.0);
        #endif
        vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * p;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        float e = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
        float edge = smoothstep(0.14, 0.02, e);
        gl_FragColor = vec4(vColor * (0.16 + 1.7 * edge), 1.0);
      }
    `,
  });
}

/** A soft round glow, drawn once, for the far end's light and the sparks. */
function glowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, palette.flare);
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A ring of separate gates, so a turning wall can be seen turning. */
function gatedRing(): THREE.BufferGeometry {
  const arc = (Math.PI * 2) / WALL_GATES;
  const parts = Array.from(
    { length: WALL_GATES },
    (_, i) => new THREE.RingGeometry(0.84, 1, 10, 1, i * arc, arc * 0.62),
  );
  const merged = mergeGeometries(parts)!;
  for (const g of parts) g.dispose();
  return merged;
}

/** A booster's colour: cyan the shield (safe), magenta the magnet, white-hot the surge. */
const boosterColor = (kind: BoosterKind) =>
  kind === 'shield' ? COLOR.cyan : kind === 'magnet' ? COLOR.magenta : COLOR.flare;

/** A fixed hash of an index, 0 to 1. */
const hash01 = (i: number) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Each star's place along the view, its share of the starfield, its angle and its depth in the tube. */
const STARS = new Float32Array(MAX_STARS * 4);
for (let i = 0; i < MAX_STARS; i++) {
  STARS[i * 4] = hash01(i) * 1000;
  STARS[i * 4 + 1] = hash01(i + 0.5);
  STARS[i * 4 + 2] = hash01(i + 0.25) * Math.PI * 2;
  STARS[i * 4 + 3] = 0.35 + 0.6 * hash01(i + 0.75);
}

/**
 * Flat glowing strips (the lane and tube lines, rails), rebuilt every frame into one
 * buffer: WebGL's lines are a pixel wide, these keep their width in the world.
 */
class Ribbons {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly #pos = new Float32Array(MAX_QUADS * 12);
  readonly #col = new Float32Array(MAX_QUADS * 12);
  #quads = 0;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    const index = new Uint32Array(MAX_QUADS * 6);
    for (let q = 0; q < MAX_QUADS; q++) {
      const v = q * 4;
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], q * 6);
    }
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.#pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(this.#col, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.mesh.frustumCulled = false;
  }

  begin(): void {
    this.#quads = 0;
  }

  /**
   * A piece of strip from `a` to `b`, `half` wide on each side along `da` and `db`, in
   * colours `ca` and `cb` (already scaled by how bright).
   */
  quad(
    a: THREE.Vector3,
    da: THREE.Vector3,
    ca: THREE.Color,
    b: THREE.Vector3,
    db: THREE.Vector3,
    cb: THREE.Color,
    half: number,
  ): void {
    if (this.#quads >= MAX_QUADS) return;
    const p = this.#pos;
    const c = this.#col;
    let o = this.#quads * 12;
    const put = (v: THREE.Vector3, d: THREE.Vector3, s: number, col: THREE.Color) => {
      p[o] = v.x + d.x * s;
      p[o + 1] = v.y + d.y * s;
      p[o + 2] = v.z + d.z * s;
      c[o] = col.r;
      c[o + 1] = col.g;
      c[o + 2] = col.b;
      o += 3;
    };
    put(a, da, -half, ca);
    put(a, da, half, ca);
    put(b, db, -half, cb);
    put(b, db, half, cb);
    this.#quads++;
  }

  end(): void {
    const g = this.mesh.geometry;
    g.setDrawRange(0, this.#quads * 6);
    g.attributes.position!.needsUpdate = true;
    g.attributes.color!.needsUpdate = true;
  }
}

/** Sparks for pickups, crashes and perfects: moved on frame time, drawn only. */
class Sparks {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  readonly #pos = new Float32Array(MAX_PARTICLES * 3);
  readonly #col = new Float32Array(MAX_PARTICLES * 3);
  readonly #vel = new Float32Array(MAX_PARTICLES * 3);
  readonly #base = new Float32Array(MAX_PARTICLES * 3);
  readonly #life = new Float32Array(MAX_PARTICLES);
  readonly #age = new Float32Array(MAX_PARTICLES);
  #next = 0;

  constructor(texture: THREE.Texture) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.#pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(this.#col, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 0.22,
        map: texture,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.points.frustumCulled = false;
  }

  burst(at: THREE.Vector3, color: THREE.Color, count: number, speed: number, life = 0.55): void {
    for (let i = 0; i < count; i++) {
      const k = this.#next;
      this.#next = (this.#next + 1) % MAX_PARTICLES;
      const z = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z) * speed * (0.4 + Math.random() * 0.6);
      this.#pos.set([at.x, at.y, at.z], k * 3);
      this.#vel.set([Math.cos(a) * s, Math.sin(a) * s, z * speed * 0.5], k * 3);
      this.#base.set([color.r, color.g, color.b], k * 3);
      this.#life[k] = life * (0.6 + Math.random() * 0.4);
      this.#age[k] = 0;
    }
  }

  clear(): void {
    this.#life.fill(0);
    this.#col.fill(0);
    this.points.geometry.attributes.color!.needsUpdate = true;
  }

  update(dt: number): void {
    const pos = this.#pos;
    const vel = this.#vel;
    const col = this.#col;
    for (let k = 0; k < MAX_PARTICLES; k++) {
      const life = this.#life[k]!;
      if (life <= 0) continue;
      const age = (this.#age[k]! += dt);
      const left = 1 - age / life;
      const o = k * 3;
      if (left <= 0) {
        this.#life[k] = 0;
        col[o] = col[o + 1] = col[o + 2] = 0;
        continue;
      }
      const drag = Math.exp(-3 * dt);
      for (let j = 0; j < 3; j++) {
        vel[o + j]! *= drag;
        pos[o + j]! += vel[o + j]! * dt;
        col[o + j] = this.#base[o + j]! * left * 1.6;
      }
    }
    const g = this.points.geometry;
    g.attributes.position!.needsUpdate = true;
    g.attributes.color!.needsUpdate = true;
  }
}

export class TunnelScene {
  readonly renderer: THREE.WebGLRenderer;
  /** How long frames take; lowers the quality when they stay over budget. */
  readonly monitor: FrameMonitor;

  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 400);
  readonly #composer: EffectComposer;
  readonly #bloom: UnrealBloomPass;
  readonly #glow: THREE.Texture;
  readonly #rings: THREE.InstancedMesh;
  readonly #walls: THREE.InstancedMesh;
  readonly #holdRings: THREE.InstancedMesh;
  readonly #kickRings: THREE.InstancedMesh;
  readonly #blocks: THREE.InstancedMesh;
  readonly #pickups: THREE.InstancedMesh;
  readonly #hoops: THREE.InstancedMesh;
  readonly #boostCores: THREE.InstancedMesh;
  readonly #boostHalos: THREE.InstancedMesh;
  readonly #stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  readonly #starPos = new Float32Array(MAX_STARS * 3);
  readonly #starCol = new Float32Array(MAX_STARS * 3);
  readonly #magnetRing: THREE.Mesh;
  readonly #surgeRing: THREE.Mesh;
  readonly #ribbons = new Ribbons();
  readonly #sparks: Sparks;
  readonly #craft = new THREE.Group();
  readonly #shield: THREE.Mesh;
  readonly #farLight: THREE.Sprite;
  /** The crash's orange flash, over the canvas and under the HUD. */
  readonly #flash = document.createElement('div');

  /** Each drop's set piece: from its first bar for `DROP_BARS` bars. */
  readonly #drops: { start: number; end: number }[];
  readonly #lanesMid: number;

  #quality: Quality = QUALITY[0]!;
  #reduced = getEffects() === 'reduced';
  readonly #stopSettings: () => void;
  readonly #media = matchMedia('(prefers-reduced-motion: reduce)');
  readonly #resize: ResizeObserver;
  #raf = 0;
  #lastStart = 0;
  #lastFrame = 0;
  /** The first kick not yet drawn as a pulse ring, and the kicks being drawn. */
  #nextKick = 0;
  readonly #kicks: { time: number; strength: number }[] = [];
  /** The obstacle last crashed into, to flare it. */
  #crashed = -1;

  // Scratch, reused every frame.
  readonly #f = newFrame();
  readonly #g = newFrame();
  readonly #h = newFrame();
  readonly #lineVectors = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ] as const;
  readonly #v = new THREE.Vector3();
  readonly #w = new THREE.Vector3();
  readonly #d = new THREE.Vector3();
  readonly #e = new THREE.Vector3();
  readonly #m = new THREE.Matrix4();
  readonly #q = new THREE.Quaternion();
  readonly #s = new THREE.Vector3();
  readonly #color = new THREE.Color();
  readonly #color2 = new THREE.Color();
  readonly #color3 = new THREE.Color();
  readonly #u = new THREE.Vector3();
  /** The craft's z this frame, for the helpers. */
  #zr = 0;
  readonly #back = new THREE.Vector3();

  constructor(
    readonly track: TunnelTrack,
    map: LevelMap,
    private readonly container: HTMLElement,
    private readonly frame: () => FrameState,
    /** Called when the quality steps down on its own. */
    onLowered: () => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    // The renderer turns the clear colour into sRGB even inside the composer's linear
    // buffer, and the output pass turns it into sRGB again: undo one, so night stays night.
    this.renderer.setClearColor(COLOR.night.clone().convertSRGBToLinear(), 1);
    const canvas = this.renderer.domElement;
    canvas.className = 'tn-canvas';
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    this.#flash.className = 'tn-flash';
    container.append(canvas, this.#flash);

    this.#composer = new EffectComposer(this.renderer);
    this.#composer.addPass(new RenderPass(this.#scene, this.#camera));
    this.#bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), BLOOM_STRENGTH, 0.45, 0.3);
    this.#composer.addPass(this.#bloom);
    this.#composer.addPass(new OutputPass());

    this.#lanesMid = (track.lanes - 1) / 2;
    this.#drops = map.events
      .filter((e) => e.kind === 'drop')
      .map((e) => {
        const downs = track.grid.downbeats;
        const start = downs.find((d) => d >= e.time - 1e-6) ?? e.time;
        const end = timeOfBeat(track.grid, beatAt(track.grid, start) + 4 * DROP_BARS);
        return { start, end };
      });

    this.#glow = glowTexture();
    const additive = (color = COLOR.flare) =>
      new THREE.MeshBasicMaterial({
        color,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    const instanced = (geometry: THREE.BufferGeometry, material: THREE.Material, n: number) => {
      const mesh = new THREE.InstancedMesh(geometry, material, n);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, COLOR.flare);
      mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.#scene.add(mesh);
      return mesh;
    };
    this.#rings = instanced(new THREE.TorusGeometry(1, 0.011, 3, 96), additive(), MAX_RINGS);
    this.#walls = instanced(gatedRing(), additive(), MAX_WALLS);
    this.#holdRings = instanced(
      new THREE.TorusGeometry(1, 0.01, 3, 96),
      additive(),
      MAX_HOLD_RINGS,
    );
    this.#kickRings = instanced(
      new THREE.TorusGeometry(1, 0.012, 3, 96),
      additive(),
      MAX_KICK_RINGS,
    );
    this.#blocks = instanced(new THREE.BoxGeometry(1, 1, 1), edgeMaterial(), MAX_BLOCKS);
    this.#pickups = instanced(
      new THREE.OctahedronGeometry(1, 0),
      new THREE.MeshBasicMaterial({ color: COLOR.flare }),
      MAX_PICKUPS,
    );
    this.#hoops = instanced(new THREE.TorusGeometry(1, 0.055, 6, 40), additive(), MAX_HOOPS);
    this.#boostCores = instanced(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshBasicMaterial({ color: COLOR.flare }),
      MAX_BOOSTERS,
    );
    this.#boostHalos = instanced(
      new THREE.TorusGeometry(1, 0.05, 6, 32),
      additive(),
      MAX_BOOSTERS * 2,
    );
    this.#scene.add(this.#ribbons.mesh);
    {
      // The calm parts' stars: points inside the tube, placed each frame.
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(this.#starPos, 3).setUsage(THREE.DynamicDrawUsage),
      );
      geometry.setAttribute(
        'color',
        new THREE.BufferAttribute(this.#starCol, 3).setUsage(THREE.DynamicDrawUsage),
      );
      geometry.setDrawRange(0, 0);
      this.#stars = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          size: 0.2,
          map: this.#glow,
          vertexColors: true,
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
        }),
      );
      this.#stars.frustumCulled = false;
      this.#scene.add(this.#stars);
    }
    this.#sparks = new Sparks(this.#glow);
    this.#scene.add(this.#sparks.points);

    // The craft: a flat dart pointing down the tunnel, cyan with a light rim.
    const dart = new THREE.Shape();
    dart.moveTo(0, 0.42);
    dart.lineTo(0.3, -0.28);
    dart.lineTo(0, -0.14);
    dart.lineTo(-0.3, -0.28);
    dart.closePath();
    const body = new THREE.ExtrudeGeometry(dart, { depth: 0.1, bevelEnabled: false });
    body.rotateX(-Math.PI / 2);
    body.translate(0, -0.05, 0);
    const bodyMesh = new THREE.Mesh(
      body,
      new THREE.MeshBasicMaterial({ color: COLOR.cyan.clone().multiplyScalar(0.55) }),
    );
    const rim = new THREE.LineSegments(
      new THREE.EdgesGeometry(body),
      new THREE.LineBasicMaterial({ color: COLOR.rim.clone().multiplyScalar(1.6) }),
    );
    const engine = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.#glow,
        color: COLOR.cyan,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    engine.position.set(0, 0, 0.3);
    engine.scale.setScalar(0.7);
    this.#shield = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.42, 1),
      new THREE.MeshBasicMaterial({
        color: COLOR.cyan.clone().multiplyScalar(0.16),
        wireframe: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    // The magnet's ring lies flat round the craft, the surge's stands upright.
    this.#magnetRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.012, 4, 40),
      new THREE.MeshBasicMaterial({
        color: COLOR.magenta,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.#magnetRing.rotation.x = Math.PI / 2;
    this.#surgeRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.46, 0.012, 4, 32),
      new THREE.MeshBasicMaterial({
        color: COLOR.flare,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.#magnetRing.visible = this.#surgeRing.visible = false;
    this.#craft.add(bodyMesh, rim, engine, this.#shield, this.#magnetRing, this.#surgeRing);
    this.#scene.add(this.#craft);

    // The light at the far end of the tunnel.
    this.#farLight = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.#glow,
        color: COLOR.violet,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    this.#scene.add(this.#farLight);

    this.monitor = new FrameMonitor(QUALITY.length, (level) => {
      this.#setQuality(QUALITY[level]!);
      onLowered();
    });

    const reduced = () => (this.#reduced = getEffects() === 'reduced');
    this.#media.addEventListener('change', reduced);
    const stopSettings = onSettingsChange(reduced);
    this.#stopSettings = () => {
      stopSettings();
      this.#media.removeEventListener('change', reduced);
    };

    this.#resize = new ResizeObserver(() => this.#fit());
    this.#resize.observe(container);
    this.#fit();
  }

  /** Start drawing, every animation frame until `destroy`. */
  start(): void {
    const loop = (now: number) => {
      this.#raf = requestAnimationFrame(loop);
      this.#draw(now);
    };
    this.#raf = requestAnimationFrame(loop);
  }

  /** A fresh run: no sparks, no flash, kicks from the top. */
  reset(): void {
    this.#sparks.clear();
    this.#kicks.length = 0;
    this.#nextKick = 0;
    this.#crashed = -1;
    this.#flash.style.opacity = '0';
    this.monitor.reset();
  }

  /** What happened this frame, for sparks and the crash's flare. */
  effects(events: readonly RunEvent[], run: TunnelRun): void {
    const share = this.#quality.particles;
    const n = (k: number) => Math.max(1, Math.round(k * share));
    for (const e of events) {
      if (e.type === 'pickup') {
        const p = this.track.pickups[e.index]!;
        this.#deckAt(p.z, p.lane, PICKUP_HEIGHT, this.#v);
        this.#sparks.burst(this.#v, COLOR.magenta, n(p.kind === 'gem' ? 14 : 7), 3.5);
      } else if (e.type === 'hoop') {
        const h = this.track.hoops[e.index]!;
        this.#deckAt(h.z, h.lane, HOOP_HEIGHT, this.#v);
        this.#sparks.burst(this.#v, COLOR.magenta, n(e.bonus > 0 ? 50 : 22), e.bonus > 0 ? 7 : 4.5);
        if (e.bonus > 0) this.#sparks.burst(this.#v, COLOR.flare, n(20), 5, 0.7);
      } else if (e.type === 'booster') {
        const k = this.track.boosters[e.index]!;
        this.#deckAt(k.z, k.lane, PICKUP_HEIGHT, this.#v);
        this.#sparks.burst(this.#v, boosterColor(k.kind), n(40), 6, 0.7);
      } else if (e.type === 'crash') {
        this.#crashed = e.index;
        this.#deckAt(run.racer.z, e.pos, 0.3, this.#v);
        this.#sparks.burst(this.#v, e.shield ? COLOR.cyan : COLOR.orange, n(30), 6, 0.7);
      } else if (e.type === 'beat' && e.quality === 'perfect') {
        this.#deckAt(run.racer.z - RACER_DEPTH / 2, e.pos, e.y + 0.1, this.#v);
        this.#sparks.burst(this.#v, COLOR.magenta, n(8), 2.5, 0.4);
      } else if (e.type === 'overdrive') {
        this.#deckAt(run.racer.z + 2, run.racer.pos, 0.6, this.#v);
        this.#sparks.burst(this.#v, COLOR.magenta, n(60), 9, 0.8);
      } else if (e.type === 'clean' && e.shield) {
        this.#deckAt(run.racer.z, run.racer.pos, 0.3, this.#v);
        this.#sparks.burst(this.#v, COLOR.cyan, n(24), 4, 0.6);
      }
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.#raf);
    this.#resize.disconnect();
    this.#stopSettings();
    this.#scene.traverse((object) => {
      const o = object as THREE.Mesh;
      o.geometry?.dispose();
      const material = o.material as THREE.Material | THREE.Material[] | undefined;
      for (const m of Array.isArray(material) ? material : material ? [material] : []) m.dispose();
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    this.#glow.dispose();
    this.#bloom.dispose();
    this.#composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.#flash.remove();
  }

  #setQuality(quality: Quality): void {
    this.#quality = quality;
    this.#bloom.enabled = quality.bloom;
    this.#fit();
  }

  /** Size everything to the container, at the quality's pixel ratio. */
  #fit(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const ratio = Math.min(devicePixelRatio || 1, this.#quality.maxPixelRatio);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.#composer.setPixelRatio(ratio);
    this.#composer.setSize(w, h);
    const aspect = w / h;
    const camera = this.#camera;
    camera.aspect = aspect;
    // Wide enough to see the lanes on a phone held upright, without fish-eyeing a wide screen.
    const want = Math.tan((WANT_HFOV * Math.PI) / 360) / aspect;
    const vfov = Math.max(MIN_VFOV, Math.min(MAX_VFOV, (360 / Math.PI) * Math.atan(want)));
    camera.fov = vfov;
    camera.updateProjectionMatrix();
  }

  /** How far behind the craft the camera rides: further on a narrow screen. */
  #cameraBack(): number {
    const camera = this.#camera;
    const halfH = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
    const halfSeen = this.track.lanes / 2 + 0.7;
    return Math.max(CAMERA_BACK, halfSeen / Math.tan(halfH) - 1);
  }

  /** The tunnel's frame at `z`: the tube's centre, forward, right and up. */
  #frameAt(z: number, out: Frame): Frame {
    const p = pathAt(this.track, z);
    const a = pathAt(this.track, z - 1);
    const b = pathAt(this.track, z + 1);
    out.c.set(p.x, p.y, -z);
    out.f.set(b.x - a.x, b.y - a.y, -2).normalize();
    out.r.crossVectors(out.f, UP).normalize();
    out.u.crossVectors(out.r, out.f);
    return out;
  }

  /** The angle round the deck of a place across it, in lanes. */
  #theta(pos: number): number {
    return (pos - this.#lanesMid) / LANE_RADIUS;
  }

  /** A point on the deck (`pos` across in lanes, `height` over it) in a frame. */
  #deck(frame: Frame, pos: number, height: number, out: THREE.Vector3): THREE.Vector3 {
    const t = this.#theta(pos);
    const k = LANE_RADIUS - height;
    return out
      .copy(frame.c)
      .addScaledVector(frame.r, Math.sin(t) * k)
      .addScaledVector(frame.u, -Math.cos(t) * k);
  }

  /** A point on the deck at `z` down the tunnel. */
  #deckAt(z: number, pos: number, height: number, out: THREE.Vector3): THREE.Vector3 {
    return this.#deck(this.#frameAt(z, this.#g), pos, height, out);
  }

  /** Across the deck at `pos`, and its normal (pointing into the tube). */
  #across(frame: Frame, pos: number, out: THREE.Vector3): THREE.Vector3 {
    const t = this.#theta(pos);
    return out.copy(frame.r).multiplyScalar(Math.cos(t)).addScaledVector(frame.u, Math.sin(t));
  }

  #normal(frame: Frame, pos: number, out: THREE.Vector3): THREE.Vector3 {
    const t = this.#theta(pos);
    return out.copy(frame.r).multiplyScalar(-Math.sin(t)).addScaledVector(frame.u, Math.cos(t));
  }

  /** The section's look at song time `t`, and its radius there. */
  #lookAt(t: number): { look: SectionLook; radius: number } {
    const looks = this.track.looks;
    let look = looks[0]!;
    for (const l of looks) {
      if (l.start > t) break;
      look = l;
    }
    const f = Math.max(0, Math.min(1, (t - look.start) / Math.max(1e-6, look.end - look.start)));
    return { look, radius: look.radius + (look.radiusEnd - look.radius) * f };
  }

  /** How much light is left at song time `t`: dim through a stop's dark. */
  #lightAt(t: number): number {
    for (const d of this.track.dark) if (t >= d.time && t < d.end) return DARK_LIGHT;
    return 1;
  }

  /** How far into a drop's set piece song time `t` is, 0 to 1, or -1 outside them. */
  #dropAt(t: number): number {
    for (const d of this.#drops)
      if (t >= d.start && t < d.end) return (t - d.start) / (d.end - d.start);
    return -1;
  }

  /** Fade with distance from the craft: into the night far ahead, out just behind. */
  #fade(dz: number): number {
    const ahead = this.#quality.viewAhead;
    return (1 - smoothstep(ahead * 0.5, ahead, dz)) * smoothstep(-VIEW_BEHIND, -2, dz);
  }

  /** Place instance `i` of a mesh: at `at`, turned to a frame's axes, scaled. */
  #place(
    mesh: THREE.InstancedMesh,
    i: number,
    at: THREE.Vector3,
    x: THREE.Vector3,
    y: THREE.Vector3,
    z: THREE.Vector3,
    sx: number,
    sy: number,
    sz: number,
    color: THREE.Color,
  ): void {
    this.#m.makeBasis(x, y, z);
    this.#q.setFromRotationMatrix(this.#m);
    this.#s.set(sx, sy, sz);
    this.#m.compose(at, this.#q, this.#s);
    mesh.setMatrixAt(i, this.#m);
    mesh.setColorAt(i, color);
  }

  #finish(mesh: THREE.InstancedMesh, count: number): void {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /**
   * The deck ahead of an obstacle, so the rhythm can be read before it arrives: orange
   * strips fading in over the beat before it in every lane it blocks (where a sliding
   * block ends up), and a cyan strip in the open lanes of a wall: the safe path.
   */
  #telegraph(o: Obstacle): void {
    const track = this.track;
    const zr = this.#zr;
    const gap = o.kind === 'wall' || o.kind === 'stop' || o.kind === 'squeeze';
    const period = periodAt(track.grid, o.time);
    const lead = o.z0 - zAtTime(track, o.time - period * (gap ? GAP_BEATS : TELEGRAPH_BEATS));
    if (lead <= 0.1) return;
    const [pa, pb, da, db] = this.#lineVectors;
    const a = this.#h;
    const b = this.#g;
    const ca = this.#color2;
    const cb = this.#color3;
    const steps = 4;
    this.#frameAt(o.z0 - lead, a);
    for (let j = 0; j < steps; j++) {
      const za = o.z0 - lead + (lead * j) / steps;
      const zb = o.z0 - lead + (lead * (j + 1)) / steps;
      this.#frameAt(zb, b);
      const ka = Math.pow(j / steps, 1.5);
      const kb = Math.pow((j + 1) / steps, 1.5);
      const lightA = this.#lightAt(timeAtZ(track, za)) * this.#fade(za - zr);
      const lightB = this.#lightAt(timeAtZ(track, zb)) * this.#fade(zb - zr);
      if (lightA > 0.002 || lightB > 0.002)
        for (let lane = 0; lane < track.lanes; lane++) {
          const k = o.lanes.indexOf(lane);
          if (k < 0 && !gap) continue;
          const pos = k < 0 ? lane : obstacleLaneAt(o, k, o.time);
          const colour = k < 0 ? COLOR.cyan : COLOR.orange;
          const peak = k < 0 ? 0.32 : 0.6;
          this.#deck(a, pos, 0.014, pa);
          this.#deck(b, pos, 0.014, pb);
          this.#across(a, pos, da);
          this.#across(b, pos, db);
          ca.copy(colour).multiplyScalar(peak * ka * lightA);
          cb.copy(colour).multiplyScalar(peak * kb * lightB);
          this.#ribbons.quad(pa, da, ca, pb, db, cb, TELEGRAPH_HALF);
        }
      a.c.copy(b.c);
      a.f.copy(b.f);
      a.r.copy(b.r);
      a.u.copy(b.u);
    }
  }

  #draw(now: number): void {
    const start = performance.now();
    const state = this.frame();
    const dt = this.#lastFrame > 0 ? Math.min(0.1, (now - this.#lastFrame) / 1000) : 0;
    this.#lastFrame = now;

    const { time, run } = state;
    const track = this.track;
    const grid = track.grid;
    const racer = run.racer;
    const zr = racer.z;
    this.#zr = zr;
    const reduced = this.#reduced;
    const zMin = zr - VIEW_BEHIND;
    const zMax = zr + this.#quality.viewAhead;

    // The pulse: the bass of this beat and the last kick, fading.
    while (
      this.#nextKick < track.pulse.kicks.length &&
      track.pulse.kicks[this.#nextKick]!.time <= time
    ) {
      const kick = track.pulse.kicks[this.#nextKick++]!;
      if (time - kick.time < KICK_TIME) this.#kicks.push(kick);
    }
    while (this.#kicks.length > 0 && time - this.#kicks[0]!.time >= KICK_TIME) this.#kicks.shift();
    // Back in time (a restart): find the place again.
    if (this.#nextKick > 0 && track.pulse.kicks[this.#nextKick - 1]!.time > time + 1) {
      this.#nextKick = 0;
      this.#kicks.length = 0;
    }
    const lastKick = this.#kicks[this.#kicks.length - 1];
    const kickEnv = lastKick ? lastKick.strength * Math.exp(-(time - lastKick.time) / 0.12) : 0;
    const bass = time >= 0 ? (track.pulse.bass[beatIndexAt(grid, time)] ?? 0) : 0;
    const soft = reduced ? 0.4 : 1;
    const beats = beatAt(grid, time);
    const beatPhase = beats - Math.floor(beats);
    const drop = this.#dropAt(time);
    const overdrive = run.overdriveAt(time);
    const here = this.#lookAt(time);
    // The tube opens a little further on every beat where the look says so (the drop's
    // burst, strongest on the downbeat).
    const burst =
      soft *
      here.look.burst *
      Math.max(0, 1 - beatPhase * 2.5) *
      (beatInBar(grid, time) === 0 ? 1 : 0.45);
    const breathe = 1 + soft * (0.05 * bass + 0.05 * kickEnv) + burst;

    // Rings of light down the tube, on the section's beats.
    const f = this.#f;
    let rings = 0;
    let walls = 0;
    {
      const b0 = Math.ceil(beatAt(grid, timeAtZ(track, zMin)) * 2) / 2;
      for (let b = b0; rings < MAX_RINGS; b += 0.5) {
        const t = timeOfBeat(grid, b);
        const z = zAtTime(track, t);
        if (z > zMax) break;
        const { look, radius } = this.#lookAt(t);
        const steps = b / look.ringBeats;
        if (Math.abs(steps - Math.round(steps)) > 1e-3) continue;
        const light = this.#lightAt(t) * this.#fade(z - zr);
        if (light <= 0.002) continue;
        this.#frameAt(z, f);
        const downbeat = Math.abs(b / 4 - Math.round(b / 4)) < 1e-3;
        const inDrop = this.#dropAt(t) >= 0;
        // Rings on the drop's beats are magenta, and flash on the beat.
        const color = this.#color.copy(inDrop || overdrive ? COLOR.magenta : COLOR.violet);
        let k = (0.3 + look.glow * 0.5) * (downbeat ? 1.4 : 1);
        if (drop >= 0 && !reduced) k *= 1 + 1.2 * Math.max(0, 1 - beatPhase * 3);
        k *= 1 + 0.6 * kickEnv * soft;
        color.multiplyScalar(k * light);
        const r = TUBE_RADIUS * radius * breathe;
        this.#back.copy(f.f).negate();
        this.#place(this.#rings, rings++, f.c, f.r, f.u, this.#back, r, r, r, color);
        if (look.ringWalls && Number.isInteger(b) && walls < MAX_WALLS) {
          // Gates turning with the beat, each wall the other way round from the last.
          const wall = this.#color2.copy(COLOR.violet).multiplyScalar(0.3 * light);
          const turn =
            (b % 2 === 0 ? 1 : -1) * (beats * look.spin + 0.15 * kickEnv) * soft + b * 0.45;
          const c = Math.cos(turn);
          const sn = Math.sin(turn);
          this.#d.copy(f.r).multiplyScalar(c).addScaledVector(f.u, sn);
          this.#e.copy(f.r).multiplyScalar(-sn).addScaledVector(f.u, c);
          this.#place(this.#walls, walls++, f.c, this.#d, this.#e, this.#back, r, r, r, wall);
        }
      }
    }
    this.#finish(this.#rings, rings);
    this.#finish(this.#walls, walls);

    // The lane lines, the deck's lanes, and the tube's long lines.
    const ribbons = this.#ribbons;
    ribbons.begin();
    {
      const lanes = track.lanes;
      const a = this.#h;
      const [pa, pb, da, db] = this.#lineVectors;
      const ca = this.#color;
      const cb = this.#color2;
      // Sampled on a fixed grid down the tunnel, so the lines don't shimmer as it moves.
      let za = Math.floor(zMin / LINE_STEP) * LINE_STEP;
      let lightA = this.#lightAt(timeAtZ(track, za)) * this.#fade(za - zr);
      let radiusA = this.#lookAt(timeAtZ(track, za)).radius;
      this.#frameAt(za, a);
      for (let zb = za + LINE_STEP; za < zMax; zb += LINE_STEP) {
        const b = this.#frameAt(zb, f);
        const tb = timeAtZ(track, zb);
        const lightB = this.#lightAt(tb) * this.#fade(zb - zr);
        const radiusB = this.#lookAt(tb).radius;
        if (lightA > 0.002 || lightB > 0.002) {
          // Lane edges: the deck's outer edges brighter.
          for (let i = 0; i <= lanes; i++) {
            const pos = i - 0.5;
            const edge = i === 0 || i === lanes;
            const k = edge ? 0.75 : 0.3;
            this.#deck(a, pos, 0, pa);
            this.#deck(b, pos, 0, pb);
            this.#across(a, pos, da);
            this.#across(b, pos, db);
            ca.copy(COLOR.cyan).multiplyScalar(k * lightA);
            cb.copy(COLOR.cyan).multiplyScalar(k * lightB);
            ribbons.quad(pa, da, ca, pb, db, cb, edge ? 0.045 : 0.025);
          }
          // Each lane's floor, faint.
          for (let i = 0; i < lanes; i++) {
            this.#deck(a, i, -0.01, pa);
            this.#deck(b, i, -0.01, pb);
            this.#across(a, i, da);
            this.#across(b, i, db);
            ca.copy(COLOR.cyan).multiplyScalar(0.012 * lightA);
            cb.copy(COLOR.cyan).multiplyScalar(0.012 * lightB);
            ribbons.quad(pa, da, ca, pb, db, cb, 0.46);
          }
          // The tube's long lines, breathing with it.
          for (const angle of TUBE_LINES) {
            const s = Math.sin(angle);
            const c = Math.cos(angle);
            const ra = TUBE_RADIUS * radiusA * breathe;
            const rb = TUBE_RADIUS * radiusB * breathe;
            pa.copy(a.c)
              .addScaledVector(a.r, s * ra)
              .addScaledVector(a.u, -c * ra);
            pb.copy(b.c)
              .addScaledVector(b.r, s * rb)
              .addScaledVector(b.u, -c * rb);
            da.copy(a.r).multiplyScalar(c).addScaledVector(a.u, s);
            db.copy(b.r).multiplyScalar(c).addScaledVector(b.u, s);
            const k = (0.18 + 0.25 * here.look.glow) * (1 + 0.8 * bass * soft);
            ca.copy(COLOR.violet).multiplyScalar(k * lightA);
            cb.copy(COLOR.violet).multiplyScalar(k * lightB);
            ribbons.quad(pa, da, ca, pb, db, cb, 0.03);
          }
        }
        a.c.copy(b.c);
        a.f.copy(b.f);
        a.r.copy(b.r);
        a.u.copy(b.u);
        za = zb;
        lightA = lightB;
        radiusA = radiusB;
      }
    }

    // A mark across the deck on every beat, stronger on the downbeat: the pulse to count.
    {
      const [pa, pb] = this.#lineVectors;
      const a = this.#h;
      const c = this.#color;
      const first = Math.max(0, Math.ceil(beatAt(grid, timeAtZ(track, zMin))));
      for (let b = first; b < grid.beats.length; b++) {
        const t = timeOfBeat(grid, b);
        const z = zAtTime(track, t);
        if (z > zMax) break;
        const light = this.#lightAt(t) * this.#fade(z - zr);
        if (light <= 0.002) continue;
        this.#frameAt(z, a);
        const down = beatInBar(grid, t + 1e-3) === 0;
        c.copy(COLOR.magenta).multiplyScalar((down ? 0.85 : 0.3) * light);
        for (let i = 0; i < track.lanes; i++) {
          this.#deck(a, i - 0.5, 0.012, pa);
          this.#deck(a, i + 0.5, 0.012, pb);
          this.#ribbons.quad(pa, a.f, c, pb, a.f, c, down ? 0.07 : 0.035);
        }
      }
    }

    // Held sounds: a rail of light along its lane, rings of light across the tube.
    let holdRings = 0;
    {
      const pa = this.#v;
      const pb = this.#w;
      const da = this.#d;
      const db = this.#e;
      const ca = this.#color;
      const cb = this.#color2;
      const a = this.#h;
      for (const h of track.holds) {
        if (h.z1 < zMin || h.z0 > zMax) continue;
        const z0 = Math.max(h.z0, zMin);
        const z1 = Math.min(h.z1, zMax);
        if (h.lane !== null) {
          for (let z = z0; z < z1; z += LINE_STEP) {
            const zb = Math.min(z1, z + LINE_STEP);
            this.#frameAt(z, a);
            this.#frameAt(zb, f);
            this.#deck(a, h.lane, 0.02, pa);
            this.#deck(f, h.lane, 0.02, pb);
            this.#across(a, h.lane, da);
            this.#across(f, h.lane, db);
            ca.copy(COLOR.magenta).multiplyScalar(0.5 * this.#fade(z - zr));
            cb.copy(COLOR.magenta).multiplyScalar(0.5 * this.#fade(zb - zr));
            this.#ribbons.quad(pa, da, ca, pb, db, cb, 0.09);
          }
        } else {
          for (let z = z0; z <= z1 && holdRings < MAX_HOLD_RINGS; z += 2) {
            this.#frameAt(z, f);
            const t = timeAtZ(track, z);
            const r = TUBE_RADIUS * this.#lookAt(t).radius * 0.97 * breathe;
            ca.copy(COLOR.magenta).multiplyScalar(0.7 * this.#fade(z - zr));
            this.#back.copy(f.f).negate();
            this.#place(this.#holdRings, holdRings++, f.c, f.r, f.u, this.#back, r, r, r, ca);
          }
        }
      }
    }
    this.#finish(this.#holdRings, holdRings);

    // Kick rings: a ring of the beat's colour opening out around the craft on each kick.
    let kickRings = 0;
    for (const kick of this.#kicks) {
      if (kickRings >= MAX_KICK_RINGS) break;
      const age = (time - kick.time) / KICK_TIME;
      this.#frameAt(zr + 1.5, f);
      const r = TUBE_RADIUS * here.radius * (0.55 + 0.45 * age);
      const color = this.#color
        .copy(COLOR.magenta)
        .multiplyScalar(
          kick.strength * (1 - age) * (drop >= 0 ? 2.4 : 1.6) * soft * this.#lightAt(time),
        );
      this.#back.copy(f.f).negate();
      this.#place(this.#kickRings, kickRings++, f.c, f.r, f.u, this.#back, r, r, r, color);
    }
    this.#finish(this.#kickRings, kickRings);

    // Obstacles: one glowing block per lane each blocks, where it is now (sliding ones slide).
    let blocks = 0;
    {
      const obstacles = track.obstacles;
      let lo = 0;
      let hi = obstacles.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (obstacles[mid]!.z1 < zMin) lo = mid + 1;
        else hi = mid;
      }
      const sinceCrash = time - run.crashedAt;
      for (let i = lo; i < obstacles.length && blocks < MAX_BLOCKS; i++) {
        const o = obstacles[i]!;
        if (o.z0 > zMax) break;
        const zMid = (o.z0 + o.z1) / 2;
        const light = this.#fade(zMid - zr);
        if (light <= 0.002) continue;
        this.#frameAt(zMid, f);
        const height = o.low ? LOW_WALL_HEIGHT : BLOCK_HEIGHT;
        const color = this.#color.copy(COLOR.orange);
        if (i === this.#crashed && sinceCrash < CRASH_TIME * 2)
          color.lerp(COLOR.flare, 0.7 * (1 - sinceCrash / (CRASH_TIME * 2)));
        color.multiplyScalar(light);
        this.#telegraph(o);
        this.#back.copy(f.f).negate();
        for (let k = 0; k < o.lanes.length && blocks < MAX_BLOCKS; k++) {
          const pos = obstacleLaneAt(o, k, time);
          this.#deck(f, pos, height / 2, this.#v);
          this.#across(f, pos, this.#d);
          this.#normal(f, pos, this.#e);
          this.#place(
            this.#blocks,
            blocks++,
            this.#v,
            this.#d,
            this.#e,
            this.#back,
            BLOCK_HALF * 2,
            height,
            BLOCK_DEPTH,
            color,
          );
        }
      }
    }
    this.#finish(this.#blocks, blocks);

    // Pickups: spinning magenta gems, gone once taken.
    let pickups = 0;
    {
      const list = track.pickups;
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid]!.z < zMin) lo = mid + 1;
        else hi = mid;
      }
      const spin = time * 2.4;
      const magnet = run.magnetAt(time);
      for (let i = lo; i < list.length && pickups < MAX_PICKUPS; i++) {
        const p = list[i]!;
        if (p.z > zMax) break;
        if (run.isCollected(i)) continue;
        const light = this.#fade(p.z - zr) * this.#lightAt(p.time);
        if (light <= 0.002) continue;
        this.#frameAt(p.z, f);
        const size = p.kind === 'gem' ? 0.2 : 0.13;
        const bob = 0.05 * Math.sin(spin * 1.7 + i);
        // With the magnet, gems in the lanes beside the craft fly into it.
        let pos = p.lane;
        if (magnet && Math.abs(p.lane - racer.pos) < MAGNET_REACH && p.z - zr < MAGNET_PULL)
          pos += (racer.pos - p.lane) * (1 - smoothstep(0, MAGNET_PULL, p.z - zr));
        this.#deck(f, pos, PICKUP_HEIGHT + bob, this.#v);
        this.#across(f, pos, this.#d);
        this.#normal(f, pos, this.#e);
        // Spin round the deck's normal.
        this.#d.applyAxisAngle(this.#e, spin + i);
        this.#back.crossVectors(this.#d, this.#e);
        const k = (p.kind === 'gem' ? 1.8 : 1.2) * light;
        const color = this.#color.copy(COLOR.magenta).multiplyScalar(k);
        this.#place(
          this.#pickups,
          pickups++,
          this.#v,
          this.#d,
          this.#e,
          this.#back,
          size,
          size * 1.4,
          size,
          color,
        );
      }
    }
    this.#finish(this.#pickups, pickups);

    // Boost hoops: magenta rings standing in their lane, pulsing on the beat.
    let hoops = 0;
    {
      const list = track.hoops;
      const pulse = 1 + 0.5 * Math.max(0, 1 - beatPhase * 3) * soft;
      for (let i = 0; i < list.length && hoops < MAX_HOOPS; i++) {
        const h = list[i]!;
        if (h.z < zMin) continue;
        if (h.z > zMax) break;
        if (run.hoopTaken(i)) continue;
        const light = this.#fade(h.z - zr) * this.#lightAt(h.time);
        if (light <= 0.002) continue;
        this.#frameAt(h.z, f);
        this.#deck(f, h.lane, HOOP_HEIGHT, this.#v);
        this.#across(f, h.lane, this.#d);
        this.#normal(f, h.lane, this.#e);
        this.#back.copy(f.f).negate();
        const color = this.#color.copy(COLOR.magenta).multiplyScalar(1.5 * pulse * light);
        const r = HOOP_RADIUS;
        this.#place(this.#hoops, hoops++, this.#v, this.#d, this.#e, this.#back, r, r, r, color);
      }
    }
    this.#finish(this.#hoops, hoops);

    // Boosters: a bright core in two turning halos, in the booster's colour.
    let cores = 0;
    let halos = 0;
    {
      const list = track.boosters;
      for (let i = 0; i < list.length && cores < MAX_BOOSTERS; i++) {
        const k = list[i]!;
        if (k.z < zMin) continue;
        if (k.z > zMax) break;
        if (run.boosterTaken(i)) continue;
        const light = this.#fade(k.z - zr) * this.#lightAt(k.time);
        if (light <= 0.002) continue;
        this.#frameAt(k.z, f);
        const base = boosterColor(k.kind);
        const height = PICKUP_HEIGHT + 0.12 + 0.06 * Math.sin(time * 3 + i);
        this.#deck(f, k.lane, height, this.#v);
        this.#across(f, k.lane, this.#d);
        this.#normal(f, k.lane, this.#e);
        const color = this.#color.copy(base).multiplyScalar(1.7 * light);
        this.#back.crossVectors(this.#d, this.#e);
        this.#place(
          this.#boostCores,
          cores++,
          this.#v,
          this.#d,
          this.#e,
          this.#back,
          0.2,
          0.2,
          0.2,
          color,
        );
        const halo = this.#color2.copy(base).multiplyScalar(1.2 * light);
        // One ring standing, turning round the deck's normal; one lying flat.
        this.#w.copy(this.#d).applyAxisAngle(this.#e, time * 2 + i);
        this.#u.crossVectors(this.#w, this.#e);
        this.#place(
          this.#boostHalos,
          halos++,
          this.#v,
          this.#w,
          this.#e,
          this.#u,
          0.46,
          0.46,
          0.46,
          halo,
        );
        this.#place(
          this.#boostHalos,
          halos++,
          this.#v,
          this.#d,
          this.#u.copy(this.#back).negate(),
          this.#e,
          0.36,
          0.36,
          0.36,
          halo,
        );
      }
    }
    this.#finish(this.#boostCores, cores);
    this.#finish(this.#boostHalos, halos);

    // The calm parts' stars: dim violet points in the tube, fixed in the world and
    // twinkling a little with the bass.
    {
      const span = zMax - zMin;
      const pos = this.#starPos;
      const col = this.#starCol;
      let n = 0;
      for (let i = 0; i < MAX_STARS; i++) {
        const z = zMin + ((((STARS[i * 4]! - zMin) % span) + span) % span);
        const t = timeAtZ(track, z);
        const look = this.#lookAt(t);
        if (look.look.stars <= 0 || STARS[i * 4 + 1]! >= look.look.stars) continue;
        const light = this.#lightAt(t) * this.#fade(z - zr);
        if (light <= 0.002) continue;
        this.#frameAt(z, f);
        const angle = STARS[i * 4 + 2]!;
        const reach = TUBE_RADIUS * look.radius * STARS[i * 4 + 3]! * breathe;
        const k = (0.3 + 0.2 * Math.sin(time * 1.6 + i * 7.3)) * (1 + 0.8 * bass * soft) * light;
        const sn = Math.sin(angle) * reach;
        const cs = Math.cos(angle) * reach;
        pos[n * 3] = f.c.x + f.r.x * sn - f.u.x * cs;
        pos[n * 3 + 1] = f.c.y + f.r.y * sn - f.u.y * cs;
        pos[n * 3 + 2] = f.c.z + f.r.z * sn - f.u.z * cs;
        col[n * 3] = COLOR.violet.r * k;
        col[n * 3 + 1] = COLOR.violet.g * k;
        col[n * 3 + 2] = COLOR.violet.b * k;
        n++;
      }
      const g = this.#stars.geometry;
      g.setDrawRange(0, n);
      g.attributes.position!.needsUpdate = true;
      g.attributes.color!.needsUpdate = true;
    }
    ribbons.end();

    // The craft: on its lane (between two while hopping), its feet at its height, banked
    // with the deck and leaning into a hop.
    {
      this.#frameAt(zr - RACER_DEPTH / 2, f);
      const pos = racer.pos;
      this.#deck(f, pos, racer.y + 0.06, this.#v);
      this.#across(f, pos, this.#d);
      this.#normal(f, pos, this.#e);
      this.#back.copy(f.f).negate();
      this.#m.makeBasis(this.#d, this.#e, this.#back);
      this.#craft.position.copy(this.#v);
      this.#craft.quaternion.setFromRotationMatrix(this.#m);
      const lean = Math.max(-0.5, Math.min(0.5, (racer.lane - pos) * 0.9));
      this.#craft.rotateZ(-lean);
      this.#craft.rotateX(Math.max(-0.25, Math.min(0.35, racer.vy * 0.06)));
      const shieldHit = time - run.shieldHitAt;
      this.#shield.visible = run.shield || shieldHit < CRASH_TIME;
      this.#shield.rotation.y = time * 1.3;
      this.#shield.scale.setScalar(run.shield ? 1 + 0.06 * kickEnv : 1 + shieldHit * 3);
      this.#magnetRing.visible = run.magnetAt(time);
      this.#magnetRing.scale.setScalar(1 + 0.1 * Math.sin(time * 9) + 0.15 * kickEnv * soft);
      this.#surgeRing.visible = run.surgeAt(time);
      this.#surgeRing.rotation.y = time * 4;
      this.#surgeRing.scale.setScalar(1 + 0.12 * kickEnv * soft);
    }

    // The camera: behind the craft and above the deck, following its lane halfway and
    // banking a little with the deck; shaken for a moment by a crash.
    {
      const back = this.#cameraBack();
      // Averaged over a few frames of the path, so its bends come in smoothly.
      const g = this.#g;
      const cam = this.#v.set(0, 0, 0);
      const up = this.#w.set(0, 0, 0);
      const right = this.#d.set(0, 0, 0);
      for (const dz of [-3, -1.5, 0, 1.5, 3]) {
        this.#frameAt(zr - back + dz, g);
        cam.add(g.c);
        up.add(g.u);
        right.add(g.r);
      }
      cam.multiplyScalar(1 / 5);
      up.normalize();
      right.normalize();
      const follow = (racer.pos - this.#lanesMid) * 0.55;
      cam.addScaledVector(right, follow).addScaledVector(up, -LANE_RADIUS + CAMERA_UP);
      const sinceCrash = time - run.crashedAt;
      if (sinceCrash >= 0 && sinceCrash < CRASH_TIME && !reduced) {
        const k = 1 - sinceCrash / CRASH_TIME;
        cam.addScaledVector(right, Math.sin(sinceCrash * 70) * 0.22 * k);
        cam.addScaledVector(up, Math.cos(sinceCrash * 55) * 0.14 * k);
      }
      this.#camera.position.copy(cam);
      this.#frameAt(zr + LOOK_AHEAD, f);
      const target = this.#e
        .copy(f.c)
        .addScaledVector(f.r, follow * 0.6)
        .addScaledVector(f.u, -LANE_RADIUS + 1);
      const roll = this.#theta(racer.pos) * 0.35;
      this.#camera.up.copy(up).applyAxisAngle(f.f, roll);
      this.#camera.lookAt(target);
      // The flash, over the whole screen.
      const flash = sinceCrash >= 0 && sinceCrash < CRASH_TIME && !reduced;
      this.#flash.style.opacity = flash ? String(0.55 * (1 - sinceCrash / CRASH_TIME)) : '0';
    }

    // The light at the far end: violet, magenta through a drop.
    {
      this.#frameAt(zMax, f);
      this.#farLight.position.copy(f.c);
      const size = TUBE_RADIUS * 9;
      this.#farLight.scale.set(size, size, 1);
      const material = this.#farLight.material;
      material.color
        .copy(drop >= 0 || overdrive ? COLOR.magenta : COLOR.violet)
        .multiplyScalar((0.12 + 0.15 * here.look.glow + 0.15 * bass * soft) * this.#lightAt(time));
    }

    this.#sparks.update(state.paused ? 0 : dt);
    this.#bloom.strength =
      BLOOM_STRENGTH *
      (0.75 + 0.35 * here.look.glow) *
      (drop >= 0 ? 1.25 : 1) *
      (overdrive ? 1.15 : 1);
    this.#composer.render();

    const interval = now - this.#lastStart;
    this.#lastStart = now;
    if (state.paused) this.monitor.reset();
    else if (interval > 0) this.monitor.frame(interval, performance.now() - start);
  }
}
