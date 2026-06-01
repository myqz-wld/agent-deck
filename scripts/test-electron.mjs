#!/usr/bin/env node
/**
 * 在 Electron-as-node 下跑 vitest —— 让 better-sqlite3 SQLite 单测「真跑不 skip」。
 *
 * 背景（plan sqlite-tests-no-skip-20260601 / CHANGELOG_42 教训）：
 *   - app 跑 Electron 33 → better-sqlite3 装的是 ABI v130（NODE_MODULE_VERSION 130）binding
 *   - vitest 默认跑在系统 node（v24 = ABI 137 / nvm v20 = ABI 115）→ 加载 ABI-130 binding 失败
 *     → 12 个 SQLite 单测文件 describe.skipIf(!bindingAvailable) 全 skip（200 用例）
 *   - prebuild-install 重 rebuild binding 会覆盖 Electron binding 导致 app bootstrap 挂（CHANGELOG_42）
 *
 * 方案 A（本脚本）：用 Electron 内置 node（v20.18.3 / **ABI 130**，正好匹配现装 binding）跑 vitest。
 *   `ELECTRON_RUN_AS_NODE=1 <electron 二进制> node_modules/vitest/vitest.mjs run ...`
 *   → **零 binding swap、零 corruption**（不碰 build/Release/better_sqlite3.node）→ SQLite 单测真跑。
 *
 * 用法：
 *   pnpm test                 # = node scripts/test-electron.mjs
 *   pnpm test <file/pattern>  # 透传给 vitest，如 pnpm test src/main/store/__tests__/task-repo.test.ts
 *
 * 对照变体：pnpm test:node（系统 node 跑 vitest，SQLite 单测优雅 skip + loud warn，非 SQLite 快速迭代用）。
 *
 * ⚠️ 本脚本必须放 repo 内 scripts/：createRequire(import.meta.url) 从脚本所在位置解析 'electron'，
 *    放 /tmp 会 MODULE_NOT_FOUND（plan §已知踩坑 实证）。
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
// require('electron') 返回 Electron 二进制的绝对路径字符串（@electron/get 安装时写入）。
const electronPath = require('electron');

// repo root = 本脚本父目录（scripts/）的上一级。固定 cwd 让 vitest 无论从哪调用都能解析 vitest.config.ts。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const vitestEntry = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');
const forwardedArgs = process.argv.slice(2);

const res = spawnSync(electronPath, [vitestEntry, 'run', ...forwardedArgs], {
  cwd: repoRoot,
  stdio: 'inherit', // 让 vitest 输出直达终端（spawnSync 默认 pipe→内存，大输出撞 ENOBUFS 截断）
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

// spawn 自身失败（electron 二进制缺失 / 无执行权限等）→ res.status 为 null，显式报错退 1。
if (res.error) {
  console.error('[test-electron] failed to spawn Electron-as-node:', res.error);
  process.exit(1);
}

// 透传 vitest 退出码（status=null 表示被 signal 终止 → 按 1）。
// 不透传 = wrapper 恒退出 0 = 任何 test 挂都假绿（plan §wrapper 必备契约）。
process.exit(res.status ?? 1);
