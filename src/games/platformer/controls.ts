import type { ControlAction } from '../../core';
import { GameControls, type GamepadSource } from '../shared/controls';
import type { RunInput } from './run';

/**
 * The platformer's controls, from the player's bindings (Settings, `getBindings`): by
 * default Space, W or ↑ to jump, Shift, J, X or right click to dash, S, ↓ or left click
 * to slam, E or L for overdrive; on a gamepad A to jump, X or RB to dash, B or down to
 * slam, Y for overdrive. Escape and Start always pause. The reading itself is the shared
 * `GameControls`; this turns it into the run's input.
 */

/** The actions the platformer uses, in the order Settings and the pause menu list them. */
export const PLATFORMER_ACTIONS = [
  'jump',
  'dash',
  'slam',
  'overdrive',
] as const satisfies readonly ControlAction[];
type PlatformerAction = (typeof PLATFORMER_ACTIONS)[number];

export type { GamepadSource };

export interface ControlsFrame extends Required<RunInput> {
  /** Pause was pressed since the last read. */
  pausePressed: boolean;
}

export class Controls {
  readonly #controls: GameControls<PlatformerAction>;

  constructor(target: Window = window, pads?: GamepadSource, surface: HTMLElement | null = null) {
    this.#controls = new GameControls(PLATFORMER_ACTIONS, target, pads, surface);
  }

  /**
   * Ignore the keys while a menu (pause, results) has them; presses made meanwhile are
   * dropped, so closing the menu doesn't jump.
   */
  set enabled(on: boolean) {
    this.#controls.enabled = on;
  }

  get enabled(): boolean {
    return this.#controls.enabled;
  }

  read(): ControlsFrame {
    const { pressed, held, pausePressed } = this.#controls.read();
    return {
      jumpHeld: held.jump,
      jumpPressed: pressed.jump,
      dashPressed: pressed.dash,
      slamPressed: pressed.slam,
      overdrivePressed: pressed.overdrive,
      pausePressed,
    };
  }

  destroy(): void {
    this.#controls.destroy();
  }
}
