#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(repoRoot, 'build/linux-headless');
const roles = Object.freeze({
  'server-core': 'src/hosts/server-core/entrypoint.ts',
  'server-core-runtime': 'src/hosts/server-core/runtime-entrypoint.ts',
  'server-core-host-bridge': 'src/hosts/server-core/host-bridge-entrypoint.ts',
  'server-control': 'src/hosts/server-control/entrypoint.ts',
  relay: 'src/hosts/relay/entrypoint.ts',
  'local-worker': 'src/hosts/local-worker/entrypoint.ts',
  'local-worker-runtime': 'src/hosts/local-worker/runtime-entrypoint.ts',
  'provider-session-supervisor': 'src/hosts/provider-session/host-entrypoint.ts',
  'provider-session': 'src/hosts/provider-session/shim-entrypoint.ts',
  feishu: 'src/hosts/feishu/entrypoint.ts',
  'instance-manager': 'src/hosts/instance-manager/entrypoint.ts',
});
const aliases = Object.fromEntries([
  'clients', 'composition', 'contracts', 'core', 'gateways',
  'hosts', 'main', 'protocol', 'shared',
].map((name) => [`@${name}`, resolve(repoRoot, `src/${name}`)]));

if (dirname(outputRoot) !== resolve(repoRoot, 'build')) {
  throw new Error('headless output path fence failed');
}

async function buildAllRoles() {
  await rm(outputRoot, { recursive: true, force: true });
  for (const [role, source] of Object.entries(roles)) {
    await build({
      root: repoRoot,
      configFile: false,
      cacheDir: resolve(outputRoot, '.vite-cache', role),
      logLevel: 'warn',
      resolve: { alias: aliases },
      ssr: role === 'feishu' || role === 'server-core-runtime' || role === 'local-worker-runtime'
        ? { external: ['better-sqlite3'], noExternal: true }
        : { external: ['better-sqlite3'] },
      build: {
        ssr: true,
        target: 'node22',
        outDir: resolve(outputRoot, role),
        emptyOutDir: true,
        minify: false,
        sourcemap: true,
        commonjsOptions: role === 'feishu'
          ? { transformMixedEsModules: true, strictRequires: true }
          : undefined,
        rollupOptions: {
          maxParallelFileOps: 1,
          input: resolve(repoRoot, source),
          output: {
            format: 'es',
            entryFileNames: 'index.mjs',
            inlineDynamicImports: true,
            banner: role === 'server-core-runtime' || role === 'local-worker-runtime'
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
}

async function outputFingerprints() {
  const paths = [
    'manifest.json',
    ...Object.keys(roles).flatMap((role) => [`${role}/index.mjs`, `${role}/index.mjs.map`]),
  ];
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [
    path,
    createHash('sha256').update(await readFile(resolve(outputRoot, path))).digest('hex'),
  ])));
}

await buildAllRoles();
const first = await outputFingerprints();
await buildAllRoles();
const second = await outputFingerprints();
if (JSON.stringify(first) !== JSON.stringify(second)) {
  const changed = Object.keys(first).filter((path) => first[path] !== second[path]);
  throw new Error(`Linux headless build is not reproducible: ${changed.join(', ')}`);
}
process.stdout.write('Linux 无界面 Node 构建与可复现性校验已完成。\n');
