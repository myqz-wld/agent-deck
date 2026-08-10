#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEntrypointArgs, printJson, safeErrorMessage, WORKER_ACTIONS } from './deployment/common.mjs';
import { loadWorkerConfig } from './deployment/config.mjs';
import { runWorkerDeployment } from './deployment/worker.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const { configPath, action } = parseEntrypointArgs(process.argv.slice(2), WORKER_ACTIONS);
  const config = await loadWorkerConfig(configPath, repoRoot);
  printJson(await runWorkerDeployment(config, action));
} catch (error) {
  process.stderr.write(`Relay Worker 部署失败：${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
}
