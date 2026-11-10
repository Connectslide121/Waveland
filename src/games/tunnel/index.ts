import type { SoonGame } from '../registry';

export const tunnel: SoonGame = {
  id: 'tunnel',
  name: 'Tunnel',
  blurb: 'Race through a tunnel shaped by the melody.',
  status: 'soon',
  reason: 'Comes after the platformer.',
  // Steer between lanes, jump low walls, and the shared overdrive (docs/tunnel.md).
  controls: ['left', 'right', 'jump', 'overdrive'],
  icon: `<svg viewBox="0 0 60 60" aria-hidden="true"><g fill="none" stroke="var(--magenta)" stroke-width="2.5"><rect x="4" y="4" width="52" height="52" rx="6"/><rect x="16" y="16" width="28" height="28" rx="4" opacity=".7"/><rect x="25" y="25" width="10" height="10" rx="2" opacity=".45"/><path d="M4 4L25 25M56 4L35 25M4 56L25 35M56 56L35 35" opacity=".5"/></g></svg>`,
};
