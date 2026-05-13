/**
 * session-repo —— archive setter（与 lifecycle 正交，独立文件呼应 CLAUDE.md
 * 「lifecycle 与 archived_at 正交」核心约定）。
 *
 * 拆分历史：从 src/main/store/session-repo.ts 抽出（CHANGELOG_83 / plan
 * deep-review-and-split-20260513 H2 Step 2.3）。
 */

import { getDb } from '../db';

/**
 * 标记归档（ts=null 表示取消归档）。lifecycle 不动，保留原始生命周期。
 *
 * 严格按 CLAUDE.md「lifecycle (active/dormant/closed) 与 archived_at 正交」原则：
 * - 归档不改 lifecycle，取消归档也不强行重置 lifecycle
 * - 业务联动（如 0-lead team auto-archive）由更高层 service（manager.ts）触发，
 *   repo 层只做 SQL 单点 update
 */
export function setArchived(id: string, ts: number | null): void {
  getDb().prepare(`UPDATE sessions SET archived_at = ? WHERE id = ?`).run(ts, id);
}
