/**
 * agent-deck-message-repo gc 子模块 — retention GC 两 method（plan message-retention-and-index-20260602）。
 *
 * 与 crud / dispatch / state-machine 同款 factory pattern（Phase 4 Step 4.11）。
 *
 * 域职责（§D7）：
 * - listExpiredForGc：取超期 terminal 消息 id（走 v030 partial index，LIMIT early-stop 无 temp sort）
 * - batchHardDelete：单事务批量物理删（reply_to 自引用 FK ON DELETE SET NULL 自动断链）
 *
 * 由 MessageLifecycleScheduler（store/message-lifecycle-scheduler.ts）6h tick 调用。
 */
import type { Database } from 'better-sqlite3';
import type { ListExpiredForGcOptions } from './_deps';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * GC 单轮批量上限 SSOT（impl-review R claude INFO-1）：listExpiredForGc 内 Math.min cap +
 * MessageLifecycleScheduler 的 hitLimit 判定共用此常量，消除「repo cap 500 vs scheduler
 * gcBatchLimit default 500」两处硬编码耦合——否则有人给 scheduler 传 gcBatchLimit>500 时
 * repo 仍只返 ≤500，`ids.length >= gcBatchLimit` 永 false → 有积压也不排 catch-up，GC 退化成
 * 每 6h 只删 500 永远追不上。两边引用同常量即不会漂移。
 */
export const GC_BATCH_LIMIT = 500;

/**
 * GC 主查询 SQL（export const 让 Step 7 test 能 EXPLAIN **本常量**而非测试自写查询——
 * Deep-Review R2 claude LOW：否则 gc.ts 侧 literal 漂移无回归守护，HIGH-1 bug 可静默复活而全测绿）。
 *
 * ⚠️ `status IN ('delivered', 'failed', 'cancelled')` 必须与 v030 partial index
 * idx_messages_terminal_sent_at 的 WHERE **字面同序同值**才命中部分索引（codex R2 实测 +
 * impl-review 双方 sqlite3 复测：不带 hint 参数化 IN(?,?,?) / 单值 / IN 顺序不同 → 退化到
 * **另一索引 idx_messages_status_last_attempt 的 SEARCH + TEMP B-TREE**（非全表 SCAN，但同样
 * 全排 backlog 破 500 预算）；带 INDEXED BY hint + 参数化则直接 `no query solution` 硬报错）。
 * 故 status 三值**内联硬编码**，仅 `?`（threshold）/ `?`（limit）参数化。改动此 SQL 时务必
 * 与 v030_agent_deck_messages_indexes.sql 的 partial WHERE 同步（跨文件 literal 重复无 SSOT，
 * Step 7 EXPLAIN 断言锁死漂移）。
 *
 * ⚠️⚠️ `INDEXED BY idx_messages_terminal_sent_at` 强制 hint 必须有（实施期 SQLite 真测发现）：
 * 本表另有 v010 既有索引 idx_messages_status_last_attempt(status, last_attempt_at)，也能服务
 * `status IN (...)` 谓词。**生产 DB 从不跑 ANALYZE**（db.ts / migrations 无），缺统计信息时 SQLite
 * optimizer 偏好 status 等值索引（status_last_attempt）→ 走它 + USE TEMP B-TREE 全排 backlog，
 * 恰好退回 codex HIGH-1 要修的破 500 预算行为（即便 partial index 已建）。实测：无 ANALYZE 选
 * status_last_attempt + temp sort；ANALYZE 后才选 partial。`INDEXED BY` 是 SQLite 查询 hint，
 * 不依赖统计信息强制走 partial → 无 ANALYZE 也无 temp sort。代价：索引被删/改名 → 查询 fail-loud
 * 报错（非静默退化），对 GC 关键查询是优点（v030 test 锁索引存在）。
 *
 * ORDER BY sent_at ASC：删最旧的先（沿 partial index 序，LIMIT 早停）。rowid ASC 二级定序锁
 * 同毫秒 sent_at tie 稳定（分页/批次边界确定，与 listByTeam/findEligible 同款 REVIEW_90 纪律）。
 */
export const LIST_EXPIRED_FOR_GC_SQL = `
  SELECT id FROM agent_deck_messages INDEXED BY idx_messages_terminal_sent_at
  WHERE status IN ('delivered', 'failed', 'cancelled')
    AND sent_at < ?
  ORDER BY sent_at ASC, rowid ASC
  LIMIT ?
`;

export function createGc(db: Database) {
  function listExpiredForGc(opts: ListExpiredForGcOptions): string[] {
    // scheduler 在 retentionDays<=0 时早退不调本方法；防御性再夹一层（负/0 阈值 → 空结果，
    // 不会把 threshold 算成未来时间误删全部）。
    if (opts.retentionDays <= 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? GC_BATCH_LIMIT, GC_BATCH_LIMIT));
    const threshold = opts.now - opts.retentionDays * DAY_MS;
    const rows = db.prepare(LIST_EXPIRED_FOR_GC_SQL).all(threshold, limit) as { id: string }[];
    return rows.map((r) => r.id);
  }

  function batchHardDelete(ids: readonly string[]): string[] {
    if (ids.length === 0) return [];
    // defense-in-depth（Deep-Review R1 claude INFO）：DELETE WHERE 带 terminal status guard。
    // terminal 是吸收态（state-machine 6 UPDATE 全要求 pending/delivering），listExpiredForGc 选中
    // 到此删除之间不会复活，by-id 删本就安全；带上 status guard 是双保险零成本（万一未来有人
    // 在 list↔delete 间隙改状态，也只删仍 terminal 的，绝不误删 pending/delivering 在途消息 N4）。
    //
    // impl-review claude INFO-4 简化：用 del.run(id).changes 直接判定是否删除（status guard 已在
    // DELETE WHERE 内），省去 exists pre-check 的一半 query（单事务内 ≤500 次 vs 原 ≤1000 次）。
    const del = db.prepare(
      `DELETE FROM agent_deck_messages
       WHERE id = ? AND status IN ('delivered', 'failed', 'cancelled')`,
    );
    const removed: string[] = [];
    const tx = db.transaction(() => {
      for (const id of ids) {
        if (del.run(id).changes > 0) removed.push(id);
      }
    });
    tx();
    return removed;
  }

  return { listExpiredForGc, batchHardDelete };
}
