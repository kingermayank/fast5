import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

/** The commit this was built from, shown on the title screen so it's clear which version is running. */
function commit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  base: './',
  define: {
    __BUILD__: JSON.stringify(commit()),
  },
  build: {
    // three.js plus the inlined Rapier wasm; a single chunk is fine for a game.
    chunkSizeWarningLimit: 6000,
  },
});
