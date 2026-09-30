import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { runCommand, sshArgs } from './process.mjs';

export async function expandedGzipBytes(path) {
  const input = createReadStream(path);
  const output = createGunzip();
  input.on('error', error => output.destroy(error));
  input.pipe(output);
  let total = 0;
  try {
    for await (const chunk of output) {
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > 4 * 1024 ** 3) {
        throw new Error('部署归档展开后超过磁盘预算上限。');
      }
    }
    return total;
  } finally {
    input.destroy();
    output.destroy();
  }
}

export async function releaseStorageBudget(config, archive) {
  const archiveBytes = (await stat(archive)).size;
  const expandedReleaseBytes = await expandedGzipBytes(archive);
  const runtimeBytes = [];
  for (const architecture of ['amd64', 'arm64']) {
    runtimeBytes.push(await expandedGzipBytes(join(config.repoRoot, 'build/feishu-runtime',
      `linux-${architecture}`, `agent-deck-feishu-runtime-linux-${architecture}.tgz`)));
  }
  return [archiveBytes, expandedReleaseBytes, ...runtimeBytes];
}

export async function verifyRemoteStorageBudget(config, budget = [0, 0, 0, 0]) {
  if (budget.length !== 4 || budget.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('部署磁盘预算无效。');
  }
  const script = join(dirname(fileURLToPath(import.meta.url)), 'remote-storage-budget.mjs');
  const remote = await runCommand(config.ssh.sshBinary, [
    ...sshArgs(config.ssh), '--', `${config.ssh.user}@${config.ssh.host}`,
    '/usr/bin/sudo', '-n', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C', 'LC_ALL=C',
    '/usr/bin/node', '--input-type=module', '-', ...budget.map(String),
  ], { input: await readFile(script, 'utf8'), timeoutMs: 30_000, allowFailure: true });
  let result;
  try { result = JSON.parse(remote.stdout); } catch { throw new Error('远程部署磁盘检查失败。'); }
  if (result?.schemaVersion !== 1 || typeof result.ok !== 'boolean' ||
      !Array.isArray(result.checks) || result.checks.length === 0 ||
      result.checks.some(check => !Number.isSafeInteger(check.availableBytes) || check.availableBytes < 0 ||
        !Number.isSafeInteger(check.requiredBytes) || check.requiredBytes < 0)) {
    throw new Error('远程部署磁盘检查返回了无效结果。');
  }
  const failed = result.checks.find(check => check.availableBytes < check.requiredBytes);
  if (failed) {
    throw new Error(`远程部署空间不足：至少需要 ${Math.ceil(failed.requiredBytes / 1024 ** 2)} MiB，` +
      `可用 ${Math.floor(failed.availableBytes / 1024 ** 2)} MiB；请清理旧包或扩容后重试。`);
  }
  if (remote.code !== 0 || !result.ok) throw new Error('远程部署磁盘检查失败。');
  return result;
}
