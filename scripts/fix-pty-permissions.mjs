#!/usr/bin/env node
// scripts/fix-pty-permissions.mjs
//
// node-pty 1.1.0 在 darwin / linux 走 prebuilds/<platform>-<arch>/spawn-helper 这个独立
// 二进制做 posix_spawnp。pnpm install 时 hard-link 拷贝可能丢 +x 位（实测 -rw-r--r--）→
// 第一次 createSession 直接报 `posix_spawnp failed`。
//
// 这里在 postinstall 里 chmod 0o755 兜底（与 GenericPtyBridge.ensureSpawnHelperExecutable
// 双层防御）。win32 不需要（spawn-helper 是 unix 专属）。
//
// 失败不抛（best-effort）：
// - 路径不存在（其它 platform / 未装 node-pty）→ silent
// - 权限设置失败 → warn 但不 throw（让 install 流程继续；runtime 还有 GenericPtyBridge 兜底）

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

if (process.platform === 'win32') {
  process.exit(0); // win32 PTY 走 ConPTY，不需要 spawn-helper
}

async function main() {
  let ptyEntry;
  try {
    // 从 repo root 解析 node-pty 入口
    ptyEntry = require.resolve('node-pty', { paths: [path.resolve(__dirname, '..')] });
  } catch (err) {
    // 还没装 node-pty / dev 早期阶段 → silent
    return;
  }

  const ptyPkgRoot = path.resolve(path.dirname(ptyEntry), '..');
  const helperPath = path.join(
    ptyPkgRoot,
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  );
  try {
    await fsp.access(helperPath);
    await fsp.chmod(helperPath, 0o755);
    console.log(`[fix-pty-permissions] chmod +x ${helperPath}`);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // prebuilt 不在这个 platform → silent
      return;
    }
    console.warn(`[fix-pty-permissions] chmod failed: ${err && err.message}`);
  }
}

await main();
