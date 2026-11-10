import type { ReadyGame } from '../registry';

export const platformer: ReadyGame = {
  id: 'platformer',
  name: 'Platformer',
  blurb: 'Jump, dash and slam, locked to the beat.',
  status: 'ready',
  icon: `<svg viewBox="0 0 60 60" aria-hidden="true"><path d="M8 52V40M18 52V34M28 52V44M38 52V30M48 52V38" fill="none" stroke="var(--violet)" stroke-width="3" stroke-linecap="round"/><rect x="22" y="12" width="12" height="12" rx="3" fill="var(--cyan)" style="filter:drop-shadow(0 0 4px var(--cyan))"/></svg>`,
  async start(song, container, exit) {
    // Phaser is big: load it only when the game starts, so the menu opens fast.
    const { startPlatformer } = await import('./game');
    return startPlatformer(song, container, exit);
  },
};
