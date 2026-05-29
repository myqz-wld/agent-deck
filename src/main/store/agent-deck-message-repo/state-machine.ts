/**
 * agent-deck-message-repo state-machine 子模块 — 6 method 状态机迁移。
 *
 * 拆分自 `agent-deck-message-repo.ts` 527 LOC（Phase 4 Step 4.11）。
 *
 * 状态机（ADR §4.3）：
 *   pending → claim → delivering →
 *     ↓ success: delivered (terminal)
 *     ↓ throw:   pending (attempt_count++ + last_attempt_at=now) | failed (>= MAX_RETRY)
 *   或 cancelled (terminal, 来自显式 cancel API)
 *
 * 域职责：
 * - claim：pending → delivering 原子化抢占（UPDATE ... RETURNING *）
 * - markDelivered：pending/delivering → delivered（spawn_session 路径捷径 mark）
 * - markFailed：pending/delivering → failed（caller 主动放弃）
 * - retryAfterFail：delivering → pending 退避后重试，到 MAX_RETRY → failed
 * - cancel：pending/delivering → cancelled（lead 撤回 / team archive 兜底）
 * - resetDeliveringOnStartup：crash recovery，把卡 delivering 的行重置 pending（不 ++attempt_count）
 *
 * 4 method（markDelivered/markFailed/retryAfterFail/cancel）UPDATE 后调 _deps.getById 反查最新 row。
 */
import type { Database } from 'better-sqlite3';
import type { AgentDeckMessage } from '@shared/types';
import { MAX_RETRY } from '@main/store/message-delivery-state';
import { getById, rowToRecord, type MessageRow } from './_deps';

export function createStateMachine(db: Database) {
  function claim(messageId: string, now: number): AgentDeckMessage | null {
    // RETURNING 在 better-sqlite3 + sqlite 3.35+ 支持
    const updated = db
      .prepare(
        `UPDATE agent_deck_messages
         SET status = 'delivering', delivering_since = ?, last_attempt_at = ?
         WHERE id = ? AND status = 'pending'
         RETURNING *`,
      )
      .get(now, now, messageId) as MessageRow | undefined;
    return updated ? rowToRecord(updated) : null;
  }

  function markDelivered(messageId: string, now: number): AgentDeckMessage | null {
    // REVIEW_32 HIGH-1：接纳 status='pending' OR 'delivering'。
    // spawn_session 路径在 SDK createSession 已经投过 prompt，紧接着 insert placeholder
    // (status='pending') + markDelivered 做「捷径 mark 为 delivered，watcher 不再重投」。
    // 旧 SQL 仅匹配 'delivering' → spawn 路径 100% no-op → universal-message-watcher 250ms
    // poll 命中 (pending, last_attempt_at IS NULL) → 二次投递（teammate 跑完首条 prompt 后立刻
    // 又收到一份 wireBody = `[from <name>][msg <id>]\n` + 原 body）。fix：放宽 status 集合。
    const result = db
      .prepare(
        `UPDATE agent_deck_messages
         SET status = 'delivered', delivered_at = ?, status_reason = NULL,
             delivering_since = NULL
         WHERE id = ? AND status IN ('pending', 'delivering')`,
      )
      .run(now, messageId);
    if (result.changes === 0) return null;
    return getById(db, messageId);
  }

  function markFailed(messageId: string, reason: string): AgentDeckMessage | null {
    // 允许从 delivering / pending 任一态进 failed（caller 主动放弃）
    const result = db
      .prepare(
        `UPDATE agent_deck_messages
         SET status = 'failed', status_reason = ?, delivering_since = NULL
         WHERE id = ? AND status IN ('pending', 'delivering')`,
      )
      .run(reason, messageId);
    if (result.changes === 0) return null;
    return getById(db, messageId);
  }

  function retryAfterFail(messageId: string, reason: string, now: number): AgentDeckMessage | null {
    // 只能从 delivering 退回 pending（claim 后失败）
    const cur = db
      .prepare(`SELECT * FROM agent_deck_messages WHERE id = ?`)
      .get(messageId) as MessageRow | undefined;
    if (!cur) return null;
    if (cur.status !== 'delivering') return null;

    const newAttemptCount = cur.attempt_count + 1;
    if (newAttemptCount >= MAX_RETRY) {
      // REVIEW_61 LOW-α (codex) fix: final retry 真到 MAX_RETRY 时,markFailed 旧实现只更新
      // status/status_reason/delivering_since 不更新 attempt_count → DB 列停在 cur.attempt_count
      // (typically 2),与 status_reason 字符串里写的 `attempt=3` 不一致。失败消息的结构化
      // attemptCount 字段和可读 reason 分裂,UI / 诊断 / 后续审计低报一次尝试。
      // 改成单条 UPDATE 同时写 attempt_count + status + status_reason + delivering_since。
      const result = db
        .prepare(
          `UPDATE agent_deck_messages
           SET status = 'failed', status_reason = ?,
               attempt_count = ?, delivering_since = NULL
           WHERE id = ? AND status IN ('pending', 'delivering')`,
        )
        .run(`retry-exhausted (attempt=${newAttemptCount}): ${reason}`, newAttemptCount, messageId);
      if (result.changes === 0) return null;
      return getById(db, messageId);
    }
    db.prepare(
      `UPDATE agent_deck_messages
       SET status = 'pending', attempt_count = ?, last_attempt_at = ?,
           status_reason = ?, delivering_since = NULL
       WHERE id = ? AND status = 'delivering'`,
    ).run(newAttemptCount, now, reason, messageId);
    return getById(db, messageId);
  }

  function cancel(messageId: string, reason: string): AgentDeckMessage | null {
    // 仅可从 pending / delivering 进 cancelled；terminal 态拒
    const result = db
      .prepare(
        `UPDATE agent_deck_messages
         SET status = 'cancelled', status_reason = ?, delivering_since = NULL
         WHERE id = ? AND status IN ('pending', 'delivering')`,
      )
      .run(reason, messageId);
    if (result.changes === 0) return null;
    return getById(db, messageId);
  }

  function resetDeliveringOnStartup(): number {
    const result = db
      .prepare(
        `UPDATE agent_deck_messages
         SET status = 'pending',
             status_reason = 'recovered-from-delivering (process restart)',
             delivering_since = NULL
         WHERE status = 'delivering'`,
      )
      .run();
    return result.changes;
  }

  return {
    claim,
    markDelivered,
    markFailed,
    retryAfterFail,
    cancel,
    resetDeliveringOnStartup,
  };
}
