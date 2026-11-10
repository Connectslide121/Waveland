import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindingKey,
  bindInput,
  BINDING_SLOTS,
  CONTROL_ACTIONS,
  CONTROL_DEVICES,
  DEFAULT_BINDINGS,
  getBindings,
  keyLabel,
  mouseLabel,
  padLabel,
  resetBindings,
  rivalActions,
  setBindings,
  shortBinding,
  getDifficulty,
  getEffects,
  getLatencyMs,
  setDifficulty,
  getMusicVolume,
  hasChosenEffects,
  MAX_LATENCY_MS,
  onSettingsChange,
  setEffects,
  setLatencyMs,
  setMusicVolume,
} from './settings';

function reducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({ matches: reduce && query.includes('reduce') }) as MediaQueryList,
  );
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('settings', () => {
  it('keeps the latency offset in whole ms within the limits', () => {
    expect(getLatencyMs()).toBe(0);
    setLatencyMs(42.4);
    expect(getLatencyMs()).toBe(42);
    setLatencyMs(10_000);
    expect(getLatencyMs()).toBe(MAX_LATENCY_MS);
  });

  it('plays music at full volume until changed, and keeps it between 0 and 1', () => {
    expect(getMusicVolume()).toBe(1);
    setMusicVolume(0.456);
    expect(getMusicVolume()).toBe(0.46);
    setMusicVolume(-1);
    expect(getMusicVolume()).toBe(0);
  });

  it('follows the system for effects until the player picks a level', () => {
    reducedMotion(true);
    expect(getEffects()).toBe('reduced');
    expect(hasChosenEffects()).toBe(false);
    setEffects('full');
    expect(getEffects()).toBe('full');
    expect(hasChosenEffects()).toBe(true);
    setEffects(null);
    expect(getEffects()).toBe('reduced');
    reducedMotion(false);
    expect(getEffects()).toBe('full');
  });

  it('keeps the picked difficulty, normal until one is picked', () => {
    expect(getDifficulty()).toBe('normal');
    setDifficulty('hard');
    expect(getDifficulty()).toBe('hard');
    localStorage.setItem('waveland.difficulty', 'brutal');
    expect(getDifficulty()).toBe('normal');
  });

  it('tells listeners about every change until they stop listening', () => {
    const listener = vi.fn();
    const stop = onSettingsChange(listener);
    setMusicVolume(0.5);
    setEffects('reduced');
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    setLatencyMs(10);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('control bindings', () => {
  it('starts from the defaults: right click dashes, left click slams', () => {
    const b = getBindings();
    expect(b).toEqual(DEFAULT_BINDINGS);
    expect(b.jump.keys).toEqual(['Space', 'KeyW', 'ArrowUp']);
    expect(b.dash.keys).toEqual(['Shift', 'KeyJ', 'KeyX']);
    expect(b.dash.mouse).toEqual(['right', null]);
    expect(b.slam.keys).toEqual(['KeyS', 'ArrowDown', null]);
    expect(b.slam.mouse).toEqual(['left', null]);
    expect(b.jump.pad).toEqual([0, null]);
    expect(b.dash.pad).toEqual([2, 5]);
    expect(b.slam.pad).toEqual([1, 13]);
    // Overdrive: E or L, gamepad Y, no mouse button.
    expect(b.overdrive).toEqual({
      keys: ['KeyE', 'KeyL', null],
      mouse: [null, null],
      pad: [3, null],
    });
    // Left and right: ← or A, → or D, the d-pad; no mouse button.
    expect(b.left).toEqual({
      keys: ['ArrowLeft', 'KeyA', null],
      mouse: [null, null],
      pad: [14, null],
    });
    expect(b.right).toEqual({
      keys: ['ArrowRight', 'KeyD', null],
      mouse: [null, null],
      pad: [15, null],
    });
    // Each slot count per device.
    for (const action of CONTROL_ACTIONS)
      for (const device of CONTROL_DEVICES)
        expect(b[action][device]).toHaveLength(BINDING_SLOTS[device]);
  });

  it('gives overdrive its defaults in bindings saved before it, less what another action took', () => {
    const saved = {
      jump: { ...DEFAULT_BINDINGS.jump, keys: ['Space', 'KeyE', null] },
      dash: DEFAULT_BINDINGS.dash,
      slam: DEFAULT_BINDINGS.slam,
    };
    localStorage.setItem('waveland.controls', JSON.stringify(saved));
    const b = getBindings();
    expect(b.jump.keys).toEqual(['Space', 'KeyE', null]);
    expect(b.overdrive.keys).toEqual([null, 'KeyL', null]);
    expect(b.overdrive.pad).toEqual([3, null]);
  });

  it('loads bindings saved before left and right, giving them their defaults', () => {
    const saved = {
      jump: DEFAULT_BINDINGS.jump,
      dash: { ...DEFAULT_BINDINGS.dash, keys: ['KeyA', 'KeyJ', 'KeyX'] },
      slam: DEFAULT_BINDINGS.slam,
      overdrive: DEFAULT_BINDINGS.overdrive,
    };
    localStorage.setItem('waveland.controls', JSON.stringify(saved));
    const b = getBindings();
    expect(b.dash.keys).toEqual(['KeyA', 'KeyJ', 'KeyX']);
    expect(b.jump).toEqual(DEFAULT_BINDINGS.jump);
    // A was the player's dash already: left keeps only ←.
    expect(b.left.keys).toEqual(['ArrowLeft', null, null]);
    expect(b.right).toEqual(DEFAULT_BINDINGS.right);
  });

  it('only moves an input between actions some game uses together', () => {
    const games = [
      ['jump', 'dash', 'slam', 'overdrive'],
      ['left', 'right', 'jump', 'overdrive'],
    ] as const;
    expect(rivalActions('left', games)).toEqual(['jump', 'overdrive', 'left', 'right']);
    expect(rivalActions('jump', games)).toEqual(CONTROL_ACTIONS);
    expect(rivalActions('slam')).toEqual(CONTROL_ACTIONS);
    // S on left stays on slam: no game has both.
    const left = rivalActions('left', games);
    const shared = bindInput(getBindings(), 'left', 'keys', 2, 'KeyS', left);
    expect(shared).toMatchObject({ ok: true, movedFrom: null });
    if (!shared.ok) return;
    expect(shared.bindings.left.keys).toEqual(['ArrowLeft', 'KeyA', 'KeyS']);
    expect(shared.bindings.slam.keys).toEqual(['KeyS', 'ArrowDown', null]);
    // S on jump moves from both: jump is in both games.
    const jump = rivalActions('jump', games);
    const moved = bindInput(shared.bindings, 'jump', 'keys', 2, 'KeyS', jump);
    if (!moved.ok) throw new Error('not bound');
    expect(moved.bindings.slam.keys).toEqual([null, 'ArrowDown', null]);
    expect(moved.bindings.left.keys).toEqual(['ArrowLeft', 'KeyA', null]);
  });

  it('moves an input bound to another action, and says which', () => {
    const result = bindInput(getBindings(), 'slam', 'keys', 2, 'Shift');
    expect(result).toMatchObject({ ok: true, movedFrom: 'dash' });
    if (!result.ok) return;
    expect(result.bindings.slam.keys).toEqual(['KeyS', 'ArrowDown', 'Shift']);
    expect(result.bindings.dash.keys).toEqual([null, 'KeyJ', 'KeyX']);
    // Within one action it moves to the new slot.
    const moved = bindInput(result.bindings, 'slam', 'keys', 0, 'ArrowDown');
    expect(moved).toMatchObject({ ok: true, movedFrom: null });
    if (moved.ok) expect(moved.bindings.slam.keys).toEqual(['ArrowDown', null, 'Shift']);
  });

  it('never binds the pause inputs', () => {
    expect(bindInput(getBindings(), 'jump', 'keys', 0, 'Escape')).toEqual({
      ok: false,
      reason: 'pause',
    });
    expect(bindInput(getBindings(), 'jump', 'pad', 1, 9)).toEqual({ ok: false, reason: 'pause' });
  });

  it('keeps the bindings, and resets one action or all', () => {
    const result = bindInput(getBindings(), 'jump', 'mouse', 0, 'right');
    if (!result.ok) throw new Error('not bound');
    setBindings(result.bindings);
    expect(getBindings().jump.mouse).toEqual(['right', null]);
    expect(getBindings().dash.mouse).toEqual([null, null]);
    // Dash's defaults come back, taking right click from jump again.
    resetBindings('dash');
    expect(getBindings().dash).toEqual(DEFAULT_BINDINGS.dash);
    expect(getBindings().jump.mouse).toEqual([null, null]);
    setBindings(result.bindings);
    resetBindings();
    expect(getBindings()).toEqual(DEFAULT_BINDINGS);
  });

  it('falls back to the defaults for what it can’t read', () => {
    localStorage.setItem(
      'waveland.controls',
      JSON.stringify({ jump: { keys: ['KeyK', 42, 'Escape'] }, dash: 'nonsense' }),
    );
    const b = getBindings();
    expect(b.jump.keys).toEqual(['KeyK', null, null]);
    expect(b.jump.mouse).toEqual(DEFAULT_BINDINGS.jump.mouse);
    expect(b.dash).toEqual(DEFAULT_BINDINGS.dash);
    localStorage.setItem('waveland.controls', '{broken');
    expect(getBindings()).toEqual(DEFAULT_BINDINGS);
  });

  it('names the inputs as the player reads them', () => {
    expect(bindingKey('ShiftRight')).toBe('Shift');
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('ArrowDown')).toBe('↓');
    expect(keyLabel('Digit3')).toBe('3');
    expect(mouseLabel('right')).toBe('Right click');
    expect(padLabel(5)).toBe('RB');
    expect(shortBinding(DEFAULT_BINDINGS.dash)).toBe('Right click / Shift');
    expect(shortBinding(DEFAULT_BINDINGS.slam)).toBe('Left click / S');
    expect(shortBinding(DEFAULT_BINDINGS.jump)).toBe('Space');
  });
});
