import type { AgentEvent } from '@shared/types';
import { getDb } from './db';
import { safeStringifyPayload } from './payload-truncate';
import { agentDeckTeamRepo } from './agent-deck-team-repo';

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
   * plan team-cohesion-fix-20260513 Phase C：按 teamId 拉 team 内所有 active 成员的最近 events，
   * 跨 adapter 聚合（claude-code / codex-cli / aider / generic-pty）。TeamDetail 事件流 section 用。
   *
   * v014 drop sessions.team_name 后，原 `s.team_name = ?` JOIN 已不可用。改走 universal team
   * backend：先 listActiveMembers(teamId) 拿 sessionIds，再 events.session_id IN (...) 查询。
   *
   * 不再过滤 kind（原仅 team-task-created/completed/teammate-idle），返回完整事件流让 UI
   * 自己做分类 / 折叠（小 kind 太多时 UI 端可考虑虚拟列表）。limit 防长 team 一次拉上千条。
   * leftAt 非空（已退出）的成员不算在内（与 ActiveMembers 语义一致）。
   */
  findTeamEvents(teamId: string, limit = 100): (AgentEvent & { id: number })[] {
    const members = agentDeckTeamRepo.listActiveMembers(teamId);
    if (members.length === 0) return [];
    const sessionIds = members.map((m) => m.sessionId);
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = getDb()
      .prepare(
        `SELECT * FROM events
         WHERE session_id IN (${placeholders})
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(...sessionIds, limit) as Row[];
    return rows.map(rowToEvent);
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

  /**
   * Agent Deck MCP wait_reply backfill（R2 / B'0 ADR §3.3.4）：拉指定时间窗内的事件
   * 给 caller 各自 since_ts filter 用。窗口通常很短（caller since_ts → coordinator
   * baseline_ts，绝大多数 < 5s），所以不分页直接 ASC 全拉。
   * 边界：fromTs 闭、toTs 开，与 [since_ts, baseline_ts) 语义一致。
   */
  listForSessionRange(
    sessionId: string,
    fromTs: number,
    toTs: number,
    limit = 500,
  ): (AgentEvent & { id: number })[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM events
         WHERE session_id = ? AND ts >= ? AND ts < ?
         ORDER BY ts ASC LIMIT ?`,
      )
      .all(sessionId, fromTs, toTs, limit) as Row[];
    return rows.map(rowToEvent);
  },
};
