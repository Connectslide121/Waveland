import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, getBindings } from '../core';
import { openSettings as open, type SettingsModal } from './settings';

/** Every modal opened, closed after each test so its key listener goes too. */
const opened: SettingsModal[] = [];
const openSettings = (options?: Parameters<typeof open>[0]) => {
  const modal = open(options);
  opened.push(modal);
  return modal;
};

afterEach(() => {
  for (const modal of opened.splice(0)) modal.close();
  localStorage.clear();
  document.body.replaceChildren();
});

const press = (code: string, key = code) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key, cancelable: true }));

/** The slot buttons of an action's row, by device column. */
function slots(modal: HTMLElement, action: 'Jump' | 'Dash' | 'Slam' | 'Left') {
  const row = [...modal.querySelectorAll('.controls__row')].find(
    (r) => r.querySelector('.controls__action span')?.textContent === action,
  )!;
  const [keys, mouse, pad] = [...row.querySelectorAll('.controls__slots')].map((c) => [
    ...c.querySelectorAll<HTMLButtonElement>('button'),
  ]);
  return { keys: keys!, mouse: mouse!, pad: pad!, note: row.querySelector('.controls__note')! };
}

/** The action names of the rows shown, pause included. */
const actions = (modal: HTMLElement) =>
  [
    ...modal.querySelectorAll('.controls__row:not(.controls__row--head) .controls__action span'),
  ].map((s) => s.textContent);

/** The game picker's options, and which is checked. */
const gameOptions = (modal: HTMLElement) =>
  [...modal.querySelectorAll<HTMLInputElement>('.controls__games input')].map((i) => [
    i.parentElement!.textContent,
    i.checked,
  ]);

describe('Settings: Controls', () => {
  it('lists the platformer’s actions first, and each game’s from its picker', () => {
    const modal = openSettings().element;
    expect(gameOptions(modal)).toEqual([
      ['Platformer', true],
      ['Tunnel', false],
    ]);
    expect(actions(modal)).toEqual(['Jump', 'Dash', 'Slam', 'Overdrive', 'Pause']);
    const tunnel = modal.querySelectorAll<HTMLInputElement>('.controls__games input')[1]!;
    tunnel.click();
    expect(actions(modal)).toEqual(['Left', 'Right', 'Jump', 'Overdrive', 'Pause']);
    expect(slots(modal, 'Left').keys.map((b) => b.textContent)).toEqual(['←', 'A', '—']);
    expect(slots(modal, 'Left').pad.map((b) => b.textContent)).toEqual(['D ←', '—']);
  });

  it('opens on the game it is asked for', () => {
    const modal = openSettings({ game: 'tunnel' }).element;
    expect(gameOptions(modal)[1]).toEqual(['Tunnel', true]);
    expect(actions(modal)[0]).toBe('Left');
  });

  it('lets actions no game uses together share an input', () => {
    const modal = openSettings({ game: 'tunnel' }).element;
    slots(modal, 'Left').keys[2]!.click();
    press('KeyS');
    expect(getBindings().left.keys).toEqual(['ArrowLeft', 'KeyA', 'KeyS']);
    expect(getBindings().slam.keys).toEqual(['KeyS', 'ArrowDown', null]);
    expect(slots(modal, 'Left').note.textContent).toBe('');
  });

  it('shows each action’s bindings in key, mouse and gamepad columns, and pause fixed', () => {
    const modal = openSettings().element;
    const heads = [...modal.querySelectorAll('.controls__head')].map((h) => h.textContent);
    expect(heads).toEqual(['Action', 'Keyboard', 'Mouse', 'Gamepad']);
    const dash = slots(modal, 'Dash');
    expect(dash.keys.map((b) => b.textContent)).toEqual(['Shift', 'J', 'X']);
    expect(dash.mouse.map((b) => b.textContent)).toEqual(['Right', '—']);
    expect(dash.pad.map((b) => b.textContent)).toEqual(['X', 'RB']);
    expect(slots(modal, 'Slam').mouse[0]!.textContent).toBe('Left');
    expect(modal.querySelector('.controls__row--fixed')!.textContent).toContain(
      'Esc and Start always pause',
    );
  });

  it('rebinds a key, moves it from the action that had it, and says so', () => {
    const modal = openSettings().element;
    slots(modal, 'Slam').keys[2]!.click();
    expect(slots(modal, 'Slam').keys[2]!.textContent).toBe('Press…');
    expect(slots(modal, 'Slam').note.textContent).toContain('Press a key');
    press('ShiftLeft', 'Shift');
    expect(getBindings().slam.keys).toEqual(['KeyS', 'ArrowDown', 'Shift']);
    expect(getBindings().dash.keys).toEqual([null, 'KeyJ', 'KeyX']);
    expect(slots(modal, 'Slam').note.textContent).toBe('Shift was dash; now slam.');
    expect(slots(modal, 'Dash').keys[0]!.textContent).toBe('—');
  });

  it('cancels on Escape without closing Settings, and never binds Escape', () => {
    const modal = openSettings();
    slots(modal.element, 'Jump').keys[0]!.click();
    press('Escape');
    expect(document.body.contains(modal.element)).toBe(true);
    expect(getBindings()).toEqual(DEFAULT_BINDINGS);
    expect(slots(modal.element, 'Jump').keys[0]!.textContent).toBe('Space');
    // Backspace clears a slot.
    slots(modal.element, 'Jump').keys[1]!.click();
    press('Backspace');
    expect(getBindings().jump.keys).toEqual(['Space', null, 'ArrowUp']);
    // Escape again now closes.
    press('Escape');
    expect(document.body.contains(modal.element)).toBe(false);
  });

  it('binds a mouse button pressed anywhere, without clicking what is under it', () => {
    const modal = openSettings().element;
    slots(modal, 'Jump').mouse[0]!.click();
    // A left click on Done binds left click, and doesn't press Done.
    const done = modal.querySelector<HTMLButtonElement>('.settings__done')!;
    const mouse = (type: string) =>
      done.dispatchEvent(new MouseEvent(type, { button: 0, bubbles: true, cancelable: true }));
    mouse('mousedown');
    mouse('mouseup');
    mouse('click');
    expect(getBindings().jump.mouse).toEqual(['left', null]);
    expect(getBindings().slam.mouse).toEqual([null, null]);
    expect(document.body.contains(modal)).toBe(true);
    expect(slots(modal, 'Jump').note.textContent).toBe('Left click was slam; now jump.');
    // Right click moves from dash to jump, in the second slot.
    slots(modal, 'Jump').mouse[1]!.click();
    window.dispatchEvent(new MouseEvent('mousedown', { button: 2, cancelable: true }));
    expect(getBindings().jump.mouse).toEqual(['left', 'right']);
    expect(getBindings().dash.mouse).toEqual([null, null]);
    expect(slots(modal, 'Jump').note.textContent).toBe('Right click was dash; now jump.');
  });

  it('binds a newly pressed gamepad button, refusing Start', async () => {
    let buttons: number[] = [];
    const pad = () =>
      ({
        connected: true,
        axes: [0, 0],
        buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: buttons.includes(i) })),
      }) as unknown as Gamepad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad()], configurable: true });
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const modal = openSettings().element;
    slots(modal, 'Jump').pad[1]!.click();
    buttons = [3];
    await frame();
    await frame();
    expect(getBindings().jump.pad).toEqual([0, 3]);
    slots(modal, 'Jump').pad[1]!.click();
    buttons = [3, 9];
    await frame();
    await frame();
    expect(getBindings().jump.pad).toEqual([0, 3]);
    expect(slots(modal, 'Jump').note.textContent).toBe('Start always pauses; pick another.');
  });

  it('resets one action, or all', () => {
    const modal = openSettings().element;
    slots(modal, 'Dash').keys[0]!.click();
    press('KeyQ');
    slots(modal, 'Jump').keys[0]!.click();
    press('KeyE');
    modal.querySelector<HTMLButtonElement>('[aria-label="Reset dash to its defaults"]')!.click();
    expect(getBindings().dash).toEqual(DEFAULT_BINDINGS.dash);
    expect(getBindings().jump.keys[0]).toBe('KeyE');
    modal.querySelector<HTMLButtonElement>('.controls__reset-all')!.click();
    expect(getBindings()).toEqual(DEFAULT_BINDINGS);
    expect(modal.querySelector('.controls__foot')!.textContent).toBe(
      'Every control is back to its defaults.',
    );
  });
});
