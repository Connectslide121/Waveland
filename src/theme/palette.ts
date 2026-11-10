/**
 * The Neon arcade palette, with fixed meanings so the player learns to read it.
 * The same values are CSS variables in `palette.css`; a test keeps the two in sync.
 */
export const palette = {
  /** Background. */
  night: '#07060f',
  /** The player and safe paths. */
  cyan: '#2ef2ff',
  /** Beat, score and drops. */
  magenta: '#ff2bd6',
  /** Bass and the world. */
  violet: '#8a5cff',
  /** Danger. */
  orange: '#ff8a2b',
  /** Text. */
  ink: '#e9e7ff',
  /** Secondary text. */
  muted: '#8b87b3',
  /** Deep violet glow at the bottom of the sky. */
  dusk: '#1a0f3a',
  /** Card and panel lines. */
  line: '#2c2558',
  /** The light rim on the player's cube. */
  rim: '#b9fbff',
  /** The white-hot core of lights: gems, the speaker, the drop callout. */
  flare: '#ffffff',
} as const;

export type PaletteColor = keyof typeof palette;

/** Phaser wants colours as numbers (0xRRGGBB). */
export function hexToNumber(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16);
}

/** The palette as numbers, for Phaser. */
export const paletteNumbers = Object.fromEntries(
  Object.entries(palette).map(([name, hex]) => [name, hexToNumber(hex)]),
) as Record<PaletteColor, number>;

/** One beat at the menu's 120 BPM, in seconds. */
export const MENU_BEAT_SECONDS = 0.5;
