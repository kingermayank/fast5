import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    // three.js alone is ~500 kB; a single chunk is fine for a game.
    chunkSizeWarningLimit: 1000,
  },
});
