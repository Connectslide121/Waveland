import {
  bindingKey,
  CONTROL_ACTIONS,
  getBindings,
  MOUSE_BUTTONS,
  onSettingsChange,
  PAUSE_KEY,
  PAUSE_PAD_BUTTON,
  PAD_BUTTONS,
  type Bindings,
  type ControlAction,
  type MouseButton,
} from '../../core';
import type { RunInput } from './run';

/**
 * The platformer's controls, from the player's bindings (Settings, `getBindings`): by
 * default Space, W or ↑ to jump, Shift, J, X or right click to dash, S, ↓ or left click
 * to slam, E or L for overdrive; on a gamepad A to jump, X or RB to dash, B or down to
 * slam, Y for overdrive. Escape and Start
 * always pause. The left stick counts as the d-pad. The scene reads them once a frame
 * with `read()`, so a press from any device goes the same way into the run's fixed steps.
 */

/** The stick counts as pushed past this. */
const DEAD_ZONE = 0.5;
/** Clicks on these are the menus', not the game's. */
const NOT_GAME = 'button, a, input, select, textarea, label, [role="dialog"], .pf-modal';

export interface ControlsFrame extends Required<RunInput> {
  /** Pause was pressed since the last read. */
  pausePressed: boolean;
}

/** Where to read gamepads from; tests pass their own. */
export type GamepadSource = () => readonly (Gamepad | null)[];

const browserPads: GamepadSource = () =>
  typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];

type Flags = Record<ControlAction, boolean>;
const none = (): Flags => ({ jump: false, dash: false, slam: false, overdrive: false });

export class Controls {
  /** Keys (as bindings name them) and mouse buttons held down. */
  readonly #keys = new Set<string>();
  readonly #mouse = new Set<number>();
  /** Pressed since the last read. */
  #pressed = none();
  #pausePressed = false;
  /** Gamepad actions held at the last read, to see new presses. */
  #padHeld = none();
  #padPause = false;
  #enabled = true;
  #bindings: Bindings = getBindings();
  readonly #stopSettings = onSettingsChange(() => (this.#bindings = getBindings()));

  /** The actions a key is bound to. */
  #actionsOfKey(key: string): ControlAction[] {
    return CONTROL_ACTIONS.filter((a) => this.#bindings[a].keys.includes(key));
  }

  #actionsOfMouse(button: number): ControlAction[] {
    return CONTROL_ACTIONS.filter((a) =>
      this.#bindings[a].mouse.some((m) => m !== null && MOUSE_BUTTONS[m] === button),
    );
  }

  readonly #down = (event: KeyboardEvent) => {
    if (!this.#enabled) return;
    if (event.code === PAUSE_KEY) {
      if (!event.repeat) this.#pausePressed = true;
      event.preventDefault();
      return;
    }
    const key = bindingKey(event.code);
    const actions = this.#actionsOfKey(key);
    if (actions.length === 0) return;
    // Space would press a focused button and arrows would scroll.
    event.preventDefault();
    if (!event.repeat) for (const a of actions) this.#pressed[a] = true;
    this.#keys.add(key);
  };

  readonly #up = (event: KeyboardEvent) => {
    this.#keys.delete(bindingKey(event.code));
  };

  readonly #mouseDown = (event: MouseEvent) => {
    if (!this.#enabled || (event.target instanceof Element && event.target.closest(NOT_GAME)))
      return;
    const actions = this.#actionsOfMouse(event.button);
    if (actions.length === 0) return;
    // Back and forward would leave the page; the middle button would scroll.
    event.preventDefault();
    for (const a of actions) this.#pressed[a] = true;
    this.#mouse.add(event.button);
  };

  readonly #mouseUp = (event: MouseEvent) => {
    this.#mouse.delete(event.button);
  };

  /** Right click is the game's on its surface, not the browser's menu. */
  readonly #contextMenu = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest(NOT_GAME)) return;
    event.preventDefault();
  };

  readonly #blur = () => {
    this.#keys.clear();
    this.#mouse.clear();
  };

  constructor(
    private readonly target: Window = window,
    private readonly pads: GamepadSource = browserPads,
    /** Where mouse buttons play: the game's container. */
    private readonly surface: HTMLElement | null = null,
  ) {
    target.addEventListener('keydown', this.#down);
    target.addEventListener('keyup', this.#up);
    target.addEventListener('blur', this.#blur);
    // Released anywhere, so a button let go off the canvas doesn't stay held.
    target.addEventListener('mouseup', this.#mouseUp);
    surface?.addEventListener('mousedown', this.#mouseDown);
    surface?.addEventListener('contextmenu', this.#contextMenu);
  }

  /**
   * Ignore the keys while a menu (pause, results) has them; presses made meanwhile are
   * dropped, so closing the menu doesn't jump.
   */
  set enabled(on: boolean) {
    this.#enabled = on;
    this.#keys.clear();
    this.#mouse.clear();
    this.#pressed = none();
    this.#pausePressed = false;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** True while any key or mouse button bound to the action is held. */
  #held(action: ControlAction): boolean {
    const b = this.#bindings[action];
    for (const key of b.keys) if (key !== null && this.#keys.has(key)) return true;
    for (const m of b.mouse)
      if (m !== null && this.#mouse.has(MOUSE_BUTTONS[m as MouseButton])) return true;
    return false;
  }

  read(): ControlsFrame {
    const pressed = this.#pressed;
    let pausePressed = this.#pausePressed;
    this.#pressed = none();
    this.#pausePressed = false;

    const padHeld = none();
    let padPause = false;
    for (const pad of this.pads()) {
      if (!pad || !pad.connected) continue;
      const y = pad.axes[1] ?? 0;
      const down = (i: number) =>
        (pad.buttons[i]?.pressed ?? false) ||
        (i === PAD_BUTTONS.down && y > DEAD_ZONE) ||
        (i === PAD_BUTTONS.up && y < -DEAD_ZONE);
      for (const a of CONTROL_ACTIONS)
        padHeld[a] ||= this.#bindings[a].pad.some((b) => b !== null && down(b));
      padPause ||= down(PAUSE_PAD_BUTTON);
    }
    // Start works in the pause menu too, to resume.
    pausePressed ||= padPause && !this.#padPause;
    const frame: ControlsFrame = {
      jumpHeld: false,
      jumpPressed: false,
      dashPressed: false,
      slamPressed: false,
      overdrivePressed: false,
      pausePressed,
    };
    if (this.#enabled) {
      const fresh = (a: ControlAction) => pressed[a] || (padHeld[a] && !this.#padHeld[a]);
      frame.jumpHeld = this.#held('jump') || padHeld.jump;
      frame.jumpPressed = fresh('jump');
      frame.dashPressed = fresh('dash');
      frame.slamPressed = fresh('slam');
      frame.overdrivePressed = fresh('overdrive');
    }
    this.#padHeld = padHeld;
    this.#padPause = padPause;
    return frame;
  }

  destroy(): void {
    this.target.removeEventListener('keydown', this.#down);
    this.target.removeEventListener('keyup', this.#up);
    this.target.removeEventListener('blur', this.#blur);
    this.target.removeEventListener('mouseup', this.#mouseUp);
    this.surface?.removeEventListener('mousedown', this.#mouseDown);
    this.surface?.removeEventListener('contextmenu', this.#contextMenu);
    this.#stopSettings();
  }
}
