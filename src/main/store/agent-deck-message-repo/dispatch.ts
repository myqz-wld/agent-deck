/**
 * agent-deck-message-repo dispatch 子模块 — 3 method watcher 配对查询。
 *
 * 拆分自 `agent-deck-message-repo.ts` 527 LOC（Phase 4 Step 4.11）。
 *
 * 域职责：
 * - findEligible：watcher tick 取 batch（status='pending' + backoff 表达式）
 * - findEligibleExcludingTargets：cross-target starvation 公平兜底
 *   （REVIEW_56 Batch C R1 codex MED-2 修法）
 * - countPendingForTarget：per-target backpressure 计数（pending + delivering）
 *
 * 本子模块不依赖其他子模块；backoff WHERE 子句从 message-delivery-state.ts BACKOFF_TIERS 派生。
 */
import type { Database } from 'better-sqlite3';
import type { AgentDeckMessage } from '@shared/types';
import { buildFindEligibleWhereSql } from '@main/store/message-delivery-state';
import {
  rowToRecord,
  type FindEligibleExcludingTargetsOptions,
  type FindEligibleOptions,
  type MessageRow,
} from './_deps';

export function createDispatch(db: Database) {
  function findEligible(opts: FindEligibleOptions): AgentDeckMessage[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 16, 100));
    // backoff WHERE 子句从 message-delivery-state.ts BACKOFF_TIERS 表派生（CHANGELOG_109 R37
    // P2-N Step 3.6 codex 11 LOW SSOT）。改 backoff schedule 只动 BACKOFF_TIERS 数组，本处
    // 自动跟着对（每 tier 一个 ? placeholder 绑 now）。详 buildFindEligibleWhereSql jsdoc。
    const { whereSql, backoffPlaceholderCount } = buildFindEligibleWhereSql();
    const sql = `
      SELECT * FROM agent_deck_messages
      WHERE status = 'pending'
        AND (
          ${whereSql}
        )
      ORDER BY sent_at ASC
      LIMIT ?`;
    const params: number[] = [];
    for (let i = 0; i < backoffPlaceholderCount; i++) params.push(opts.now);
    params.push(limit);
    const rows = db.prepare(sql).all(...params) as MessageRow[];
    return rows.map(rowToRecord);
  }

  function findEligibleExcludingTargets(
    opts: FindEligibleExcludingTargetsOptions,
  ): AgentDeckMessage | null {
    // REVIEW_56 Batch C R1 codex MED-2 修法:与 findEligible 同款 backoff WHERE 子句,
    // 额外加 `to_session_id NOT IN (?, ?, ?)` 排除当前 batch 已选 targets,LIMIT 1 取最早。
    // excludeTargets 空数组 → NOT IN () SQL 语法非法,fallback 走纯 findEligible LIMIT 1
    // 等价路径(本 helper 仍要返单条而非数组,所以 take rows[0] ?? null)。
    const { whereSql, backoffPlaceholderCount } = buildFindEligibleWhereSql();
    const params: (number | string)[] = [];
    for (let i = 0; i < backoffPlaceholderCount; i++) params.push(opts.now);

    let excludeClause = '';
    if (opts.excludeTargets.length > 0) {
      const placeholders = opts.excludeTargets.map(() => '?').join(', ');
      excludeClause = `AND to_session_id NOT IN (${placeholders})`;
      for (const t of opts.excludeTargets) params.push(t);
    }

    const sql = `
      SELECT * FROM agent_deck_messages
      WHERE status = 'pending'
        AND (
          ${whereSql}
        )
        ${excludeClause}
      ORDER BY sent_at ASC
      LIMIT 1`;
    const rows = db.prepare(sql).all(...params) as MessageRow[];
    return rows.length > 0 ? rowToRecord(rows[0]) : null;
  }

  function countPendingForTarget(toSessionId: string): number {
    const row = db
      .prepare(
        `SELECT count(*) AS c FROM agent_deck_messages
         WHERE to_session_id = ? AND status IN ('pending', 'delivering')`,
      )
      .get(toSessionId) as { c: number };
    return row.c;
  }

  return { findEligible, findEligibleExcludingTargets, countPendingForTarget };
}
