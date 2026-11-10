import {
  buildLevelMap,
  DIFFICULTIES,
  type Difficulty,
  type LevelMap,
  type SongAnalysis,
} from '../core';
import {
  cameraAt,
  generateLevelInWorker,
  solidTop,
  spikesOut,
  xAtTime,
  type ChunkKind,
  type PlatformerLevel,
  type Solid,
} from '../games/platformer/level';
import { PLAYER_HEIGHT, PLAYER_WIDTH, SPIKE_HEIGHT, VIEW_WIDTH } from '../games/platformer/physics';
import { palette } from '../theme/palette';
import { alpha, CANVAS_FONT, sizedCanvas } from './canvas';
import './level-preview.css';

/** Builds a level; the default does it in a worker. */
export type LevelBuilder = (map: LevelMap, difficulty: Difficulty) => Promise<PlatformerLevel>;

export interface LevelPreviewOptions {
  analysis: SongAnalysis;
  build?: LevelBuilder;
}

export interface LevelPreview {
  element: HTMLElement;
  /** Draw the level as it is at song time `time`. */
  draw(time: number): void;
  destroy(): void;
}

/** World heights the preview shows, from the pits up to above the highest steps. */
const WORLD_TOP = 470;
const WORLD_BOTTOM = -90;
/** World pixels shown behind the camera's left edge. */
const BEHIND = 160;
/** Height of the strip naming each stretch, px. */
const STRIP = 22;

const DIFFICULTY_NAMES: Record<Difficulty, string> = {
  easy: 'Easy',
  normal: 'Normal',
  hard: 'Hard',
};

const CHUNK_NAMES: Record<ChunkKind, string> = {
  'run-in': 'Run-in',
  'run-out': 'Run-out',
  flat: 'Run',
  calm: 'Calm',
  gap: 'Gaps',
  'dash-gap': 'Dash gap',
  gate: 'Gates',
  overhang: 'Overhang',
  eq: 'Equaliser',
  bridge: 'Bridges',
  spikes: 'Spikes',
  drop: 'Drop',
};

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

/** True for stretches with something to get past. */
const isObstacle = (kind: ChunkKind) =>
  kind !== 'flat' && kind !== 'calm' && kind !== 'run-in' && kind !== 'run-out';

/**
 * A side-on preview of the platformer level built from the song, at a difficulty the
 * player picks, following the playhead: what the camera sees, the moving parts where the
 * music puts them, and where a player in time with the music would be.
 */
export function createLevelPreview({
  analysis,
  build = generateLevelInWorker,
}: LevelPreviewOptions): LevelPreview {
  const map = buildLevelMap(analysis);
  let level: PlatformerLevel | null = null;
  let difficulty: Difficulty = 'normal';
  let request = 0;
  let destroyed = false;

  const root = el('section', 'level-preview');
  root.setAttribute('aria-labelledby', 'level-preview-title');

  const head = el('header', 'level-preview__head');
  const title = el('h2', 'level-preview__title', 'Platformer level');
  title.id = 'level-preview-title';

  const picker = el('div', 'segmented');
  picker.setAttribute('role', 'radiogroup');
  picker.setAttribute('aria-label', 'Difficulty');
  const buttons = DIFFICULTIES.map((d) => {
    const button = el('button', 'segmented__option', DIFFICULTY_NAMES[d]);
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.addEventListener('click', () => pick(d));
    picker.append(button);
    return button;
  });

  const stats = el('dl', 'stats stats--level');
  const statValues = new Map<string, HTMLElement>();
  const stat = (key: string, label: string) => {
    const cell = el('div', 'stats__cell');
    const value = el('dd', 'stats__value', '—');
    statValues.set(key, value);
    cell.append(el('dt', 'stats__label', label), value);
    stats.append(cell);
  };
  stat('obstacles', 'Obstacles');
  stat('repaired', 'Repaired');
  stat('coins', 'Coins');
  stat('gems', 'Gems');
  head.append(title, picker, stats);

  const figure = el('figure', 'timeline timeline--level');
  const canvas = el('canvas', 'timeline__canvas');
  canvas.setAttribute(
    'aria-label',
    'Side-on view of the generated platformer level around the playhead',
  );
  const spinner = el('span', 'timeline__spinner');
  spinner.innerHTML = SPINNER_ICON;
  const status = el('p', 'level-preview__status');
  status.setAttribute('aria-live', 'polite');
  figure.append(canvas, spinner, status);

  const legend = el('ul', 'legend');
  legend.setAttribute('aria-label', 'Level legend');
  const legendItem = (label: string, colour: string, shape: 'line' | 'dot' | 'block') => {
    const item = el('li', 'legend__item');
    const swatch = el('span', `legend__swatch legend__swatch--${shape}`);
    swatch.style.setProperty('--c', colour);
    item.append(swatch, el('span', '', label));
    legend.append(item);
  };
  legendItem('Player in time with the music', palette.cyan, 'block');
  legendItem('Camera view', palette.cyan, 'line');
  legendItem('Ground and equalisers', palette.violet, 'block');
  legendItem('Bridge (on snares)', palette.cyan, 'line');
  legendItem('Spikes (on off-beats)', palette.orange, 'block');
  legendItem('Drop staircase', palette.magenta, 'block');
  legendItem('Coins and gems', palette.magenta, 'dot');

  root.append(head, figure, legend);

  function renderState(): void {
    const busy = level === null && status.textContent === '';
    buttons.forEach((button, i) => {
      const on = DIFFICULTIES[i] === difficulty;
      button.setAttribute('aria-checked', String(on));
      button.tabIndex = on ? 0 : -1;
    });
    figure.setAttribute('aria-busy', String(busy));
    spinner.hidden = !busy;
    const chunks = level?.chunks ?? [];
    const set = (key: string, value: number | null) => {
      statValues.get(key)!.textContent = value === null ? '—' : String(value);
    };
    set('obstacles', level ? chunks.filter((c) => isObstacle(c.kind)).length : null);
    set('repaired', level ? chunks.filter((c) => c.repairs > 0).length : null);
    set('coins', level ? level.pickups.filter((p) => p.kind === 'coin').length : null);
    set('gems', level ? level.pickups.filter((p) => p.kind === 'gem').length : null);
  }

  function pick(next: Difficulty): void {
    difficulty = next;
    level = null;
    status.textContent = '';
    const mine = ++request;
    renderState();
    build(map, next).then(
      (built) => {
        if (destroyed || mine !== request) return;
        level = built;
        renderState();
      },
      (error: unknown) => {
        if (destroyed || mine !== request) return;
        console.error(error);
        status.textContent = "The level couldn't be built for this song";
        renderState();
      },
    );
  }

  // Arrow keys move between the difficulties, as in any radio group.
  picker.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const i = (DIFFICULTIES.indexOf(difficulty) + step + DIFFICULTIES.length) % DIFFICULTIES.length;
    pick(DIFFICULTIES[i]!);
    buttons[i]!.focus();
  });

  pick(difficulty);

  // ---------- drawing ----------

  function draw(time: number): void {
    const sized = sizedCanvas(canvas);
    if (!sized) return;
    const { ctx, w, h } = sized;
    ctx.clearRect(0, 0, w, h);
    if (!level) return;
    const l = level;
    const scale = (h - STRIP) / (WORLD_TOP - WORLD_BOTTOM);
    const camera = cameraAt(l, time);
    const from = camera - BEHIND;
    const to = from + w / scale;
    const px = (x: number) => (x - from) * scale;
    const py = (y: number) => STRIP + (WORLD_TOP - y) * scale;

    // The beat grid: bars brighter, in the beat colour.
    const period = l.beatPeriod;
    const firstBeat = Math.ceil(((from - xAtTime(l, 0)) / l.speed - l.gridStart) / period);
    for (let k = firstBeat; ; k++) {
      const t = l.gridStart + k * period;
      const x = px(xAtTime(l, t));
      if (x > w) break;
      const bar = map.downbeats.some((d) => Math.abs(d - t) < 1e-6);
      ctx.fillStyle = alpha(bar ? palette.magenta : palette.violet, bar ? 0.28 : 0.12);
      ctx.fillRect(x, STRIP, 1, h - STRIP);
    }

    // What the camera sees.
    const v0 = px(camera);
    const v1 = px(camera + VIEW_WIDTH);
    ctx.fillStyle = alpha(palette.dusk, 0.55);
    ctx.fillRect(v0, STRIP, v1 - v0, h - STRIP);
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = alpha(palette.cyan, 0.6);
    ctx.lineWidth = 1;
    for (const x of [v0, v1]) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, STRIP);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // The stretches, named in the strip along the top.
    ctx.font = `600 10px ${CANVAS_FONT}`;
    ctx.textBaseline = 'middle';
    for (const c of l.chunks) {
      if (c.x1 < from || c.x0 > to) continue;
      const x0 = Math.max(0, px(c.x0));
      const x1 = Math.min(w, px(c.x1));
      ctx.fillStyle = alpha(palette.line, 0.9);
      ctx.fillRect(px(c.x0), 0, 1, h);
      const label = CHUNK_NAMES[c.kind].toUpperCase();
      const note = c.repairs > 0 ? ` · EASED ×${c.repairs}` : '';
      // Only names that fit their stretch's visible part, so neighbours never overlap.
      const labelWidth = ctx.measureText(label).width;
      if (labelWidth + 12 > x1 - x0) continue;
      ctx.fillStyle =
        c.kind === 'drop' ? palette.magenta : isObstacle(c.kind) ? palette.ink : palette.muted;
      ctx.fillText(label, x0 + 6, STRIP / 2);
      if (note && labelWidth + ctx.measureText(note).width + 12 <= x1 - x0) {
        ctx.fillStyle = palette.muted;
        ctx.fillText(note, x0 + 6 + labelWidth, STRIP / 2);
      }
    }

    // Solids as they are now.
    for (const s of l.solids) {
      if (s.x1 < from || s.x0 > to) continue;
      drawSolid(ctx, s, solidTop(s, time), px, py, h);
    }

    // Spikes: tall when out, flat when in.
    const out = spikesOut(l, time);
    ctx.fillStyle = alpha(palette.orange, out ? 0.95 : 0.45);
    for (const s of l.spikes) {
      if (s.x1 < from || s.x0 > to) continue;
      const tall = (out ? SPIKE_HEIGHT : 4) * scale;
      const base = py(s.top);
      const teeth = Math.max(1, Math.round((s.x1 - s.x0) / 12));
      const width = (px(s.x1) - px(s.x0)) / teeth;
      ctx.beginPath();
      for (let i = 0; i < teeth; i++) {
        const x = px(s.x0) + i * width;
        ctx.moveTo(x, base);
        ctx.lineTo(x + width / 2, base - tall);
        ctx.lineTo(x + width, base);
      }
      ctx.fill();
    }

    // Dash gates: orange bars from their ground up.
    ctx.fillStyle = palette.orange;
    for (const g of l.gates) {
      if (g.x < from || g.x > to) continue;
      ctx.fillRect(px(g.x) - 1.5, STRIP, 3, py(g.top) - STRIP);
    }

    // Coins and gems.
    ctx.fillStyle = palette.magenta;
    for (const p of l.pickups) {
      if (p.x < from || p.x > to) continue;
      const x = px(p.x);
      const y = py(p.y);
      ctx.beginPath();
      if (p.kind === 'gem') {
        const r = 8 * scale + 2;
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r * 0.7, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r * 0.7, y);
      } else ctx.arc(x, y, 5 * scale + 1, 0, Math.PI * 2);
      ctx.fill();
    }

    // Where a player in time with the music is: on the highest surface under the anchor.
    const left = xAtTime(l, time);
    let feet: number | null = null;
    for (const s of l.solids) {
      if (s.x1 <= left || s.x0 >= left + PLAYER_WIDTH || s.bottom !== undefined) continue;
      const top = solidTop(s, time);
      if (top !== null) feet = Math.max(feet ?? -Infinity, top);
    }
    ctx.shadowColor = palette.cyan;
    ctx.shadowBlur = 12;
    const bw = PLAYER_WIDTH * scale;
    const bh = PLAYER_HEIGHT * scale;
    if (feet !== null) {
      ctx.fillStyle = palette.cyan;
      ctx.fillRect(px(left), py(feet) - bh, bw, bh);
    } else {
      // Over a pit or a gone bridge: in the air, mid-jump.
      ctx.strokeStyle = palette.cyan;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px(left), py(80) - bh, bw, bh);
    }
    ctx.shadowBlur = 0;
  }

  return {
    element: root,
    draw,
    destroy() {
      destroyed = true;
      root.remove();
    },
  };
}

function drawSolid(
  ctx: CanvasRenderingContext2D,
  s: Solid,
  top: number | null,
  px: (x: number) => number,
  py: (y: number) => number,
  h: number,
): void {
  const x0 = px(s.x0);
  const width = px(s.x1) - x0;
  if (s.kind === 'bridge') {
    const y = py(s.top);
    if (top === null) {
      // Not there now: a faint outline where it will appear.
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = alpha(palette.cyan, 0.35);
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y + 0.5, width - 1, 5);
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = palette.cyan;
      ctx.shadowColor = palette.cyan;
      ctx.shadowBlur = 10;
      ctx.fillRect(x0, y, width, 6);
      ctx.shadowBlur = 0;
    }
    return;
  }
  if (top === null) return;
  if (s.bottom !== undefined) {
    // An overhang, hanging from the sky down to its underside.
    const y = py(s.bottom);
    ctx.fillStyle = alpha(palette.violet, 0.3);
    ctx.fillRect(x0, STRIP, width, y - STRIP);
    ctx.fillStyle = palette.violet;
    ctx.fillRect(x0, y - 2, width, 2);
    ctx.fillStyle = palette.orange;
    ctx.fillRect(x0, STRIP, 1.5, y - STRIP);
    return;
  }
  const y = py(top);
  if (s.kind === 'ledge') {
    ctx.fillStyle = palette.violet;
    ctx.fillRect(x0, y, width, 6);
    return;
  }
  const colour = s.kind === 'step' ? palette.magenta : palette.violet;
  ctx.fillStyle = alpha(colour, s.kind === 'eq' ? 0.4 : s.kind === 'step' ? 0.22 : 0.2);
  ctx.fillRect(x0, y, width, h - y);
  ctx.fillStyle = colour;
  ctx.shadowColor = colour;
  ctx.shadowBlur = 8;
  ctx.fillRect(x0, y, width, 2);
  ctx.shadowBlur = 0;
}
