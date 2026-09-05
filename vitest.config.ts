import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Vitest stays separate from the Electron Vite main/preload/renderer build chain.
 * Keep its aliases aligned with the production configs so tests resolve the same imports.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@clients': resolve('src/clients'),
      '@composition': resolve('src/composition'),
      '@contracts': resolve('src/contracts'),
      '@core': resolve('src/core'),
      '@gateways': resolve('src/gateways'),
      '@hosts': resolve('src/hosts'),
      '@protocol': resolve('src/protocol'),
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer'),
    },
  },
  test: {
    // Main, preload, and pure-logic tests use Node. DOM tests opt into happy-dom per file.
    environment: 'node',
    // Cover TypeScript tests under src and Node ESM automation tests under scripts.
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'scripts/**/*.test.mjs',
    ],
    // Install deterministic application paths and shared Electron-only module mocks.
    setupFiles: ['./vitest-setup.ts'],
  },
});
