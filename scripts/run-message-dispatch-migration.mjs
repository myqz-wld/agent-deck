#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const require = createRequire(import.meta.url);
const electronPath = require('electron');
const entry = resolve(repoRoot, 'scripts/message-dispatch-offline.mjs');
const result = spawnSync(
  electronPath,
  [entry, ...process.argv.slice(2)],
  {
    cwd: repoRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  },
);

if (result.error) {
  process.stderr.write(JSON.stringify({
    event: 'message-dispatch-offline',
    outcome: 'failed',
    code: 'runtime-start-failure',
  }) + '\n');
  process.exit(1);
}
process.exit(result.status ?? 1);
