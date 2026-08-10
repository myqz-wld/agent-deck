#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEntrypointArgs, printJson, safeErrorMessage, SERVER_ACTIONS } from './deployment/common.mjs';
import { loadServerConfig } from './deployment/config.mjs';
import { runServerDeployment } from './deployment/server.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const { configPath, action } = parseEntrypointArgs(process.argv.slice(2), SERVER_ACTIONS);
  const config = await loadServerConfig(configPath, 'full', repoRoot);
  printJson(await runServerDeployment(config, action));
} catch (error) {
  process.stderr.write(`Full Server 部署失败：${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
}
