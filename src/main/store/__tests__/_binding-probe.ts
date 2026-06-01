/**
 * better-sqlite3 binding probe SSOT（plan sqlite-tests-no-skip-20260601 D3）。
 *
 * 单一定义点取代原先散落 6 处的 `probeBetterSqliteBinding`（2 个 _setup.ts +
 * 4 个 inline test）。所有 SQLite 真测文件 import 本模块的 `bindingAvailable`
 * 做 `describe.skipIf(!bindingAvailable)` 守门。
 *
 * ── runtime 要求 ──
 * better-sqlite3 装的是 Electron ABI v130 binding（app 跑 Electron 33）。
 * - `pnpm test`（= scripts/test-electron.mjs，Electron-as-node v20.18.3 / ABI 130）→ 加载成功 → 守门恒 false → 真跑
 * - `pnpm test:node`（系统 node，ABI 不匹配）→ 加载失败 → 守门 true → 优雅 skip + loud warn
 *
 * 守门是**安全网**（用户决策保留）：binding 恒可用时不 skip；用错 runtime 时 skip
 * 而非整套 crash，并 loud warn 告诉开发者怎么修。
 */
import Database from 'better-sqlite3';

function probeBetterSqliteBinding(): boolean {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch (e) {
    // loud error（非 warn）：明确告诉开发者用错 runtime + 怎么修。
    console.error(
      `[binding-probe] better-sqlite3 binding 不可用 —— 跳过全部 SQLite 真测。` +
        `原因：${e instanceof Error ? e.message : String(e)}\n` +
        `  这通常是 runtime ABI 不匹配（binding 是 Electron ABI v130）。` +
        `请跑 \`pnpm test\`（Electron-as-node，ABI 130 匹配）而非 \`pnpm test:node\`（系统 node ABI 不匹配）。`,
    );
    return false;
  }
}

/** SQLite 真测守门标志：true = binding 可加载（真跑），false = 用错 runtime（skip）。 */
export const bindingAvailable = probeBetterSqliteBinding();
