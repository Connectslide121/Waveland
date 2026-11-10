/** Numbers as the games' HUDs and results screens show them. */

/** The score as six digits in two groups, like an arcade counter: 048 210. */
export function formatScore(score: number): string {
  const digits = String(Math.max(0, Math.floor(score))).padStart(6, '0');
  return digits.replace(/\B(?=(\d{3})+$)/g, ' ');
}

/** Accuracy as a whole percentage, or a dash when there was nothing to judge. */
export function formatAccuracy(accuracy: number | null): string {
  return accuracy === null ? '—' : `${Math.round(accuracy * 100)}%`;
}

/** The frame rate readout: 60 FPS · 4.2 MS, or dashes before the first half second. */
export function formatPerf(fps: number, cpuMs: number): string {
  if (fps <= 0) return '— FPS · — MS';
  return `${Math.round(fps)} FPS · ${cpuMs.toFixed(1)} MS`;
}
