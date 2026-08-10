#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deploymentRoot = resolve(repoRoot, 'scripts/deployment');
const entrypoints = [
  'scripts/deploy-relay-server.mjs',
  'scripts/deploy-relay-worker.mjs',
  'scripts/deploy-full-server.mjs',
];
const modules = readdirSync(deploymentRoot)
  .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
  .map((name) => `scripts/deployment/${name}`);
const remoteScripts = readdirSync(deploymentRoot)
  .filter((name) => name.startsWith('remote-') && name.endsWith('.sh'))
  .map((name) => `scripts/deployment/${name}`);
const examples = readdirSync(resolve(repoRoot, 'deploy/examples'))
  .filter((name) => name.endsWith('.json'))
  .map((name) => `deploy/examples/${name}`);

function fail(message) {
  process.stderr.write(`部署自动化检查失败：${message}\n`);
  process.exit(1);
}

function run(executable, args) {
  try {
    execFileSync(executable, args, {
      cwd: repoRoot,
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    fail(`${args.at(-1) ?? executable} 语法检查失败`);
  }
}

for (const path of [...entrypoints, ...modules]) run(process.execPath, ['--check', path]);
for (const path of remoteScripts) run('/bin/bash', ['-n', path]);
for (const path of examples) {
  try {
    JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
  } catch {
    fail(`${path} 不是有效 JSON`);
  }
}

for (const path of [...entrypoints, ...modules, ...remoteScripts]) {
  const absolute = resolve(repoRoot, path);
  const lines = readFileSync(absolute, 'utf8').split('\n').length - 1;
  if (lines >= 500 || !statSync(absolute).isFile()) fail(`${path} 超过 499 行或不是普通文件`);
}

const processSource = readFileSync(resolve(deploymentRoot, 'process.mjs'), 'utf8');
if (
  !processSource.includes('shell: false') ||
  !processSource.includes('StrictHostKeyChecking=yes') ||
  !processSource.includes('UserKnownHostsFile=') ||
  processSource.includes('shell: true')
) fail('SSH/子进程执行边界不完整');

const configSource = readFileSync(resolve(deploymentRoot, 'config.mjs'), 'utf8');
if (
  !configSource.includes('egressVerified') ||
  !configSource.includes('quotaVerified') ||
  !configSource.includes('workspace 不能指向 Agent Deck 仓库')
) fail('部署配置的验收或 Workspace 边界不完整');

for (const path of remoteScripts) {
  const source = readFileSync(resolve(repoRoot, path), 'utf8');
  if (!source.includes('set -euo pipefail') || !source.includes('/usr/bin/sudo -n')) {
    fail(`${path} 缺少 fail-closed 或免交互 sudo 边界`);
  }
}

for (const path of examples) {
  const source = readFileSync(resolve(repoRoot, path), 'utf8');
  if (source.includes('OPENSSH PRIVATE KEY') || extname(path) !== '.json') {
    fail(`${path} 包含私钥材料或扩展名无效`);
  }
}

process.stdout.write('部署自动化静态检查已通过。\n');
