import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@agentclientprotocol/sdk'] })],
    resolve: {
      alias: {
        '@clients': resolve(__dirname, 'src/clients'),
        '@composition': resolve(__dirname, 'src/composition'),
        '@contracts': resolve(__dirname, 'src/contracts'),
        '@core': resolve(__dirname, 'src/core'),
        '@gateways': resolve(__dirname, 'src/gateways'),
        '@hosts': resolve(__dirname, 'src/hosts'),
        '@protocol': resolve(__dirname, 'src/protocol'),
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
        '@contracts': resolve(__dirname, 'src/contracts'),
        '@protocol': resolve(__dirname, 'src/protocol'),
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
        '@contracts': resolve(__dirname, 'src/contracts'),
        '@protocol': resolve(__dirname, 'src/protocol'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    plugins: [react()],
    build: {
      outDir: 'build/renderer',
    },
    server: {
      port: 5173,
    },
  },
});
