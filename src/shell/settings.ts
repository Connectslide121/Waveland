import {
  getAudioContext,
  getEffects,
  getEffectsLowered,
  getLatencyMs,
  getMusicVolume,
  getShowFps,
  hasChosenEffects,
  onSettingsChange,
  MAX_LATENCY_MS,
  prefersReducedMotion,
  setEffects,
  setLatencyMs,
  setMusicVolume,
  setShowFps,
  type EffectsLevel,
} from '../core';
import { games } from '../games';
import { COUNT_IN_CLICKS, latencyFromTaps, Metronome, MIN_TAPS, TAP_CLICKS } from './calibration';
import { createControlsSection } from './controls-settings';
import './settings.css';

/**
 * The Settings modal, opened from the title screen and from a game's pause menu: music
 * volume, effects intensity, the frame rate readout, audio latency with a metronome to
 * tap along to, and the controls (`controls-settings.ts`). Changes
 * apply at once. It takes the keys while open (Escape and × close it, a backdrop click
 * doesn't) and gives focus back to whatever opened it.
 */

export interface SettingsModal {
  element: HTMLElement;
  close(): void;
}

const CLOSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
/** One step of the latency − and + buttons, ms. */
const LATENCY_STEP = 5;

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

/** A latency offset as the player reads it: +40 ms, −15 ms, 0 ms. */
export function formatLatency(ms: number): string {
  if (ms === 0) return '0 ms';
  return `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms`;
}

/**
 * Open the Settings modal; `onClose` runs once it has closed. The controls show the
 * actions of `game` (an id: the game being played or picked), the first game's otherwise.
 */
export function openSettings({
  onClose,
  game,
}: { onClose?: () => void; game?: string } = {}): SettingsModal {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const element = el('div', 'settings');
  const panel = el('div', 'settings__panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'settings-title');
  const head = el('div', 'settings__head');
  const title = el('h2', 'settings__title', 'Settings');
  title.id = 'settings-title';
  const closeButton = el('button', 'settings__close');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close settings');
  closeButton.innerHTML = CLOSE_ICON;
  head.append(title, closeButton);

  // Music volume.
  const volumeRow = el('div', 'settings__row');
  const volumeLabel = el('label', 'settings__label', 'Music volume');
  volumeLabel.htmlFor = 'settings-volume';
  const volume = el('input', 'settings__range');
  volume.type = 'range';
  volume.id = 'settings-volume';
  volume.min = '0';
  volume.max = '100';
  volume.step = '5';
  const volumeValue = el('output', 'settings__value');
  volumeValue.htmlFor.add(volume.id);
  volumeRow.append(volumeLabel, volume, volumeValue);
  volume.addEventListener('input', () => setMusicVolume(Number(volume.value) / 100));

  // Effects intensity.
  const effectsRow = el('div', 'settings__row settings__row--wide');
  const effectsLabel = el('span', 'settings__label', 'Effects');
  effectsLabel.id = 'settings-effects';
  const effects = el('div', 'settings__segments');
  effects.setAttribute('role', 'radiogroup');
  effects.setAttribute('aria-labelledby', effectsLabel.id);
  const effectInputs = (['full', 'reduced'] as EffectsLevel[]).map((level) => {
    const option = el('label', 'settings__segment');
    const input = el('input', 'visually-hidden');
    input.type = 'radio';
    input.name = 'settings-effects';
    input.value = level;
    option.append(input, el('span', undefined, level === 'full' ? 'Full' : 'Reduced'));
    effects.append(option);
    input.addEventListener('change', () => setEffects(level));
    return input;
  });
  const effectsNote = el('p', 'settings__note');
  // Only while a game has lowered them, which can't change while Settings is open: the
  // game is paused or not running.
  const loweredNote = el('p', 'settings__note settings__note--lowered');
  effectsRow.append(effectsLabel, effects, effectsNote, loweredNote);

  // Frame rate readout in the HUD.
  const fpsRow = el('div', 'settings__row settings__row--wide');
  const fpsLabel = el('span', 'settings__label', 'Frame rate');
  fpsLabel.id = 'settings-fps';
  const fps = el('div', 'settings__segments');
  fps.setAttribute('role', 'radiogroup');
  fps.setAttribute('aria-labelledby', fpsLabel.id);
  const fpsInputs = (['off', 'on'] as const).map((value) => {
    const option = el('label', 'settings__segment');
    const input = el('input', 'visually-hidden');
    input.type = 'radio';
    input.name = 'settings-fps';
    input.value = value;
    option.append(input, el('span', undefined, value === 'on' ? 'Show' : 'Hide'));
    fps.append(option);
    input.addEventListener('change', () => setShowFps(value === 'on'));
    return input;
  });
  const fpsNote = el(
    'p',
    'settings__note',
    'Frames per second and the time each frame takes, in a corner of the game.',
  );
  fpsRow.append(fpsLabel, fps, fpsNote);

  // Audio latency: the offset, and a metronome to tap along to.
  const latencyRow = el('div', 'settings__row settings__row--wide');
  const latencyLabel = el('span', 'settings__label', 'Audio latency');
  const stepper = el('div', 'settings__stepper');
  const minus = el('button', 'settings__step', '−');
  minus.type = 'button';
  minus.setAttribute('aria-label', `${LATENCY_STEP} ms earlier`);
  const latencyValue = el('output', 'settings__latency');
  latencyValue.setAttribute('aria-live', 'polite');
  const plus = el('button', 'settings__step', '+');
  plus.type = 'button';
  plus.setAttribute('aria-label', `${LATENCY_STEP} ms later`);
  stepper.append(minus, latencyValue, plus);
  const nudge = (by: number) => setLatencyMs(getLatencyMs() + by);
  minus.addEventListener('click', () => nudge(-LATENCY_STEP));
  plus.addEventListener('click', () => nudge(LATENCY_STEP));

  const calibrator = el('div', 'settings__calibrate');
  const light = el('span', 'settings__light');
  light.setAttribute('aria-hidden', 'true');
  const calText = el('p', 'settings__cal-text');
  calText.setAttribute('aria-live', 'polite');
  const calButton = el('button', 'settings__cal-button');
  calButton.type = 'button';
  calibrator.append(light, calText, calButton);
  latencyRow.append(latencyLabel, stepper, calibrator);

  // Controls: what each game's actions are bound to.
  const controls = createControlsSection({ games: games.all(), game });

  const done = el('button', 'settings__done', 'Done');
  done.type = 'button';

  panel.append(head, volumeRow, effectsRow, fpsRow, latencyRow, controls.element, done);
  element.append(panel);
  document.body.append(element);

  // Calibration: idle, listening to the count-in, tapping, or showing what it found.
  let metronome: Metronome | null = null;
  let taps: number[] = [];
  let frame = 0;
  let message = 'Tap along to a metronome to line the music up with the game.';
  let tone: 'plain' | 'good' | 'bad' = 'plain';

  const stopMetronome = () => {
    metronome?.stop();
    metronome = null;
    cancelAnimationFrame(frame);
    light.classList.remove('on');
  };

  const finish = () => {
    const clicks = metronome?.tapClicks ?? [];
    stopMetronome();
    const result = latencyFromTaps(taps, clicks);
    if (result.ok) {
      setLatencyMs(result.latencyMs);
      message = `Set to ${formatLatency(result.latencyMs)} from ${result.taps} taps.`;
      tone = 'good';
    } else {
      message =
        result.reason === 'too-few'
          ? `Only ${result.taps} taps matched a click; at least ${MIN_TAPS} are needed. Try again.`
          : 'The taps were too uneven to use. Try again, tapping right on each click.';
      tone = 'bad';
    }
    render();
  };

  const tick = () => {
    if (!metronome) return;
    const heard = metronome.heardTime();
    if (heard > metronome.end) {
      finish();
      return;
    }
    // The light flashes for a moment on every click, as it is heard.
    const lit = metronome.clicks.some((c) => heard >= c && heard - c < 0.1);
    light.classList.toggle('on', lit);
    const counting = heard < metronome.clicks[COUNT_IN_CLICKS]! - 0.3;
    const text = counting
      ? 'Listen to the first four clicks…'
      : `Tap on every click: ${taps.length} / ${TAP_CLICKS}`;
    if (calText.textContent !== text) calText.textContent = text;
    frame = requestAnimationFrame(tick);
  };

  const startCalibration = async () => {
    stopMetronome();
    taps = [];
    tone = 'plain';
    const m = new Metronome(getAudioContext());
    metronome = m;
    render();
    try {
      await m.start();
    } catch {
      if (metronome === m) stopMetronome();
      message = "The metronome couldn't play. Check the sound output and try again.";
      tone = 'bad';
      render();
      return;
    }
    calButton.focus();
    frame = requestAnimationFrame(tick);
  };

  const tap = (event: Event) => {
    if (!metronome) return;
    const age = Math.max(0, (performance.now() - event.timeStamp) / 1000);
    const heard = metronome.heardTime(age);
    // Taps during the count-in don't count.
    if (heard < metronome.clicks[COUNT_IN_CLICKS]! - 0.3) return;
    taps.push(heard);
  };

  calButton.addEventListener('pointerdown', (event) => {
    if (metronome) {
      event.preventDefault();
      tap(event);
    }
  });
  calButton.addEventListener('click', () => {
    // A pointer tap was taken on pointerdown; a click from the keyboard is handled in keys.
    if (!metronome) void startCalibration();
  });

  function render(): void {
    const level = getEffects();
    effectInputs.forEach((input) => (input.checked = input.value === level));
    effectsNote.textContent = hasChosenEffects()
      ? level === 'reduced'
        ? 'No flashes and no screen shake.'
        : 'Every effect, flashes and screen shake included.'
      : `Following your system: reduced motion is ${prefersReducedMotion() ? 'on' : 'off'}.`;
    const lowered = getEffectsLowered();
    loweredNote.textContent = 'Lowered automatically to keep the game smooth.';
    loweredNote.hidden = !lowered;
    const showFps = getShowFps();
    fpsInputs.forEach((input) => (input.checked = (input.value === 'on') === showFps));

    volume.value = String(Math.round(getMusicVolume() * 100));
    volumeValue.textContent = `${volume.value}%`;

    const latency = getLatencyMs();
    latencyValue.textContent = formatLatency(latency);
    minus.disabled = latency <= -MAX_LATENCY_MS;
    plus.disabled = latency >= MAX_LATENCY_MS;

    controls.render();

    calibrator.dataset.state = metronome ? 'running' : tone;
    calButton.textContent = metronome ? 'Tap' : 'Calibrate';
    calButton.setAttribute(
      'aria-label',
      metronome ? 'Tap on the click (or press Space)' : 'Calibrate with a metronome',
    );
    if (!metronome) calText.textContent = message;
  }

  const focusables = () =>
    [...panel.querySelectorAll<HTMLElement>('button, input')].filter(
      (node) =>
        !(node as HTMLButtonElement).disabled &&
        (node.getAttribute('type') !== 'radio' || (node as HTMLInputElement).checked),
    );

  const keys = (event: KeyboardEvent) => {
    // The modal takes every key while open, so the game or menu below doesn't see them.
    event.stopImmediatePropagation();
    // A control slot waiting for a key takes it first (Escape cancels the wait, not Settings).
    if (controls.handleKey(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (metronome && (event.code === 'Space' || event.code === 'Enter')) {
      event.preventDefault();
      if (!event.repeat) tap(event);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const list = focusables();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = (at + (event.shiftKey ? -1 : 1) + list.length) % list.length;
      list[at < 0 ? 0 : next]?.focus();
    }
  };
  window.addEventListener('keydown', keys, true);
  const stopListening = onSettingsChangeWhileOpen(render);

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    stopMetronome();
    controls.stop();
    stopListening();
    window.removeEventListener('keydown', keys, true);
    element.remove();
    opener?.focus();
    onClose?.();
  }
  closeButton.addEventListener('click', close);
  done.addEventListener('click', close);

  render();
  closeButton.focus();
  return { element, close };
}

/** Re-render on changes from elsewhere too (the system's reduced-motion switch). */
function onSettingsChangeWhileOpen(render: () => void): () => void {
  const media =
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  media?.addEventListener?.('change', render);
  const stop = onSettingsChange(render);
  return () => {
    media?.removeEventListener?.('change', render);
    stop();
  };
}
