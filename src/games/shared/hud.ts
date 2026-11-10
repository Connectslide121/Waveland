import { el } from './dom';
import { formatPerf, formatScore } from './format';
import './hud.css';

/**
 * The HUD every game shows over its canvas: the song and its tempo of the moment, the beat
 * dots, the score with the combo meter, the overdrive meter, the progress bar with the drops
 * marked, the count-in and the frame rate readout. Everything has a fixed place, so nothing
 * moves as it changes. A game adds its own slots after the overdrive meter (`status`) and
 * its own pieces to `element`.
 */

export interface HudOptions {
  title: string;
  tempo: number;
  duration: number;
  /** Song times of the drops, marked on the progress bar. */
  drops: number[];
  /** The difficulty's name, after the tempo. */
  difficulty?: string;
  /** Combo hits per multiplier step, and the top multiplier: the run's scoring. */
  comboStep: number;
  maxMultiplier: number;
  /** What fills the overdrive meter, in a few words ("Perfects and gems fill it"). */
  overdriveFills: string;
}

export interface HudState {
  time: number;
  /** The tempo at `time`, following the song's tempo map; the song's main tempo when left out. */
  tempo?: number;
  /** Which beat of the bar is playing, 0–3, or -1 before the first. */
  beatInBar: number;
  score: number;
  combo: number;
  multiplier: number;
  /** Beats left in the count-in, or null when not counting in. */
  countIn: number | null;
  /** Frames per second and CPU ms per frame, or null when the readout is off. */
  perf: { fps: number; cpuMs: number } | null;
  /** The overdrive meter, 0 to 1. */
  meter?: number;
  /** While overdrive runs, the share of it left, 0 to 1; null otherwise. */
  overdrive?: number | null;
  /** What overdrive is bound to, as a key chip shows it ("E"). */
  overdriveKey?: string;
}

export interface Hud<S extends HudState = HudState> {
  element: HTMLElement;
  /** The bottom-left row the overdrive meter starts, for a game's own slots after it. */
  status: HTMLElement;
  update(state: S): void;
}

export function createHud({
  title,
  tempo,
  duration,
  drops,
  difficulty,
  comboStep,
  maxMultiplier,
  overdriveFills,
}: HudOptions): Hud {
  const element = el('div', 'game-hud');
  const top = el('div', 'game-hud__top');

  const song = el('div', 'game-hud__song');
  const bpm = document.createTextNode(` · ${Math.round(tempo)} BPM`);
  song.append(el('b', undefined, title), bpm);
  if (difficulty) song.append(` · ${difficulty}`);

  const beats = el('div', 'game-hud__beats');
  beats.setAttribute('aria-hidden', 'true');
  const dots = Array.from({ length: 4 }, () => beats.appendChild(el('i')));

  const scoreBox = el('div', 'game-hud__score-box');
  const score = el('div', 'game-hud__score', formatScore(0));
  score.setAttribute('aria-label', 'Score');
  // The combo meter is always there, so the score never moves: the multiplier, the steps
  // to the next one, and the combo count.
  const combo = el('div', 'game-hud__combo none');
  combo.setAttribute('role', 'status');
  const mult = el('b', 'game-hud__mult', '×1');
  const steps = el('span', 'game-hud__steps');
  const ticks = Array.from({ length: comboStep }, () => steps.appendChild(el('i')));
  const comboCount = el('span', 'game-hud__combo-count', '0');
  combo.append(mult, steps, comboCount);
  scoreBox.append(score, combo);
  top.append(song, beats, scoreBox);

  // Overdrive, bottom left over the progress bar, with the game's own slots after it.
  const status = el('div', 'game-hud__status');
  const od = el('div', 'game-od');
  const odHead = el('div', 'game-od__head');
  const odState = el('span', 'game-od__state', overdriveFills);
  odHead.append(el('span', 'game-od__name', 'Overdrive'), odState);
  const odRow = el('div', 'game-od__row');
  const odBar = el('div', 'game-od__bar');
  odBar.setAttribute('role', 'meter');
  odBar.setAttribute('aria-label', 'Overdrive');
  odBar.setAttribute('aria-valuemin', '0');
  odBar.setAttribute('aria-valuemax', '100');
  odBar.setAttribute('aria-valuenow', '0');
  const odFill = el('div', 'game-od__fill');
  odBar.append(odFill);
  const odKey = el('kbd', 'game-od__key', '');
  odRow.append(odBar, odKey);
  od.append(odHead, odRow);
  status.append(od);

  const progress = el('div', 'game-hud__progress');
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', 'Song progress');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  const fill = el('div', 'game-hud__fill');
  progress.append(fill);
  for (const drop of drops) {
    const mark = el('i', 'game-hud__drop');
    mark.style.left = `${(100 * drop) / duration}%`;
    mark.title = 'Drop';
    progress.append(mark);
  }

  const count = el('div', 'game-hud__count');
  count.setAttribute('aria-live', 'polite');

  // Frame rate and frame time, bottom right over the progress bar, when Settings asks.
  const perf = el('div', 'game-hud__perf');
  perf.hidden = true;

  element.append(top, status, progress, count, perf);

  // What is on screen, so each frame only touches what changed.
  const shown = {
    beat: -2,
    score: -1,
    combo: -1,
    count: -2 as number | null,
    percent: -1,
    perf: '',
    tempo: Math.round(tempo),
    mult: 0,
    od: '',
  };
  return {
    element,
    status,
    update(state) {
      const now = Math.round(state.tempo ?? tempo);
      if (now !== shown.tempo) {
        bpm.textContent = ` · ${now} BPM`;
        shown.tempo = now;
      }
      if (state.beatInBar !== shown.beat)
        dots.forEach((dot, i) => dot.classList.toggle('on', i === state.beatInBar));
      if (state.score !== shown.score) score.textContent = formatScore(state.score);
      if (state.combo !== shown.combo || state.multiplier !== shown.mult) {
        mult.textContent = `×${state.multiplier}`;
        const maxed = state.multiplier >= maxMultiplier;
        const filled = maxed ? comboStep : state.combo % comboStep;
        ticks.forEach((tick, i) => tick.classList.toggle('on', i < filled));
        combo.classList.toggle('max', maxed);
        combo.classList.toggle('none', state.combo === 0);
        comboCount.textContent = String(state.combo);
        combo.setAttribute('aria-label', `Combo ${state.combo}, ×${state.multiplier}`);
        shown.mult = state.multiplier;
      }
      // Overdrive: filling, ready (with the key to press), or running down.
      const meter = state.meter ?? 0;
      const running = state.overdrive ?? null;
      const key = state.overdriveKey ?? '';
      const share = Math.round(100 * (running ?? meter));
      const ready = running === null && meter >= 1;
      const odText =
        running !== null ? 'Score ×2' : ready ? `Ready · press ${key}` : overdriveFills;
      const odShown = `${share}|${odText}|${key}`;
      if (odShown !== shown.od) {
        odFill.style.width = `${share}%`;
        odBar.setAttribute('aria-valuenow', String(share));
        odState.textContent = odText;
        odKey.textContent = key;
        od.classList.toggle('ready', ready);
        od.classList.toggle('on', running !== null);
        shown.od = odShown;
      }
      if (state.countIn !== shown.count) {
        count.textContent = state.countIn === null ? '' : String(state.countIn);
        count.classList.toggle('on', state.countIn !== null);
      }
      const percent = Math.round((1000 * Math.max(0, state.time)) / duration) / 10;
      if (percent !== shown.percent) {
        fill.style.width = `${Math.min(100, percent)}%`;
        progress.setAttribute('aria-valuenow', String(Math.round(percent)));
      }
      const perfText = state.perf ? formatPerf(state.perf.fps, state.perf.cpuMs) : '';
      if (perfText !== shown.perf) {
        perf.textContent = perfText;
        perf.hidden = perfText === '';
      }
      shown.beat = state.beatInBar;
      shown.score = state.score;
      shown.combo = state.combo;
      shown.count = state.countIn;
      shown.percent = percent;
      shown.perf = perfText;
    },
  };
}
