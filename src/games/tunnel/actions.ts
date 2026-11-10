import type { ControlAction } from '../../core';

/** The actions the tunnel uses, in the order Settings and the pause menu list them. */
export const TUNNEL_ACTIONS = [
  'left',
  'right',
  'jump',
  'overdrive',
] as const satisfies readonly ControlAction[];
