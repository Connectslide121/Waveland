import { describe, expect, it } from 'vitest';
import { Controls } from './controls';

const key = (type: 'keydown' | 'keyup', code: string, repeat = false) =>
  window.dispatchEvent(new KeyboardEvent(type, { code, repeat, cancelable: true }));

function pad(buttons: number[], x = 0): Gamepad {
  return {
    connected: true,
    axes: [x, 0],
    buttons: Array.from({ length: 16 }, (_, i) => ({
      pressed: buttons.includes(i),
      touched: false,
      value: 0,
    })),
  } as unknown as Gamepad;
}

describe('Controls', () => {
  it('runs and jumps from the keyboard, counting a jump press once', () => {
    const controls = new Controls(window, () => []);
    key('keydown', 'ArrowRight');
    key('keydown', 'Space');
    expect(controls.read()).toEqual({
      dir: 1,
      jumpHeld: true,
      jumpPressed: true,
      pausePressed: false,
    });
    key('keydown', 'Space', true);
    expect(controls.read()).toMatchObject({ jumpHeld: true, jumpPressed: false });
    key('keydown', 'KeyA');
    expect(controls.read().dir).toBe(0);
    key('keyup', 'ArrowRight');
    key('keyup', 'Space');
    expect(controls.read()).toMatchObject({ dir: -1, jumpHeld: false });
    key('keyup', 'KeyA');
    controls.destroy();
  });

  it('pauses on Escape, and drops presses while a menu has the keys', () => {
    const controls = new Controls(window, () => []);
    key('keydown', 'Escape');
    expect(controls.read().pausePressed).toBe(true);
    controls.enabled = false;
    key('keydown', 'KeyW');
    expect(controls.read()).toMatchObject({ jumpPressed: false, jumpHeld: false });
    controls.enabled = true;
    expect(controls.read().jumpPressed).toBe(false);
    controls.destroy();
  });

  it('reads a gamepad: stick to run, A to jump, Start to pause', () => {
    let pads = [pad([], 0.9)];
    const controls = new Controls(window, () => pads);
    expect(controls.read().dir).toBe(1);
    pads = [pad([0, 9], -0.1)];
    expect(controls.read()).toEqual({
      dir: 0,
      jumpHeld: true,
      jumpPressed: true,
      pausePressed: true,
    });
    // Held, not pressed again.
    expect(controls.read()).toMatchObject({ jumpPressed: false, pausePressed: false });
    pads = [pad([14])];
    expect(controls.read().dir).toBe(-1);
    controls.destroy();
  });
});
