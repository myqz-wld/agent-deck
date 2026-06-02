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
 * - listBySession：按 session_id 拉跨会话视图（UNION ALL 双索引重写 + self-row guard，SessionDetail tab 兜底）
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
    // REVIEW_90 MED (双方独立 + lead sqlite3 真测): 同毫秒 sent_at（背靠背 insert 落同一
    // Date.now()）下纯 `ORDER BY sent_at DESC` 无 total order → 返回插入序(oldest-first)违背
    // 「最新在前」契约 + 分页 LIMIT/OFFSET 切到同毫秒 tie 组时跨页重复/漏行。加 `rowid DESC`
    // 二级排序定序（必须 rowid 非 id —— id 是 crypto.randomUUID() 随机，rowid 单调随插入）。
    // 与 G2 team-repo REVIEW_89 list rowid DESC 修法同款。
    if (opts?.status) {
      const rows = db
        .prepare(
          `SELECT * FROM agent_deck_messages
           WHERE team_id = ? AND status = ?
           ORDER BY sent_at DESC, rowid DESC LIMIT ? OFFSET ?`,
        )
        .all(teamId, opts.status, limit, offset) as MessageRow[];
      return rows.map(rowToRecord);
    }
    const rows = db
      .prepare(
        `SELECT * FROM agent_deck_messages
         WHERE team_id = ?
         ORDER BY sent_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(teamId, limit, offset) as MessageRow[];
    return rows.map(rowToRecord);
  }

  function listBySession(sessionId: string, opts?: ListMessagesByTeamOptions): AgentDeckMessage[] {
    // plan mcp-bug-and-feature-batch-20260513 Phase 5 Step 5.2：拉本 session 收发的所有
    // cross-session messages。SessionDetail「跨会话消息」tab 兜底视图（reply 已注入 SDK，
    // 此处 DB 视角补回全量历史含 delivered/failed）。
    //
    // plan message-retention-and-index-20260602 D5：从 `WHERE from=? OR to=?` 改 UNION ALL
    // 双分支——OR 两谓词无法都索引必走全表 SCAN（issue 7dcb0676），UNION ALL 让每分支各走
    // v030 的 (from,sent_at DESC) / (to,sent_at DESC) 索引消灭全表扫描（spike1 实证）。
    //
    // ⚠️ 第二分支必须带 `AND from_session_id <> ?` 去重 guard（Deep-Review R1 codex HIGH-2）：
    // 正常 self-msg（from==to）insert 时 throw 不存在，但 session-repo/rename.ts 分别 UPDATE
    // from/to——rename A→B 时 `from=A,to=B` 行会变 `from=B,to=B`（self-row）。无 guard 时该行被
    // 两分支各计一次 → baseline OR 返 1 行但 UNION ALL 返 2 行，违反 N2 byte-identical。guard
    // 把「from 与 to 都等于本 session」的 self-row 从第二分支排除（第一分支已计），总计仍 1 行。
    //
    // REVIEW_90 MED：`rowid DESC` 二级定序锁同毫秒 sent_at tie 稳定（rowid 非 id——id 是随机
    // UUID）。UNION ALL 子查询 `SELECT *, rowid AS _rid`，外层显式列投影剥离 _rid + ORDER BY
    // sent_at DESC, _rid DESC。外层投影保结果列集与旧 `SELECT *` 一致（rowToRecord 字段选择式
    // 映射即便不剥 _rid 也安全，显式投影更干净）。
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
    const offset = Math.max(0, opts?.offset ?? 0);
    if (opts?.status) {
      const rows = db
        .prepare(
          `SELECT id, team_id, from_session_id, to_session_id, body, status, status_reason,
                  sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since,
                  reply_to_message_id
           FROM (
             SELECT *, rowid AS _rid FROM agent_deck_messages
               WHERE from_session_id = ? AND status = ?
             UNION ALL
             SELECT *, rowid AS _rid FROM agent_deck_messages
               WHERE to_session_id = ? AND from_session_id <> ? AND status = ?
           )
           ORDER BY sent_at DESC, _rid DESC LIMIT ? OFFSET ?`,
        )
        .all(sessionId, opts.status, sessionId, sessionId, opts.status, limit, offset) as MessageRow[];
      return rows.map(rowToRecord);
    }
    const rows = db
      .prepare(
        `SELECT id, team_id, from_session_id, to_session_id, body, status, status_reason,
                sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since,
                reply_to_message_id
         FROM (
           SELECT *, rowid AS _rid FROM agent_deck_messages WHERE from_session_id = ?
           UNION ALL
           SELECT *, rowid AS _rid FROM agent_deck_messages
             WHERE to_session_id = ? AND from_session_id <> ?
         )
         ORDER BY sent_at DESC, _rid DESC LIMIT ? OFFSET ?`,
      )
      .all(sessionId, sessionId, sessionId, limit, offset) as MessageRow[];
    return rows.map(rowToRecord);
  }

  // CHANGELOG_100 / plan mcp-tool-simplify-20260514: deleted findRepliesByMessageId
  // along with wait_reply / check_reply tools. The reply_to_message_id column is kept as
  // DB metadata for chain visibility (`agent_deck_messages` schema unchanged), but the
  // reverse-lookup SQL helper is no longer needed since reply now flows through the same
  // dispatch path as any other message.

  return { insert, get, listByTeam, listBySession };
}
