import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages serves the site from /Waveland/; the deploy workflow sets BASE_PATH.
  base: process.env.BASE_PATH || '/',
  build: {
    // Phaser alone is ~1.2 MB minified; keep it in its own chunk, loaded when a game starts.
    chunkSizeWarningLimit: 1600,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
