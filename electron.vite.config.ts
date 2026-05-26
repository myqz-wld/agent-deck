import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
      },
    },
    build: {
      outDir: 'build/main',
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      outDir: 'build/preload',
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    plugins: [react()],
    build: {
      outDir: 'build/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    server: {
      port: 5173,
    },
  },
});
