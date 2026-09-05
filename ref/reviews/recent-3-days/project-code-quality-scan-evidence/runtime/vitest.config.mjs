import path from 'node:path';
const repo = process.cwd();
const evidence = '/tmp/agent-deck-scan/2026-09-04-project-scan/runtime';
export default {
  root: evidence,
  cacheDir: path.join(evidence, 'vite-cache'),
  resolve: { alias: Object.fromEntries([
    'clients','composition','contracts','core','gateways','hosts','protocol','shared','main','renderer',
  ].map(name => [`@${name}`, path.join(repo, 'src', name)])) },
  test: { environment: 'node', include: ['scan-repro.test.ts'], maxWorkers: 1, minWorkers: 1, cache: false },
};
