/**
 * agent-deck-message-repo crud 子模块 — 4 method 基础读写。
 *
 * 拆分自 `agent-deck-message-repo.ts` 527 LOC（Phase 4 Step 4.11）。
 *
 * 域职责：
 * - insert：UUID 生成 + caller-side validation（self-loop / body 非空 / body ≤ MAX_BODY_LENGTH）
 *   + INSERT into agent_deck_messages（status='pending', sent_at=now, last_attempt_at=null）
 * - get：复用 _deps.getById free function（state-machine 也用，避免重复 SQL）
 * - listByTeam：按 team_id 拉 + 可选 status filter
 * - listBySession：按 session_id (from OR to) 拉跨会话视图（SessionDetail tab 兜底）
 *
 * 本子模块不依赖其他子模块，纯 SQL CRUD。
 */
import type { Database } from 'better-sqlite3';
import type { AgentDeckMessage } from '@shared/types';
import {
  MAX_BODY_LENGTH,
  MessageInvariantError,
} from '@main/store/message-delivery-state';
import {
  getById,
  rowToRecord,
  type InsertMessageInput,
  type ListMessagesByTeamOptions,
  type MessageRow,
} from './_deps';

export function createCrud(db: Database) {
  function insert(input: InsertMessageInput): AgentDeckMessage {
    const { teamId, fromSessionId, toSessionId, body } = input;
    if (fromSessionId === toSessionId) {
      throw new MessageInvariantError(
        `self-message not allowed: from=${fromSessionId} == to=${toSessionId}`,
      );
    }
    if (!body || body.length === 0) {
      throw new MessageInvariantError('body 不能为空');
    }
    if (body.length > MAX_BODY_LENGTH) {
      throw new MessageInvariantError(
        `body 长度 ${body.length} 超过 ${MAX_BODY_LENGTH}`,
      );
    }

    const id = input.id ?? crypto.randomUUID();
    const now = Date.now();
    // plan team-cohesion-fix-20260513 Phase B Step B1：reply_to_message_id 列入 INSERT
    db.prepare(
      `INSERT INTO agent_deck_messages
       (id, team_id, from_session_id, to_session_id, body, status, status_reason,
        sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since, reply_to_message_id)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, 0, NULL, NULL, ?)`,
    ).run(id, teamId, fromSessionId, toSessionId, body, now, input.replyToMessageId ?? null);

    const created = getById(db, id);
    if (!created) throw new Error(`message ${id} 创建后查询失败`);
    return created;
  }

  function get(messageId: string): AgentDeckMessage | null {
    return getById(db, messageId);
  }

  function listByTeam(teamId: string, opts?: ListMessagesByTeamOptions): AgentDeckMessage[] {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
    const offset = Math.max(0, opts?.offset ?? 0);
    if (opts?.status) {
      const rows = db
        .prepare(
          `SELECT * FROM agent_deck_messages
           WHERE team_id = ? AND status = ?
           ORDER BY sent_at DESC LIMIT ? OFFSET ?`,
        )
        .all(teamId, opts.status, limit, offset) as MessageRow[];
      return rows.map(rowToRecord);
    }
    const rows = db
      .prepare(
        `SELECT * FROM agent_deck_messages
         WHERE team_id = ?
         ORDER BY sent_at DESC LIMIT ? OFFSET ?`,
      )
      .all(teamId, limit, offset) as MessageRow[];
    return rows.map(rowToRecord);
  }

  function listBySession(sessionId: string, opts?: ListMessagesByTeamOptions): AgentDeckMessage[] {
    // plan mcp-bug-and-feature-batch-20260513 Phase 5 Step 5.2：from_session_id OR to_session_id
    // 命中即返回。SessionDetail tab 兜底视图（J fix 后 reply 不入 SDK，此处 DB 视角补回）。
    // 不走 idx_messages_sent_at（无法两个谓词都索引），扫表 + WHERE filter，rows ≤ 几千问题不大。
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
    const offset = Math.max(0, opts?.offset ?? 0);
    if (opts?.status) {
      const rows = db
        .prepare(
          `SELECT * FROM agent_deck_messages
           WHERE (from_session_id = ? OR to_session_id = ?) AND status = ?
           ORDER BY sent_at DESC LIMIT ? OFFSET ?`,
        )
        .all(sessionId, sessionId, opts.status, limit, offset) as MessageRow[];
      return rows.map(rowToRecord);
    }
    const rows = db
      .prepare(
        `SELECT * FROM agent_deck_messages
         WHERE from_session_id = ? OR to_session_id = ?
         ORDER BY sent_at DESC LIMIT ? OFFSET ?`,
      )
      .all(sessionId, sessionId, limit, offset) as MessageRow[];
    return rows.map(rowToRecord);
  }

  // CHANGELOG_100 / plan mcp-tool-simplify-20260514: deleted findRepliesByMessageId
  // along with wait_reply / check_reply tools. The reply_to_message_id column is kept as
  // DB metadata for chain visibility (`agent_deck_messages` schema unchanged), but the
  // reverse-lookup SQL helper is no longer needed since reply now flows through the same
  // dispatch path as any other message.

  return { insert, get, listByTeam, listBySession };
}
