// @vitest-environment node
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MENU_BEAT_SECONDS, hexToNumber, palette, paletteNumbers } from './palette';

function cssVariables(source: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const [, name, value] of source.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    vars.set(name!, value!.trim());
  }
  return vars;
}

describe('palette', () => {
  const vars = cssVariables(readFileSync(new URL('./palette.css', import.meta.url), 'utf8'));

  it('has every colour as a CSS variable with the same value', () => {
    for (const [name, hex] of Object.entries(palette)) {
      expect(vars.get(name), `--${name}`).toBe(hex);
    }
  });

  it('keeps the menu beat in step with the CSS', () => {
    expect(vars.get('beat')).toBe(`${MENU_BEAT_SECONDS}s`);
  });

  it('converts colours to numbers for Phaser', () => {
    expect(hexToNumber('#07060f')).toBe(0x07060f);
    expect(paletteNumbers.cyan).toBe(0x2ef2ff);
  });
});
