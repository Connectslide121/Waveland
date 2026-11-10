import {
  AudioClock,
  decodeSong,
  waveformOf,
  type AnalysedSong,
  type Band,
  type SectionKind,
  type Waveform,
} from '../core';
import { palette } from '../theme/palette';
import { alpha, CANVAS_FONT, sizedCanvas } from './canvas';
import { createLevelPreview, type LevelBuilder } from './level-preview';
import './song-details.css';

export interface SongDetailsOptions {
  song: AnalysedSong;
  /** Go back to the title screen. */
  onBack(): void;
  /** Decode the song for playback; the default decodes it with Web Audio. */
  decode?: (song: AnalysedSong) => Promise<AudioBuffer>;
  /** Build the platformer level preview; the default builds it in a worker. */
  buildLevel?: LevelBuilder;
}

export interface SongDetails {
  element: HTMLElement;
  destroy(): void;
}

/** Seconds the close-up shows, and where in it the playhead sits (share of its width). */
const WINDOW_SECONDS = 6;
const PLAYHEAD_AT = 0.3;
/** Width of the label column on the left of both timelines, so they line up. */
const GUTTER = 72;
/** How long a hit stays lit after the playhead passes it, in seconds. */
const FLASH_SECONDS = 0.12;
const SEEK_STEP = 5;
/** Seconds the overview's energy curves average over. */
const OVERVIEW_SMOOTHING = 0.5;

const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>`;
const PAUSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>`;
const SPINNER_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" class="spin"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="40 14" stroke-linecap="round"/></svg>`;

/** Section colours, from the palette's meanings: drops are magenta, the world violet. */
const SECTION_COLOURS: Record<SectionKind, string> = {
  intro: palette.muted,
  build: palette.violet,
  drop: palette.magenta,
  breakdown: palette.dusk,
  main: palette.line,
  outro: palette.muted,
};

/** The hit lanes: kick in the bass colour, snare in ink, hats in the muted ink. */
const LANES: { band: Band; label: string; colour: string }[] = [
  { band: 'low', label: 'Kick', colour: palette.violet },
  { band: 'mid', label: 'Snare', colour: palette.ink },
  { band: 'high', label: 'Hat', colour: palette.muted },
];

const FONT = CANVAS_FONT;

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

/** m:ss.s */
export function formatTime(seconds: number): string {
  // In whole tenths first, so 59.96 s reads 1:00.0, not 0:60.0.
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths - minutes * 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

/**
 * The song details view: what the analysis found, drawn on the song's timeline and played
 * back in sync, to check the beats, hits, sections and drops by ear and eye.
 */
export function createSongDetails({
  song,
  onBack,
  decode = decodeSong,
  buildLevel,
}: SongDetailsOptions): SongDetails {
  const { analysis } = song;
  let clock: AudioClock | null = null;
  let wave: Waveform | null = null;
  let loadFailed = false;
  let frame = 0;
  let destroyed = false;

  const root = el('main', 'details');
  root.setAttribute('aria-labelledby', 'details-song');

  // Top bar: the breadcrumb is the page's identity, and the way back.
  const bar = el('header', 'details__bar');
  const crumbs = el('nav', 'crumbs');
  crumbs.setAttribute('aria-label', 'Breadcrumb');
  const home = el('button', 'crumbs__link', 'Waveland');
  home.type = 'button';
  home.addEventListener('click', onBack);
  const current = el('span', 'crumbs__current', song.title);
  current.id = 'details-song';
  current.setAttribute('aria-current', 'page');
  current.title = song.file.name;
  crumbs.append(
    home,
    el('span', 'crumbs__sep', '›'),
    el('span', 'crumbs__page', 'Song details'),
    el('span', 'crumbs__sep', '›'),
    current,
  );
  const escape = el('span', 'details__key');
  escape.innerHTML = '<kbd>Esc</kbd> Back to the menu';
  bar.append(crumbs, escape);

  // What the analysis found, in fixed columns.
  const stats = el('dl', 'stats');
  const bars = analysis.downbeats.length;
  const stat = (label: string, value: string, unit = '') => {
    const cell = el('div', 'stats__cell');
    const dd = el('dd', 'stats__value', value);
    if (unit) dd.append(el('span', 'stats__unit', unit));
    cell.append(el('dt', 'stats__label', label), dd);
    stats.append(cell);
  };
  stat('Tempo', analysis.tempo.toFixed(1), 'BPM');
  stat('Length', formatTime(analysis.duration));
  stat('Beats', String(analysis.beats.length));
  stat('Bars', String(bars));
  stat('Sections', String(analysis.sections.length));
  stat('Drops', String(analysis.drops.length));

  // Transport: play/pause, the time, and why it can't play yet.
  const transport = el('div', 'transport');
  const play = el('button', 'transport__play');
  play.type = 'button';
  const playIcon = el('span', 'transport__icon');
  const playLabel = el('span', 'transport__label');
  play.append(playIcon, playLabel);
  const clockText = el('span', 'transport__time');
  clockText.setAttribute('aria-label', 'Song time');
  const status = el('span', 'transport__status');
  status.setAttribute('aria-live', 'polite');
  const keys = el('span', 'transport__keys');
  keys.innerHTML = '<kbd>Space</kbd> Play or pause <kbd>←</kbd><kbd>→</kbd> 5 s';
  transport.append(play, clockText, status, keys);

  // The whole song, and a close-up around the playhead.
  const overviewFigure = el('figure', 'timeline timeline--overview');
  const overview = el('canvas', 'timeline__canvas');
  overview.setAttribute('role', 'slider');
  overview.setAttribute('aria-label', 'Song position');
  overview.setAttribute('aria-valuemin', '0');
  overview.setAttribute('aria-valuemax', String(Math.round(analysis.duration)));
  overview.tabIndex = 0;
  overviewFigure.append(overview);

  const closeFigure = el('figure', 'timeline timeline--close');
  const close = el('canvas', 'timeline__canvas');
  close.setAttribute('aria-label', 'Close-up of the beats and hits around the playhead');
  const closeSpinner = el('span', 'timeline__spinner');
  closeSpinner.innerHTML = SPINNER_ICON;
  closeFigure.append(close, closeSpinner);

  const legend = el('ul', 'legend');
  legend.setAttribute('aria-label', 'Legend');
  const legendItem = (label: string, colour: string, shape: 'line' | 'dot' | 'block') => {
    const item = el('li', 'legend__item');
    const swatch = el('span', `legend__swatch legend__swatch--${shape}`);
    swatch.style.setProperty('--c', colour);
    item.append(swatch, el('span', '', label));
    legend.append(item);
  };
  legendItem('Playhead', palette.cyan, 'line');
  legendItem('Beat', alpha(palette.magenta, 0.45), 'line');
  legendItem('Bar start', palette.magenta, 'line');
  legendItem('Drop', palette.magenta, 'block');
  for (const lane of LANES) legendItem(lane.label, lane.colour, 'dot');
  legendItem('Bass energy', palette.violet, 'block');

  // The platformer level built from the song, following the playhead.
  const levelPreview = createLevelPreview({ analysis, build: buildLevel });

  const body = el('div', 'details__body');
  body.append(stats, transport, overviewFigure, closeFigure, legend, levelPreview.element);
  root.append(bar, body);

  // ---------- playback ----------

  const now = () => clock?.time ?? 0;

  const toggle = async () => {
    if (!clock) return;
    if (clock.playing) clock.pause();
    else await clock.play(clock.time >= clock.duration - 0.05 ? 0 : clock.time);
    renderTransport();
  };
  play.addEventListener('click', () => void toggle());

  const seek = async (to: number) => {
    if (!clock) return;
    await clock.seek(to);
    renderTransport();
  };

  decode(song).then(
    (buffer) => {
      if (destroyed) return;
      clock = new AudioClock(buffer);
      clock.onEnded = renderTransport;
      wave = waveformOf(buffer);
      renderTransport();
    },
    (error: unknown) => {
      if (destroyed) return;
      console.error(error);
      loadFailed = true;
      renderTransport();
    },
  );

  function renderTransport(): void {
    const ready = clock !== null;
    const playing = clock?.playing ?? false;
    play.disabled = !ready;
    play.setAttribute('aria-busy', String(!ready && !loadFailed));
    playIcon.innerHTML = !ready && !loadFailed ? SPINNER_ICON : playing ? PAUSE_ICON : PLAY_ICON;
    playLabel.textContent = playing ? 'Pause' : 'Play';
    closeSpinner.hidden = ready || loadFailed;
    status.classList.toggle('transport__status--error', loadFailed);
    status.textContent = loadFailed
      ? "This file couldn't be played"
      : ready
        ? ''
        : 'Loading the audio';
  }

  // Seek by clicking or dragging along the overview, or with the arrow keys on it.
  const seekFromPointer = (event: PointerEvent) => {
    const rect = overview.getBoundingClientRect();
    const x = event.clientX - rect.left - GUTTER;
    const width = rect.width - GUTTER;
    if (width <= 0) return;
    void seek((Math.max(0, Math.min(width, x)) / width) * analysis.duration);
  };
  overview.addEventListener('pointerdown', (event) => {
    if (event.clientX - overview.getBoundingClientRect().left < GUTTER) return;
    overview.setPointerCapture(event.pointerId);
    seekFromPointer(event);
  });
  overview.addEventListener('pointermove', (event) => {
    if (overview.hasPointerCapture(event.pointerId)) seekFromPointer(event);
  });
  // A click in the close-up jumps to that moment.
  close.addEventListener('click', (event) => {
    const rect = close.getBoundingClientRect();
    const width = rect.width - GUTTER;
    const x = event.clientX - rect.left - GUTTER;
    if (x < 0 || width <= 0) return;
    const start = now() - PLAYHEAD_AT * WINDOW_SECONDS;
    void seek(start + (x / width) * WINDOW_SECONDS);
  });

  const onKey = (event: KeyboardEvent) => {
    if (root.hidden || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === ' ') {
      event.preventDefault();
      void toggle();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      void seek(now() + (event.key === 'ArrowLeft' ? -SEEK_STEP : SEEK_STEP));
    }
  };
  document.addEventListener('keydown', onKey);

  // ---------- drawing ----------

  /** The overview without the playhead, redrawn only when its size changes. */
  let overviewLayer: HTMLCanvasElement | null = null;

  function drawOverviewLayer(w: number, h: number): HTMLCanvasElement {
    const ratio = window.devicePixelRatio || 1;
    const layer = document.createElement('canvas');
    layer.width = Math.round(w * ratio);
    layer.height = Math.round(h * ratio);
    const ctx = layer.getContext('2d')!;
    ctx.scale(ratio, ratio);
    const plotW = w - GUTTER;
    const x = (t: number) => GUTTER + (t / analysis.duration) * plotW;
    const strip = 24;
    const top = strip + 8;
    const bottom = h - 4;

    ctx.font = `600 10px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = palette.muted;
    ctx.fillText('SECTIONS', 0, strip / 2);
    ctx.fillText('ENERGY', 0, (top + bottom) / 2);

    // Sections: a block per section, labelled when it fits.
    for (const s of analysis.sections) {
      const x0 = x(s.start);
      const x1 = x(s.end);
      ctx.fillStyle = alpha(SECTION_COLOURS[s.kind], s.kind === 'main' ? 0.9 : 0.55);
      ctx.fillRect(x0 + 1, 0, Math.max(1, x1 - x0 - 2), strip);
      const label = s.kind.toUpperCase();
      if (ctx.measureText(label).width + 10 < x1 - x0) {
        ctx.fillStyle = palette.ink;
        ctx.fillText(label, x0 + 6, strip / 2);
      }
    }

    // Energy: bass as a violet area, overall loudness as an ink line.
    const curve = (values: Float32Array, step: number, fill: boolean, colour: string) => {
      ctx.beginPath();
      const columns = Math.max(1, Math.floor(plotW));
      for (let px = 0; px <= columns; px++) {
        const t = ((px + 0.5) / columns) * analysis.duration;
        // The mean over a short span around the column: the level, not every hit.
        const from = Math.max(0, Math.floor((t - OVERVIEW_SMOOTHING / 2) / step));
        const to = Math.min(values.length, Math.ceil((t + OVERVIEW_SMOOTHING / 2) / step));
        let v = 0;
        for (let i = from; i < to; i++) v += values[i]!;
        v /= Math.max(1, to - from);
        const y = bottom - v * (bottom - top);
        if (px === 0) ctx.moveTo(GUTTER + px, y);
        else ctx.lineTo(GUTTER + px, y);
      }
      if (fill) {
        ctx.lineTo(GUTTER + columns, bottom);
        ctx.lineTo(GUTTER, bottom);
        ctx.closePath();
        ctx.fillStyle = alpha(colour, 0.35);
        ctx.fill();
      } else {
        ctx.strokeStyle = alpha(colour, 0.75);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    };
    curve(analysis.bands.low.values, analysis.bands.low.step, true, palette.violet);
    curve(analysis.energy.values, analysis.energy.step, false, palette.ink);

    // Drops: a magenta line through everything, with a marker on top.
    for (const drop of analysis.drops) {
      const dx = x(drop.time);
      ctx.fillStyle = palette.magenta;
      ctx.shadowColor = palette.magenta;
      ctx.shadowBlur = 8;
      ctx.fillRect(dx - 1, 0, 2, h);
      ctx.beginPath();
      ctx.moveTo(dx - 6, strip + 1);
      ctx.lineTo(dx + 6, strip + 1);
      ctx.lineTo(dx, strip + 9);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    return layer;
  }

  function drawOverview(time: number): void {
    const sized = sizedCanvas(overview);
    if (!sized) return;
    const { ctx, w, h } = sized;
    if (
      !overviewLayer ||
      overviewLayer.width !== overview.width ||
      overviewLayer.height !== overview.height
    )
      overviewLayer = drawOverviewLayer(w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(overviewLayer, 0, 0, w, h);
    const px = GUTTER + (time / analysis.duration) * (w - GUTTER);
    ctx.fillStyle = palette.cyan;
    ctx.shadowColor = palette.cyan;
    ctx.shadowBlur = 10;
    ctx.fillRect(px - 1, 0, 2, h);
    ctx.shadowBlur = 0;
    overview.setAttribute('aria-valuenow', String(Math.round(time)));
    overview.setAttribute('aria-valuetext', formatTime(time));
  }

  function drawClose(time: number): void {
    const sized = sizedCanvas(close);
    if (!sized) return;
    const { ctx, w, h } = sized;
    ctx.clearRect(0, 0, w, h);
    const plotW = w - GUTTER;
    const start = time - PLAYHEAD_AT * WINDOW_SECONDS;
    const end = start + WINDOW_SECONDS;
    const x = (t: number) => GUTTER + ((t - start) / WINDOW_SECONDS) * plotW;
    const visible = (t: number) => t >= start - 0.1 && t <= end + 0.1;

    const ruler = 22;
    const laneH = 30;
    const lanesTop = h - LANES.length * laneH;
    const waveTop = ruler + 6;
    const waveBottom = lanesTop - 8;
    const waveMid = (waveTop + waveBottom) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, 0, plotW, h);
    ctx.clip();

    // Sections behind everything, as faint tints with their names in the ruler.
    ctx.font = `600 10px ${FONT}`;
    ctx.textBaseline = 'middle';
    for (const s of analysis.sections) {
      if (s.end < start || s.start > end) continue;
      ctx.fillStyle = alpha(SECTION_COLOURS[s.kind], 0.12);
      ctx.fillRect(x(s.start), ruler, x(s.end) - x(s.start), h - ruler);
      if (s.start >= start) {
        ctx.fillStyle = alpha(
          SECTION_COLOURS[s.kind] === palette.line ? palette.ink : SECTION_COLOURS[s.kind],
          0.9,
        );
        ctx.fillText(s.kind.toUpperCase(), x(s.start) + 6, ruler + 10);
      }
    }

    // The waveform.
    if (wave) {
      ctx.fillStyle = alpha(palette.ink, 0.5);
      for (let px = 0; px < plotW; px++) {
        const t0 = start + (px / plotW) * WINDOW_SECONDS;
        const t1 = start + ((px + 1) / plotW) * WINDOW_SECONDS;
        const from = Math.max(0, Math.floor(t0 / wave.step));
        const to = Math.min(wave.peaks.length, Math.max(from + 1, Math.ceil(t1 / wave.step)));
        let v = 0;
        for (let i = from; i < to; i++) v = Math.max(v, wave.peaks[i]!);
        const half = v * (waveBottom - waveTop) * 0.5;
        if (half > 0.2) ctx.fillRect(GUTTER + px, waveMid - half, 1, half * 2);
      }
    }

    // Beats, with the bar starts stronger and numbered.
    const downbeats = new Set(analysis.downbeats);
    for (const b of analysis.beats) {
      if (!visible(b)) continue;
      const down = downbeats.has(b);
      ctx.fillStyle = alpha(palette.magenta, down ? 0.9 : 0.4);
      ctx.fillRect(x(b) - (down ? 1 : 0.5), ruler, down ? 2 : 1, h - ruler);
    }
    ctx.fillStyle = palette.magenta;
    analysis.downbeats.forEach((d, i) => {
      if (visible(d)) ctx.fillText(String(i + 1), x(d) + 4, ruler / 2);
    });

    // Drops.
    for (const drop of analysis.drops) {
      if (!visible(drop.time)) continue;
      ctx.fillStyle = palette.magenta;
      ctx.shadowColor = palette.magenta;
      ctx.shadowBlur = 12;
      ctx.fillRect(x(drop.time) - 2, 0, 4, h);
      ctx.shadowBlur = 0;
      ctx.fillText('DROP', x(drop.time) + 6, ruler + 24);
    }

    // Hits per band: dots sized by strength, lit as the playhead passes.
    LANES.forEach((lane, row) => {
      const y = lanesTop + row * laneH + laneH / 2;
      ctx.fillStyle = alpha(palette.line, 0.6);
      ctx.fillRect(GUTTER, y, plotW, 1);
      for (const o of analysis.onsets[lane.band]) {
        if (!visible(o.time)) continue;
        const since = time - o.time;
        const lit = since >= 0 && since < FLASH_SECONDS;
        const r = 2.5 + 5 * o.strength + (lit ? 3 : 0);
        ctx.fillStyle = alpha(lane.colour, lit ? 1 : 0.35 + 0.5 * o.strength);
        ctx.shadowColor = lane.colour;
        ctx.shadowBlur = lit ? 14 : 0;
        ctx.beginPath();
        ctx.arc(x(o.time), y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    });

    // The playhead.
    const px = x(time);
    ctx.fillStyle = palette.cyan;
    ctx.shadowColor = palette.cyan;
    ctx.shadowBlur = 12;
    ctx.fillRect(px - 1, 0, 2, h);
    ctx.shadowBlur = 0;
    ctx.restore();

    // Lane labels in the gutter.
    ctx.font = `600 10px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = palette.muted;
    ctx.fillText('BAR', 0, ruler / 2);
    ctx.fillText('WAVE', 0, waveMid);
    LANES.forEach((lane, row) => {
      ctx.fillStyle = lane.colour;
      ctx.fillText(lane.label.toUpperCase(), 0, lanesTop + row * laneH + laneH / 2);
    });
  }

  const tick = () => {
    if (destroyed) return;
    const time = now();
    if (!root.hidden && root.isConnected) {
      clockText.textContent = `${formatTime(time)} / ${formatTime(analysis.duration)}`;
      drawOverview(time);
      drawClose(time);
      levelPreview.draw(time);
    }
    frame = requestAnimationFrame(tick);
  };

  renderTransport();
  clockText.textContent = `${formatTime(0)} / ${formatTime(analysis.duration)}`;
  frame = requestAnimationFrame(tick);

  return {
    element: root,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
      clock?.stop();
      levelPreview.destroy();
      root.remove();
    },
  };
}
