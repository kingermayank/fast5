import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    // three.js plus the inlined Rapier wasm; a single chunk is fine for a game.
    chunkSizeWarningLimit: 3000,
  },
});
