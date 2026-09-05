import { resolve } from 'node:path';
const evidenceRoot = '/tmp/agent-deck-scan/2026-09-04-project-scan/remote';
const aliases = Object.fromEntries(['clients','composition','contracts','core','gateways','hosts','protocol','shared','main','renderer'].map(name => ['@'+name, resolve('src', name)]));
export default {
  root: process.cwd(),
  cacheDir: evidenceRoot + '/vite-cache',
  resolve: { alias: { ...aliases, vitest: resolve('node_modules/vitest/dist/index.js'), '@larksuiteoapi/node-sdk': resolve('node_modules/@larksuiteoapi/node-sdk/lib/index.js') } },
  test: {
    environment: 'node',
    include: [evidenceRoot + '/repro.test.ts'],
    setupFiles: [resolve('vitest-setup.ts')],
    cache: false,
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
  },
};
