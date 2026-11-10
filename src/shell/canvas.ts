/** Small helpers the shell's canvas views share. */

export const CANVAS_FONT = `'Bahnschrift', 'DIN Alternate', 'Segoe UI', system-ui, sans-serif`;

/** A palette colour (#rrggbb) at an opacity, for canvas styles. */
export function alpha(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${a})`;
}

/** A canvas that keeps its backing store at the device's pixel ratio. */
export function sizedCanvas(
  canvas: HTMLCanvasElement,
): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w, h };
}
