#!/usr/bin/env node

import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(repoRoot, 'build/linux-headless');
const roles = Object.freeze({
  'server-core': 'src/hosts/server-core/entrypoint.ts',
  'server-core-runtime': 'src/hosts/server-core/runtime-entrypoint.ts',
  'server-core-host-bridge': 'src/hosts/server-core/host-bridge-entrypoint.ts',
  relay: 'src/hosts/relay/entrypoint.ts',
  'local-worker': 'src/hosts/local-worker/entrypoint.ts',
  feishu: 'src/hosts/feishu/entrypoint.ts',
  'instance-manager': 'src/hosts/instance-manager/adapters/production.ts',
});
const aliases = Object.fromEntries([
  'clients', 'composition', 'contracts', 'core', 'gateways',
  'hosts', 'main', 'protocol', 'shared',
].map((name) => [`@${name}`, resolve(repoRoot, `src/${name}`)]));

if (dirname(outputRoot) !== resolve(repoRoot, 'build')) {
  throw new Error('headless output path fence failed');
}
await rm(outputRoot, { recursive: true, force: true });

for (const [role, source] of Object.entries(roles)) {
  await build({
    root: repoRoot,
    configFile: false,
    logLevel: 'warn',
    resolve: { alias: aliases },
    ssr: role === 'feishu' || role === 'server-core-runtime'
      ? { external: ['better-sqlite3'], noExternal: true }
      : { external: ['better-sqlite3'] },
    build: {
      ssr: true,
      target: 'node22',
      outDir: resolve(outputRoot, role),
      emptyOutDir: true,
      minify: false,
      sourcemap: true,
      commonjsOptions: role === 'feishu' ? { transformMixedEsModules: true } : undefined,
      rollupOptions: {
        input: resolve(repoRoot, source),
        output: {
          format: 'es',
          entryFileNames: 'index.mjs',
          inlineDynamicImports: true,
          banner: role === 'server-core-runtime'
            ? "const __filename = decodeURIComponent(new URL(import.meta.url).pathname); const __dirname = decodeURIComponent(new URL('.', import.meta.url).pathname);"
            : role === 'feishu'
              ? "const __dirname = decodeURIComponent(new URL('.', import.meta.url).pathname);"
              : undefined,
        },
      },
    },
  });
}

await writeFile(resolve(outputRoot, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  runtime: 'node',
  target: 'node22',
  entries: Object.fromEntries(Object.keys(roles).map((role) => [role, `${role}/index.mjs`])),
  nativeExternals: ['better-sqlite3'],
}, null, 2)}\n`, { mode: 0o644 });

process.stdout.write('Linux 无界面 Node 构建已完成。\n');
