#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(repoRoot, 'scripts/history-search-offline.mjs');
const result = spawnSync(electronPath, [entry, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

if (result.error) {
  console.error('[history-search-migration] failed to start Electron runtime:', result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
