import type { RunInput } from './run';

/**
 * The platformer's controls: arrows or A/D to run, Space, Up or W to jump, Escape to
 * pause; on a gamepad the left stick or d-pad, A (or B) to jump and Start to pause.
 * The scene reads them once a frame with `read()`.
 */

const LEFT_KEYS = new Set(['ArrowLeft', 'KeyA']);
const RIGHT_KEYS = new Set(['ArrowRight', 'KeyD']);
const JUMP_KEYS = new Set(['Space', 'ArrowUp', 'KeyW']);
/** Standard gamepad buttons. */
const PAD = { a: 0, b: 1, start: 9, up: 12, left: 14, right: 15 } as const;
/** The stick counts as pushed past this. */
const DEAD_ZONE = 0.4;

export interface ControlsFrame extends RunInput {
  /** Pause was pressed since the last read. */
  pausePressed: boolean;
}

/** Where to read gamepads from; tests pass their own. */
export type GamepadSource = () => readonly (Gamepad | null)[];

const browserPads: GamepadSource = () =>
  typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];

export class Controls {
  readonly #held = new Set<string>();
  #jumpPressed = false;
  #pausePressed = false;
  /** Gamepad buttons held at the last read, to see new presses. */
  #padJump = false;
  #padPause = false;
  #enabled = true;

  readonly #down = (event: KeyboardEvent) => {
    if (!this.#enabled) return;
    const code = event.code;
    if (code === 'Escape') {
      if (!event.repeat) this.#pausePressed = true;
      event.preventDefault();
      return;
    }
    if (!LEFT_KEYS.has(code) && !RIGHT_KEYS.has(code) && !JUMP_KEYS.has(code)) return;
    // Space would press a focused button and arrows would scroll.
    event.preventDefault();
    if (JUMP_KEYS.has(code) && !event.repeat) this.#jumpPressed = true;
    this.#held.add(code);
  };

  readonly #up = (event: KeyboardEvent) => {
    this.#held.delete(event.code);
  };

  readonly #blur = () => {
    this.#held.clear();
  };

  constructor(
    private readonly target: Window = window,
    private readonly pads: GamepadSource = browserPads,
  ) {
    target.addEventListener('keydown', this.#down);
    target.addEventListener('keyup', this.#up);
    target.addEventListener('blur', this.#blur);
  }

  /**
   * Ignore the keys while a menu (pause, results) has them; presses made meanwhile are
   * dropped, so closing the menu doesn't jump.
   */
  set enabled(on: boolean) {
    this.#enabled = on;
    this.#held.clear();
    this.#jumpPressed = false;
    this.#pausePressed = false;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  read(): ControlsFrame {
    let left = [...LEFT_KEYS].some((k) => this.#held.has(k));
    let right = [...RIGHT_KEYS].some((k) => this.#held.has(k));
    let jumpHeld = [...JUMP_KEYS].some((k) => this.#held.has(k));
    let jumpPressed = this.#jumpPressed;
    let pausePressed = this.#pausePressed;
    this.#jumpPressed = false;
    this.#pausePressed = false;

    let padJump = false;
    let padPause = false;
    for (const pad of this.pads()) {
      if (!pad || !pad.connected) continue;
      const pressed = (i: number) => pad.buttons[i]?.pressed ?? false;
      const x = pad.axes[0] ?? 0;
      left ||= x < -DEAD_ZONE || pressed(PAD.left);
      right ||= x > DEAD_ZONE || pressed(PAD.right);
      padJump ||= pressed(PAD.a) || pressed(PAD.b) || pressed(PAD.up);
      padPause ||= pressed(PAD.start);
    }
    // Start works in the pause menu too, to resume.
    pausePressed ||= padPause && !this.#padPause;
    if (this.#enabled) {
      jumpPressed ||= padJump && !this.#padJump;
      jumpHeld ||= padJump;
    } else {
      left = right = jumpHeld = false;
    }
    this.#padJump = padJump;
    this.#padPause = padPause;

    const dir = left === right ? 0 : left ? -1 : 1;
    return { dir, jumpHeld, jumpPressed, pausePressed };
  }

  destroy(): void {
    this.target.removeEventListener('keydown', this.#down);
    this.target.removeEventListener('keyup', this.#up);
    this.target.removeEventListener('blur', this.#blur);
  }
}
