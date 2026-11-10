import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Difficulty, LevelMap } from '../core';
import { randomAnalysis } from '../core/test-analysis';
import { generateLevel } from '../games/platformer/level';
import { createLevelPreview, type LevelPreview } from './level-preview';

const analysis = randomAnalysis(3, { duration: 30, tempo: 120 });
let preview: LevelPreview | null = null;

beforeEach(() => {
  // jsdom draws nothing; the preview skips drawing without a 2D context.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  preview?.destroy();
  preview = null;
  vi.restoreAllMocks();
});

function mount(build: (map: LevelMap, d: Difficulty) => Promise<ReturnType<typeof generateLevel>>) {
  preview = createLevelPreview({ analysis, build });
  document.body.append(preview.element);
  const q = <T extends Element>(selector: string) => preview!.element.querySelector<T>(selector)!;
  const value = (label: string) =>
    [...preview!.element.querySelectorAll('.stats__cell')]
      .find((c) => c.querySelector('dt')!.textContent === label)!
      .querySelector('dd')!.textContent;
  return { q, value };
}

describe('level preview', () => {
  it('builds the normal level first, showing a spinner and no numbers meanwhile', () => {
    const build = vi.fn(() => new Promise<never>(() => {}));
    const { q, value } = mount(build);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ duration: 30 }), 'normal');
    expect(q('[aria-checked=true]').textContent).toBe('Normal');
    expect(q('figure').getAttribute('aria-busy')).toBe('true');
    expect(q<HTMLElement>('.timeline__spinner').hidden).toBe(false);
    expect(value('Coins')).toBe('—');
  });

  it('shows what the level holds once built', async () => {
    const { q, value } = mount((map, d) => Promise.resolve(generateLevel(map, d)));
    await vi.waitFor(() => expect(q('figure').getAttribute('aria-busy')).toBe('false'));
    expect(Number(value('Coins'))).toBeGreaterThan(0);
    expect(Number(value('Obstacles'))).toBeGreaterThan(0);
    expect(q<HTMLElement>('.timeline__spinner').hidden).toBe(true);
    // Drawing without a canvas context is a no-op, not an error.
    preview!.draw(5);
  });

  it('rebuilds at the difficulty picked, and ignores a build that comes back late', async () => {
    const resolvers: ((l: ReturnType<typeof generateLevel>) => void)[] = [];
    const build = vi.fn(
      () => new Promise<ReturnType<typeof generateLevel>>((r) => resolvers.push(r)),
    );
    const { q, value } = mount(build);
    const hard = [...preview!.element.querySelectorAll<HTMLButtonElement>('[role=radio]')].find(
      (b) => b.textContent === 'Hard',
    )!;
    hard.click();
    expect(build).toHaveBeenLastCalledWith(expect.anything(), 'hard');
    expect(q('[aria-checked=true]').textContent).toBe('Hard');
    // The normal level arrives after Hard was picked: it is dropped.
    const empty = { chunks: [], pickups: [] } as unknown as ReturnType<typeof generateLevel>;
    resolvers[0]!({ ...empty, pickups: [{ kind: 'coin', x: 0, y: 0, time: 0 }] });
    await Promise.resolve();
    expect(value('Coins')).toBe('—');
    resolvers[1]!(empty);
    await vi.waitFor(() => expect(value('Coins')).toBe('0'));
  });

  it('says so when the level cannot be built', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { q } = mount(() => Promise.reject(new Error('no')));
    await vi.waitFor(() =>
      expect(q('.level-preview__status').textContent).toBe(
        "The level couldn't be built for this song",
      ),
    );
    expect(q<HTMLElement>('.timeline__spinner').hidden).toBe(true);
  });
});
