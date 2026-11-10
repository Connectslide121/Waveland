import { platformer } from './platformer';
import { GameRegistry } from './registry';
import { tunnel } from './tunnel';

export * from './registry';

/** Every game in Waveland, in menu order. A new game plugs in here. */
export const games = new GameRegistry().register(platformer).register(tunnel);
