import type { AgentEvent } from '@shared/types';
import { getDb } from './db';
import { safeStringifyPayload } from './payload-truncate';

interface Row {
  id: number;
  session_id: string;
  kind: string;
  payload_json: string;
  ts: number;
}

function rowToEvent(r: Row): AgentEvent & { id: number } {
  return {
    id: r.id,
    sessionId: r.session_id,
    agentId: '', // events 表不冗余 agent_id；调用者通过 session join 拿
    kind: r.kind as AgentEvent['kind'],
    payload: JSON.parse(r.payload_json) as unknown,
    ts: r.ts,
  };
}

export const eventRepo = {
  insert(event: AgentEvent): number {
    const info = getDb()
      .prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts)
         VALUES (?, ?, ?, ?)`,
      )
      .run(event.sessionId, event.kind, safeStringifyPayload(event.payload), event.ts);
    return Number(info.lastInsertRowid);
  },

  listForSession(sessionId: string, limit = 200, offset = 0): (AgentEvent & { id: number })[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM events WHERE session_id = ? ORDER BY ts DESC LIMIT ? OFFSET ?`,
      )
      .all(sessionId, limit, offset) as Row[];
    return rows.map(rowToEvent);
  },

  countForSession(sessionId: string, sinceTs?: number): number {
    if (sinceTs) {
      const r = getDb()
        .prepare(`SELECT COUNT(*) as c FROM events WHERE session_id = ? AND ts >= ?`)
        .get(sessionId, sinceTs) as { c: number };
      return r.c;
    }
    const r = getDb()
      .prepare(`SELECT COUNT(*) as c FROM events WHERE session_id = ?`)
      .get(sessionId) as { c: number };
    return r.c;
  },

  /**
   * 找最近一条「Claude 自己说的话」（kind = message AND role = assistant AND error 非真）。
   * summarizer 第二层兜底用：LLM 失败时拿这条作为「Claude 当前在做什么」的近似。
   *
   * 为什么不在调用方过滤 events 数组：
   * - listForSession 默认 limit=40，tool 密集会话最近 40 条事件可能 0 条 message kind
   *   （都被 tool-use-start/end 占满），数组 .find 直接 undefined → 走第三层事件统计
   * - 数组 .find 也没过滤 role/error，会拿到用户输入（"push 一下"）或 ⚠ 警告，
   *   summary 显示成"用户的话"而不是"Claude 在做什么"
   *
   * sinceTs 用于增量语义：只拿"自上次总结后"的最新 assistant message。
   * sinceTs 后没合格 message 时返回 null（让 summarizer 走第三层事件统计兜底，
   * 不要回退到更早的旧 assistant message —— 那会重复展示已经总结过的内容）。
   *
   * SQL 注：sqlite3 json_extract 把 JSON true→1 / false→0 / 字段不存在→SQL NULL。
   * 所以 `error IS NULL OR error = 0` 同时覆盖「无 error 字段」「error: false」「明确 null」。
   */
  findLatestAssistantMessage(
    sessionId: string,
    sinceTs?: number,
  ): { text: string; ts: number } | null {
    const sql = sinceTs
      ? `SELECT payload_json, ts FROM events
         WHERE session_id = ?
           AND kind = 'message'
           AND json_extract(payload_json, '$.role') = 'assistant'
           AND (json_extract(payload_json, '$.error') IS NULL OR json_extract(payload_json, '$.error') = 0)
           AND ts >= ?
         ORDER BY ts DESC LIMIT 1`
      : `SELECT payload_json, ts FROM events
         WHERE session_id = ?
           AND kind = 'message'
           AND json_extract(payload_json, '$.role') = 'assistant'
           AND (json_extract(payload_json, '$.error') IS NULL OR json_extract(payload_json, '$.error') = 0)
         ORDER BY ts DESC LIMIT 1`;
    const row = (sinceTs
      ? getDb().prepare(sql).get(sessionId, sinceTs)
      : getDb().prepare(sql).get(sessionId)) as { payload_json: string; ts: number } | undefined;
    if (!row) return null;
    try {
      const p = JSON.parse(row.payload_json) as { text?: string };
      const text = typeof p.text === 'string' ? p.text : '';
      return text ? { text, ts: row.ts } : null;
    } catch {
      return null;
    }
  },

  deleteForSession(sessionId: string): void {
    getDb().prepare(`DELETE FROM events WHERE session_id = ?`).run(sessionId);
  },

  /**
   * CHANGELOG_47：判断该 session 是否曾出现过 tool-use-start 事件、且 toolInput.file_path 等于给定值。
   *
   * 用途：loadImageBlob 的白名单兜底。ImageRead 不进 file_changes 表，原本靠
   * `listForSession(sessionId, 500)` 全拉到 JS 侧线性扫，长会话事件 > 500 后旧图永久读不出。
   * 改成 SQL `json_extract` + EXISTS LIMIT 1，无视事件总数，命中即返回。
   *
   * 走 sqlite json_extract 路径，sqlite 3.38+ 内置（better-sqlite3 当前 bundled）。
   */
  hasToolUseStartWithFilePath(sessionId: string, filePath: string): boolean {
    if (!sessionId || !filePath) return false;
    const r = getDb()
      .prepare(
        `SELECT 1 FROM events
         WHERE session_id = ?
           AND kind = 'tool-use-start'
           AND json_extract(payload_json, '$.toolInput.file_path') = ?
         LIMIT 1`,
      )
      .get(sessionId, filePath);
    return r !== undefined;
  },
};
