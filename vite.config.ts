import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    // Phaser alone is ~1.2 MB minified; keep it in its own chunk, loaded when a game starts.
    chunkSizeWarningLimit: 1600,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
