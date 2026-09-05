const path = require('node:path');
const root = process.cwd();
module.exports = {
  root,
  cacheDir: path.join(__dirname, 'vite-cache'),
  resolve: { alias: Object.fromEntries(['main','shared','core','hosts','contracts','composition','clients','gateways','protocol','renderer'].map(name => ['@'+name, path.join(root,'src',name)])) },
  test: {
    environment: 'node',
    include: [path.join(__dirname,'*.test.ts')],
    setupFiles: [path.join(root,'vitest-setup.ts')],
    cache: false,
    minWorkers: 1,
    maxWorkers: 1,
  }
};
