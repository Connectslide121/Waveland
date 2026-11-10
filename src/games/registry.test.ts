import { describe, expect, it } from 'vitest';
import { games, GameRegistry, type SoonGame } from '.';

describe('games', () => {
  it('lists the platformer first and ready, the tunnel as coming soon', () => {
    expect(games.all().map((g) => [g.id, g.status])).toEqual([
      ['platformer', 'ready'],
      ['tunnel', 'soon'],
    ]);
    expect(games.firstReady()?.id).toBe('platformer');
  });

  it('says which controls each game uses', () => {
    expect(games.get('platformer')!.controls).toEqual(['jump', 'dash', 'slam', 'overdrive']);
    expect(games.get('tunnel')!.controls).toEqual(['left', 'right', 'jump', 'overdrive']);
  });

  it('says in words why a soon game cannot be played', () => {
    const tunnel = games.get('tunnel') as SoonGame;
    expect(tunnel.reason.length).toBeGreaterThan(0);
  });
});

describe('GameRegistry', () => {
  const soon: SoonGame = {
    id: 'x',
    name: 'X',
    blurb: '',
    icon: '',
    status: 'soon',
    controls: [],
    reason: 'Later',
  };

  it('refuses two games with the same id', () => {
    const registry = new GameRegistry().register(soon);
    expect(() => registry.register(soon)).toThrow(/already registered/);
  });

  it('has no default pick when nothing is ready', () => {
    expect(new GameRegistry().register(soon).firstReady()).toBeUndefined();
  });
});
