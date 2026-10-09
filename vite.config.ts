/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset URLs so the build works from any sub-path (e.g. GitHub Pages).
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // Monaco is large by nature; don't warn about it on every build.
    chunkSizeWarningLimit: 8000,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
