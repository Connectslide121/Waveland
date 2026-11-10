import { afterEach, describe, expect, it } from 'vitest';
import { bindInput, getBindings, setBindings } from '../../core';
import { Controls } from './controls';

const key = (type: 'keydown' | 'keyup', code: string, repeat = false) =>
  window.dispatchEvent(new KeyboardEvent(type, { code, repeat, cancelable: true }));

/** A mouse button going down on `target` (bubbling to the surface) and up on the window. */
const mouse = (target: EventTarget, type: 'mousedown' | 'mouseup', button: number) =>
  target.dispatchEvent(new MouseEvent(type, { button, bubbles: true, cancelable: true }));

function pad(buttons: number[], y = 0): Gamepad {
  return {
    connected: true,
    axes: [0, y],
    buttons: Array.from({ length: 17 }, (_, i) => ({
      pressed: buttons.includes(i),
      touched: false,
      value: 0,
    })),
  } as unknown as Gamepad;
}

const IDLE = {
  jumpHeld: false,
  jumpPressed: false,
  dashPressed: false,
  slamPressed: false,
  overdrivePressed: false,
  pausePressed: false,
};

afterEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

describe('Controls', () => {
  it('jumps, dashes and slams from the keyboard, counting each press once', () => {
    const controls = new Controls(window, () => []);
    key('keydown', 'Space');
    key('keydown', 'ShiftLeft');
    expect(controls.read()).toEqual({
      ...IDLE,
      jumpHeld: true,
      jumpPressed: true,
      dashPressed: true,
    });
    key('keydown', 'Space', true);
    expect(controls.read()).toEqual({ ...IDLE, jumpHeld: true });
    key('keyup', 'Space');
    key('keyup', 'ShiftLeft');
    for (const code of ['KeyW', 'ArrowUp']) {
      key('keydown', code);
      expect(controls.read()).toMatchObject({ jumpPressed: true });
      key('keyup', code);
    }
    for (const code of ['KeyJ', 'KeyX', 'ShiftRight']) {
      key('keydown', code);
      expect(controls.read()).toMatchObject({ dashPressed: true });
      key('keyup', code);
    }
    for (const code of ['KeyS', 'ArrowDown']) {
      key('keydown', code);
      expect(controls.read()).toMatchObject({ slamPressed: true });
      key('keyup', code);
    }
    for (const code of ['KeyE', 'KeyL']) {
      key('keydown', code);
      expect(controls.read()).toEqual({ ...IDLE, overdrivePressed: true });
      key('keyup', code);
    }
    // Left and right do nothing any more.
    key('keydown', 'ArrowRight');
    key('keydown', 'KeyA');
    expect(controls.read()).toEqual(IDLE);
    key('keyup', 'ArrowRight');
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
    key('keyup', 'KeyW');
    controls.destroy();
  });

  it('dashes on right click and slams on left click, both at once too', () => {
    const surface = document.body.appendChild(document.createElement('div'));
    const canvas = surface.appendChild(document.createElement('canvas'));
    const controls = new Controls(window, () => [], surface);
    mouse(canvas, 'mousedown', 2);
    expect(controls.read()).toEqual({ ...IDLE, dashPressed: true });
    mouse(canvas, 'mousedown', 0);
    expect(controls.read()).toEqual({ ...IDLE, slamPressed: true });
    mouse(window, 'mouseup', 0);
    mouse(window, 'mouseup', 2);
    // Both buttons in one frame do both.
    mouse(canvas, 'mousedown', 0);
    mouse(canvas, 'mousedown', 2);
    expect(controls.read()).toEqual({ ...IDLE, dashPressed: true, slamPressed: true });
    // The browser's menu stays shut on the game.
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    controls.destroy();
  });

  it('ignores clicks on the menus’ buttons', () => {
    const surface = document.body.appendChild(document.createElement('div'));
    const modal = surface.appendChild(document.createElement('div'));
    modal.className = 'pf-modal';
    const button = modal.appendChild(document.createElement('button'));
    const hudButton = surface.appendChild(document.createElement('button'));
    const controls = new Controls(window, () => [], surface);
    mouse(button, 'mousedown', 0);
    mouse(hudButton, 'mousedown', 2);
    expect(controls.read()).toEqual(IDLE);
    controls.destroy();
  });

  it('follows the bindings from Settings, mouse buttons on jump held like keys', () => {
    const surface = document.body.appendChild(document.createElement('div'));
    const controls = new Controls(window, () => [], surface);
    // Middle click to jump; Shift moved from dash to slam.
    let result = bindInput(getBindings(), 'jump', 'mouse', 0, 'middle');
    if (!result.ok) throw new Error('not bound');
    result = bindInput(result.bindings, 'slam', 'keys', 2, 'Shift');
    if (!result.ok) throw new Error('not bound');
    setBindings(result.bindings);
    mouse(surface, 'mousedown', 1);
    key('keydown', 'ShiftLeft');
    expect(controls.read()).toEqual({
      ...IDLE,
      jumpHeld: true,
      jumpPressed: true,
      slamPressed: true,
    });
    expect(controls.read().jumpHeld).toBe(true);
    mouse(window, 'mouseup', 1);
    expect(controls.read().jumpHeld).toBe(false);
    key('keyup', 'ShiftLeft');
    controls.destroy();
  });

  it('reads a gamepad: A to jump, X or RB to dash, B or down to slam, Y for overdrive, Start to pause', () => {
    let pads = [pad([0, 9])];
    const controls = new Controls(window, () => pads);
    expect(controls.read()).toEqual({
      ...IDLE,
      jumpHeld: true,
      jumpPressed: true,
      pausePressed: true,
    });
    // Held, not pressed again.
    expect(controls.read()).toEqual({ ...IDLE, jumpHeld: true });
    pads = [pad([5])];
    expect(controls.read()).toMatchObject({ dashPressed: true, jumpHeld: false });
    pads = [pad([])];
    controls.read();
    pads = [pad([2])];
    expect(controls.read()).toMatchObject({ dashPressed: true });
    pads = [pad([1])];
    expect(controls.read()).toMatchObject({ slamPressed: true });
    pads = [pad([])];
    controls.read();
    pads = [pad([], 0.9)];
    expect(controls.read()).toMatchObject({ slamPressed: true });
    pads = [pad([3])];
    expect(controls.read()).toEqual({ ...IDLE, overdrivePressed: true });
    controls.destroy();
  });
});
