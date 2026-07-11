/**
 * session-repo —— archive setter（与 lifecycle 正交，独立文件呼应 CLAUDE.md
 * 「lifecycle 与 archived_at 正交」核心约定）。
 *
 * 拆分历史：从 src/main/store/session-repo.ts 抽出（CHANGELOG_83 / plan
 * deep-review-and-split-20260513 H2 Step 2.3）。
 *
 * archive-toctou-fix-20260515 plan(REVIEW_42 §已知 follow-up MED race + LOW probe-throw):
 * UPDATE 检查 .changes === 1,缺失 row → throw `SessionRowMissingError` 让 caller 链 ground truth
 * 感知 row 在 sync 探针后到 setter 之间的 race window 内被外部删 (lifecycle scheduler purge /
 * 用户手动 close / DB reaper 任一)。caller 链通过 `instanceof SessionRowMissingError` 判别
 * 区分 row-missing vs archive-throw,反射准确的 reasonKind 给 UI。
 *
 * R1 双方共识 (reviewer-claude + reviewer-codex):
 * - SQL 单点 setter throw 是 SSOT 修法,所有 caller 通过 throw 自然感知,未来若有代码绕过
 *   `sessionManager.archive` 直接调 `sessionRepo.setArchived` (新模块 / refactor),bug 不会回
 * - 同时修 archive + unarchive 同款 race(setArchived 是两条路径共用 setter)
 * - 必须用可识别错误 (SessionRowMissingError),否则 catch-all 把 setter no-op 误归 'archive-throw'
 *   reasonKind,UX 显示「可重试」误导(row 真不存在重试无效,应归 'row-missing' 仅告知)
 */

import { getDb } from '../db';

/**
 * setArchived no-op 异常 — UPDATE 对缺失 row affected rows = 0 时抛出。
 *
 * caller 链通过 `err instanceof SessionRowMissingError` 判别:
 * - true → reasonKind='row-missing' (row 真不存在,重试无效,UI 仅告知;K3 IPC SessionArchive
 *   handler 视为幂等静默 return true,因为「row 已不在」等价「已归档」无害)
 * - false → reasonKind='archive-throw' (row 存在但 archive 失败,FK constraint / DB locked 等,
 *   UI 显示「重试归档」按钮)
 *
 * 不 export 给非 archive caller 链使用 — 仅 baton-cleanup helper / session-hand-off-finalize /
 * ipc SessionArchive handler 需要 instanceof 判别。
 */
export class SessionRowMissingError extends Error {
  readonly name = 'SessionRowMissingError';
  constructor(id: string) {
    super(
      `setArchived no-op: session ${id} not found in sessions table ` +
        `(probe 后 row 被外部删 - lifecycle scheduler purge / 用户手动 close / DB reaper)`,
    );
  }
}

/**
 * 标记归档（ts=null 表示取消归档）。lifecycle 不动，保留原始生命周期。
 *
 * 严格按 CLAUDE.md「lifecycle (active/dormant/closed) 与 archived_at 正交」原则：
 * - 归档不改 lifecycle，取消归档也不强行重置 lifecycle
 * - 业务联动（如 0-lead team auto-archive）由更高层 service（manager.ts）触发，
 *   repo 层只做 SQL 单点 update
 *
 * archive-toctou-fix-20260515 plan: UPDATE 后检查 result.changes === 1,缺失 row → throw
 * SessionRowMissingError。让 caller 链感知 sync probe 后 race window 内 row 被外部删的边界。
 * 详见本 module 顶部 jsdoc 的修法理由。
 */
export function setArchived(id: string, ts: number | null): void {
  const result =
    ts === null
      ? getDb().prepare(`UPDATE sessions SET archived_at = NULL WHERE id = ?`).run(id)
      : getDb()
          .prepare(`UPDATE sessions SET archived_at = ?, pinned_at = NULL WHERE id = ?`)
          .run(ts, id);
  if (result.changes !== 1) {
    throw new SessionRowMissingError(id);
  }
}
