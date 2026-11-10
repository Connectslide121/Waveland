import { afterEach, describe, expect, it } from 'vitest';
import { GameControls } from './controls';

const key = (type: 'keydown' | 'keyup', code: string, repeat = false) =>
  window.dispatchEvent(new KeyboardEvent(type, { code, repeat, cancelable: true }));

function pad(buttons: number[], x = 0): Gamepad {
  return {
    connected: true,
    axes: [x, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({
      pressed: buttons.includes(i),
      touched: false,
      value: 0,
    })),
  } as unknown as Gamepad;
}

const TUNNEL = ['left', 'right', 'jump', 'overdrive'] as const;

afterEach(() => {
  localStorage.clear();
});

describe('GameControls', () => {
  it('reads only the game’s actions, each press once and held until let go', () => {
    const controls = new GameControls(TUNNEL, window, () => []);
    key('keydown', 'ArrowLeft');
    let frame = controls.read();
    expect(frame.pressed).toEqual({ left: true, right: false, jump: false, overdrive: false });
    expect(frame.held.left).toBe(true);
    key('keydown', 'ArrowLeft', true);
    frame = controls.read();
    expect(frame.pressed.left).toBe(false);
    expect(frame.held.left).toBe(true);
    key('keyup', 'ArrowLeft');
    expect(controls.read().held.left).toBe(false);
    // S slams in the platformer: nothing here.
    key('keydown', 'KeyS');
    expect(Object.values(controls.read().pressed)).not.toContain(true);
    key('keyup', 'KeyS');
    controls.destroy();
  });

  it('steers with the d-pad and the left stick', () => {
    let pads = [pad([14])];
    const controls = new GameControls(TUNNEL, window, () => pads);
    expect(controls.read().pressed.left).toBe(true);
    expect(controls.read()).toMatchObject({ pressed: { left: false }, held: { left: true } });
    pads = [pad([], 0.9)];
    expect(controls.read()).toMatchObject({ pressed: { right: true, left: false } });
    pads = [pad([], 0.2)];
    expect(controls.read().held.right).toBe(false);
    controls.destroy();
  });

  it('drops presses while disabled and still sees pause', () => {
    const controls = new GameControls(TUNNEL, window, () => []);
    controls.enabled = false;
    key('keydown', 'ArrowRight');
    expect(controls.read().pressed.right).toBe(false);
    key('keyup', 'ArrowRight');
    controls.enabled = true;
    key('keydown', 'Escape');
    expect(controls.read().pausePressed).toBe(true);
    controls.destroy();
  });
});
