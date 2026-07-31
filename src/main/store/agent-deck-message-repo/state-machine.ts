/**
 * agent-deck-message-repo state-machine 子模块 — 6 method 状态机迁移。
 *
 * 拆分自 `agent-deck-message-repo.ts` 527 LOC（Phase 4 Step 4.11）。
 *
 * 状态机（ADR §4.3）：
 *   pending → claim → delivering →
 *     ↓ success: delivered (terminal)
 *     ↓ definite pre-acceptance rejection:
 *                pending (attempt_count++ + last_attempt_at=now) | failed (>= MAX_RETRY)
 *     ↓ restart with unknown outcome: failed (terminal, at-most-once)
 *   或 cancelled (terminal, 来自显式 cancel API)
 *
 * 域职责：
 * - claim：pending → delivering 原子化抢占（UPDATE ... RETURNING *）
 * - markDelivered：pending shortcut 或 matching delivering lease → delivered
 * - markFailed：pending caller failure 或 matching delivering lease → failed
 * - retryAfterFail：delivering → pending 退避后重试，到 MAX_RETRY → failed
 * - cancel：pending → cancelled；claimed adapter calls must finish or drain
 * - terminalizeDeliveringOnStartup：at-most-once recovery，把不确定 delivering 终止为 failed
 *
 * 4 method（markDelivered/markFailed/retryAfterFail/cancel）UPDATE 后调 _deps.getById 反查最新 row。
 */
import type { Database } from 'better-sqlite3';
import type { AgentDeckMessage } from '@shared/types';
import {
  MAX_RETRY,
  UNCERTAIN_DELIVERY_ON_RESTART_REASON,
} from '@main/store/message-delivery-state';
import {
  getById,
  rowToRecord,
  type MessageDeliveryLease,
  type MessageRow,
} from './_deps';

/** Transaction-compatible pending-only ownership move used by handoff resource transfer. */
export function retargetPendingMessagesForHandOffWithDb(
  db: Database,
  sourceSessionId: string,
  successorSessionId: string,
): number {
  if (sourceSessionId === successorSessionId) return 0;
  return db.prepare(
    `UPDATE agent_deck_messages
        SET from_session_id = CASE WHEN from_session_id = ? THEN ? ELSE from_session_id END,
            to_session_id = CASE WHEN to_session_id = ? THEN ? ELSE to_session_id END,
            delivery_generation = delivery_generation + 1,
            delivery_lease_to_session_id = NULL
      WHERE (from_session_id = ? OR to_session_id = ?)
        AND status = 'pending'`,
  ).run(
    sourceSessionId,
    successorSessionId,
    sourceSessionId,
    successorSessionId,
    sourceSessionId,
    sourceSessionId,
  ).changes;
}

export function countDeliveringMessagesForSessionWithDb(
  db: Database,
  sessionId: string,
): number {
  const row = db.prepare(
    `SELECT count(*) AS c
       FROM agent_deck_messages
      WHERE status = 'delivering'
        AND (from_session_id = ? OR to_session_id = ?)`,
  ).get(sessionId, sessionId) as { c: number };
  return row.c;
}

export function countDeliveringMessagesWithDb(db: Database): number {
  const row = db.prepare(
    `SELECT count(*) AS c
       FROM agent_deck_messages
      WHERE status = 'delivering'`,
  ).get() as { c: number };
  return row.c;
}

export function createStateMachine(db: Database) {
  function claim(messageId: string, now: number): AgentDeckMessage | null {
    // RETURNING 在 better-sqlite3 + sqlite 3.35+ 支持
    const updated = db
      .prepare(
        `UPDATE agent_deck_messages
         SET status = 'delivering', delivering_since = ?, last_attempt_at = ?,
             delivery_generation = delivery_generation + 1,
             delivery_lease_to_session_id = to_session_id
         WHERE id = ? AND status = 'pending'
         RETURNING *`,
      )
      .get(now, now, messageId) as MessageRow | undefined;
    return updated ? rowToRecord(updated) : null;
  }

  function markDelivered(
    messageIdOrLease: string | MessageDeliveryLease,
    now: number,
  ): AgentDeckMessage | null {
    // Spawn placeholders still need a pending shortcut; watcher completions require a lease.
    // spawn_session 路径在 SDK createSession 已经投过 prompt，紧接着 insert placeholder
    // (status='pending') + markDelivered 做「捷径 mark 为 delivered，watcher 不再重投」。
    // 旧 SQL 仅匹配 'delivering' → spawn 路径 100% no-op → universal-message-watcher 250ms
    // poll 命中 (pending, last_attempt_at IS NULL) → 二次投递（teammate 跑完首条 prompt 后立刻
    // 又收到一份 wireBody = `[from <name>][msg <id>]\n` + 原 body）。字符串路径仅匹配 pending，
    // 防止 delivering row 绕过 destination + generation CAS。
    const lease = typeof messageIdOrLease === 'string' ? null : messageIdOrLease;
    const result = lease
      ? db.prepare(
        `UPDATE agent_deck_messages
         SET status = 'delivered', delivered_at = ?, status_reason = NULL,
             delivering_since = NULL, delivery_lease_to_session_id = NULL
         WHERE id = ? AND status = 'delivering'
           AND to_session_id = ? AND delivery_lease_to_session_id = ?
           AND delivery_generation = ?`,
      ).run(
        now,
        lease.messageId,
        lease.toSessionId,
        lease.toSessionId,
        lease.generation,
      )
      : db.prepare(
        `UPDATE agent_deck_messages
         SET status = 'delivered', delivered_at = ?, status_reason = NULL,
             delivering_since = NULL, delivery_lease_to_session_id = NULL
         WHERE id = ? AND status = 'pending'`,
      ).run(now, messageIdOrLease);
    if (result.changes === 0) return null;
    const messageId = lease ? lease.messageId : messageIdOrLease as string;
    return getById(db, messageId);
  }

  function markFailed(
    messageIdOrLease: string | MessageDeliveryLease,
    reason: string,
  ): AgentDeckMessage | null {
    const lease = typeof messageIdOrLease === 'string' ? null : messageIdOrLease;
    const result = lease
      ? db.prepare(
        `UPDATE agent_deck_messages
         SET status = 'failed', status_reason = ?, delivering_since = NULL,
             delivery_lease_to_session_id = NULL
         WHERE id = ? AND status = 'delivering'
           AND to_session_id = ? AND delivery_lease_to_session_id = ?
           AND delivery_generation = ?`,
      ).run(
        reason,
        lease.messageId,
        lease.toSessionId,
        lease.toSessionId,
        lease.generation,
      )
      : db.prepare(
        `UPDATE agent_deck_messages
         SET status = 'failed', status_reason = ?, delivering_since = NULL,
             delivery_lease_to_session_id = NULL
         WHERE id = ? AND status = 'pending'`,
      ).run(reason, messageIdOrLease);
    if (result.changes === 0) return null;
    const messageId = lease ? lease.messageId : messageIdOrLease as string;
    return getById(db, messageId);
  }

  function retryAfterFail(
    lease: MessageDeliveryLease,
    reason: string,
    now: number,
  ): AgentDeckMessage | null {
    // 只能从 delivering 退回 pending（claim 后失败）
    const cur = db
      .prepare(`SELECT * FROM agent_deck_messages WHERE id = ?`)
      .get(lease.messageId) as MessageRow | undefined;
    if (!cur) return null;
    if (
      cur.status !== 'delivering' ||
      cur.to_session_id !== lease.toSessionId ||
      cur.delivery_lease_to_session_id !== lease.toSessionId ||
      cur.delivery_generation !== lease.generation
    ) return null;

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
               attempt_count = ?, delivering_since = NULL,
               delivery_lease_to_session_id = NULL
           WHERE id = ? AND status = 'delivering'
             AND to_session_id = ? AND delivery_lease_to_session_id = ?
             AND delivery_generation = ?`,
        )
        .run(
          `retry-exhausted (attempt=${newAttemptCount}): ${reason}`,
          newAttemptCount,
          lease.messageId,
          lease.toSessionId,
          lease.toSessionId,
          lease.generation,
        );
      if (result.changes === 0) return null;
      return getById(db, lease.messageId);
    }
    const result = db.prepare(
      `UPDATE agent_deck_messages
       SET status = 'pending', attempt_count = ?, last_attempt_at = ?,
           status_reason = ?, delivering_since = NULL,
           delivery_lease_to_session_id = NULL
       WHERE id = ? AND status = 'delivering'
         AND to_session_id = ? AND delivery_lease_to_session_id = ?
         AND delivery_generation = ?`,
    ).run(
      newAttemptCount,
      now,
      reason,
      lease.messageId,
      lease.toSessionId,
      lease.toSessionId,
      lease.generation,
    );
    return result.changes > 0 ? getById(db, lease.messageId) : null;
  }

  function cancel(messageId: string, reason: string): AgentDeckMessage | null {
    // Pending-only: never cancel underneath an active adapter call.
    const result = db
      .prepare(
        `UPDATE agent_deck_messages
         SET status = 'cancelled', status_reason = ?, delivering_since = NULL
             , delivery_lease_to_session_id = NULL
         WHERE id = ? AND status = 'pending'`,
      )
      .run(reason, messageId);
    if (result.changes === 0) return null;
    return getById(db, messageId);
  }

  function terminalizeDeliveringOnStartup(): number {
    const result = db
      .prepare(
        `UPDATE agent_deck_messages
         SET status = 'failed',
             status_reason = ?,
             delivering_since = NULL,
             delivery_lease_to_session_id = NULL
         WHERE status = 'delivering'`,
      )
      .run(UNCERTAIN_DELIVERY_ON_RESTART_REASON);
    return result.changes;
  }

  function retargetPendingForHandOff(
    sourceSessionId: string,
    successorSessionId: string,
  ): number {
    return retargetPendingMessagesForHandOffWithDb(db, sourceSessionId, successorSessionId);
  }

  function countDeliveringForSession(sessionId: string): number {
    return countDeliveringMessagesForSessionWithDb(db, sessionId);
  }

  function countDelivering(): number {
    return countDeliveringMessagesWithDb(db);
  }

  return {
    claim,
    markDelivered,
    markFailed,
    retryAfterFail,
    cancel,
    terminalizeDeliveringOnStartup,
    retargetPendingForHandOff,
    countDeliveringForSession,
    countDelivering,
  };
}
