/**
 * spawn-helper 权限兜底（CHANGELOG_82 Step 3.1 Tier 2 拆分）。
 *
 * CLAUDE.md「打包配置已踩的坑」同款 native binding 处理：node-pty 1.1.0 在
 * darwin/linux 走 `prebuilds/<platform>-<arch>/spawn-helper` 这个独立二进制做
 * posix_spawnp。pnpm install 拷贝时 hard-link 可能丢 +x 位（实测 -rw-r--r--）
 * → posix_spawnp failed。
 *
 * promise 单飞机制（GenericPtyBridge.spawnHelperReady）保留在 class 内：多次
 * createSession 共享同一个等待 promise（REVIEW_24 MED-Claude5 修：boolean →
 * promise 单飞消除 race window）。本 helper 只做实际 chmod 0o755 操作，class facade
 * 负责 dedup。
 *
 * 失败不抛（设为 best-effort）：如果 helper 真不存在 / 权限重置失败，spawn 路径会
 * 报 posix_spawnp failed，由 createSession throw 包装传上层。
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

/**
 * 实际 chmod 0o755 spawn-helper 二进制。
 *
 * @param adapterId 仅用于错误日志前缀区分 'generic-pty' / 'aider'。
 */
export async function chmodSpawnHelper(adapterId: 'generic-pty' | 'aider'): Promise<void> {
  try {
    // node-pty native binding 路径：与 lib/utils.js 内 native.dir + '/spawn-helper' 同款。
    // require.resolve('node-pty') 拿 lib/index.js 路径；上回到包根；拼 prebuilds/<platform>-<arch>。
    const ptyEntry = require.resolve('node-pty');
    const ptyPkgRoot = path.resolve(path.dirname(ptyEntry), '..');
    const helperPath = path.join(
      ptyPkgRoot,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    );
    // REVIEW_24 MED-Claude3：用 regex 锚定路径段（与 sdk-runtime.ts:87 同款）替代裸
    // String.replace。裸 replace 的 case 2/3 误匹配：`app.asar.unpacked` → `app.asar.unpacked.unpacked`、
    // 用户路径含 `app.asar` 子串如 `/Users/foo/my-app.asar.fork/...` → `/Users/foo/my-app.asar.unpacked.fork/...`。
    const unpackedPath = helperPath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    await fsp.chmod(unpackedPath, 0o755).catch(() => {
      // 路径不存在（其他平台 / 未打包）→ silent
    });
  } catch (err) {
    // require.resolve 失败 / 路径拼错 → silent
    console.warn(`[generic-pty:${adapterId}] ensureSpawnHelperExecutable 失败`, err);
  }
}
