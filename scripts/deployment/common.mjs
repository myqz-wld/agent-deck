import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, normalize, resolve } from 'node:path';

export const SERVER_ACTIONS = Object.freeze([
  'check', 'dry-run', 'deploy', 'upgrade', 'rollback', 'verify',
]);
export const WORKER_ACTIONS = Object.freeze([
  'check', 'dry-run', 'deploy', 'upgrade', 'verify',
]);

export function fail(message) {
  throw new Error(message);
}

export function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} 必须是对象。`);
  }
  return value;
}

export function exactKeys(value, expected, field) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${field} 包含缺失或多余字段。`);
  }
}

export function string(value, field, maximum = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.length > maximum) {
    fail(`${field} 必须是非空字符串。`);
  }
  return value;
}

export function token(value, field, pattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/) {
  const parsed = string(value, field, 160);
  if (!pattern.test(parsed)) fail(`${field} 格式无效。`);
  return parsed;
}

export function absolutePath(value, field) {
  const path = string(value, field);
  if (!isAbsolute(path) || normalize(path) !== path || path === '/') {
    fail(`${field} 必须是规范化的绝对路径。`);
  }
  return path;
}

export function positiveInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail(`${field} 必须是正整数。`);
  }
  return value;
}

export function exactTrue(value, field) {
  if (value !== true) fail(`${field} 必须在外部验收完成后显式设为 true。`);
  return true;
}

export function digestReference(value, field) {
  const parsed = string(value, field, 512);
  if (!/^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/.test(parsed)) {
    fail(`${field} 必须使用小写 SHA-256 digest 固定镜像。`);
  }
  return parsed;
}

export async function readTrustedJson(path, field, options = {}) {
  const canonical = absolutePath(path, field);
  const [resolved, stats] = await Promise.all([realpath(canonical), lstat(canonical)]);
  if (
    resolved !== canonical || !stats.isFile() || stats.isSymbolicLink() ||
    stats.size <= 0 || stats.size > (options.maxBytes ?? 1024 * 1024) ||
    (stats.mode & 0o022) !== 0
  ) {
    fail(`${field} 必须是可信、非符号链接且不可由组或其他用户写入的文件。`);
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(canonical, 'utf8'));
  } catch {
    fail(`${field} 不是有效 JSON。`);
  }
  return { path: canonical, value: parsed, stats };
}

export async function requireTrustedFile(path, field, options = {}) {
  const canonical = absolutePath(path, field);
  const [resolved, stats] = await Promise.all([realpath(canonical), lstat(canonical)]);
  if (
    resolved !== canonical || !stats.isFile() || stats.isSymbolicLink() ||
    (stats.mode & (options.private === true ? 0o077 : 0o022)) !== 0
  ) {
    fail(`${field} 必须是可信的非符号链接文件。`);
  }
  return canonical;
}

export async function requireExecutable(path, field) {
  const canonical = absolutePath(path, field);
  await access(canonical, constants.X_OK);
  if ((await realpath(canonical)) !== canonical || (await lstat(canonical)).isSymbolicLink()) {
    fail(`${field} 必须是规范化的非符号链接可执行文件。`);
  }
  return canonical;
}

export function parseEntrypointArgs(argv, supportedActions) {
  let configPath = null;
  let action = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--' && index === 0) continue;
    if (argument === '--config') {
      if (configPath !== null || !argv[index + 1]) fail('--config 只能指定一次。');
      configPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) {
      const candidate = argument.slice(2);
      if (!supportedActions.includes(candidate) || action !== null) {
        fail('必须且只能指定一个受支持的操作。');
      }
      action = candidate;
      continue;
    }
    fail(`未知参数：${argument}`);
  }
  if (!configPath || !action) {
    fail(`用法：--config <绝对路径> ${supportedActions.map((value) => `--${value}`).join('|')}`);
  }
  return { configPath: resolve(configPath), action };
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function safeErrorMessage(error) {
  if (error instanceof Error && error.message && !/[\u0000-\u001f\u007f]/u.test(error.message)) {
    return error.message.slice(0, 1000);
  }
  return '部署操作失败；详细输入已隐藏。';
}
