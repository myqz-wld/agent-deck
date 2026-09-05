import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(resolve(process.cwd(), 'package.json'));
const base = realpathSync('/tmp/agent-deck-scan/2026-09-04-project-scan/desktop');
export default {
 root: process.cwd(),
 server: { fs: { allow: [process.cwd(), base] } },
 cacheDir: base + '/vite-cache',
 esbuild: { jsx: 'automatic' },
 resolve: { alias: {
   ...Object.fromEntries(['clients','composition','contracts','core','gateways','hosts','protocol','shared','main','renderer'].map(n => ['@'+n, resolve('src',n)])),
   'react': require.resolve('react').replace(/index\.js$/, ''),
   'react-dom': require.resolve('react-dom').replace(/index\.js$/, ''),
   '@testing-library/react': require.resolve('@testing-library/react'),
   'vitest': require.resolve('vitest').replace(/index\.cjs$/, 'dist/index.js'),
 } },
 test: { environment: 'happy-dom', include: [base + '/*.test.tsx'], setupFiles: [resolve('vitest-setup.ts')], cache: false, maxWorkers: 1, minWorkers: 1 }
};
