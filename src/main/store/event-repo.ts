import type { AgentEvent } from '@shared/types';
import { mergeToolUsePayload } from '@shared/agent-event-merge';
import { getDb } from './db';
import { safeStringifyPayload } from './payload-truncate';
import { agentDeckTeamRepo } from './agent-deck-team-repo';
import log from '@main/utils/logger';

const logger = log.scope('event-repo');

interface Row {
  id: number;
  session_id: string;
  kind: string;
  payload_json: string;
  ts: number;
  tool_use_id: string | null;
}

interface PayloadParseContext {
  operation: string;
  eventId?: number;
  sessionId?: string;
  kind?: string;
  toolUseId?: string | null;
  ts?: number;
}

/**
 * 单行 → AgentEvent。payload JSON 损坏时返 null（warn 落盘）而**不是 throw**：
 * list 类查询都是 `rows.map(...)` 批量转换，单行坏数据若 throw 会让整个会话的
 * 活动流 / 团队事件流 / resume 注入永久读取失败（一行毒化全批）。写入侧有
 * safeStringifyPayload 守护，坏行只可能来自磁盘损坏 / 外部写入 —— skip + warn
 * 与同文件 parsePayloadJson（merge 路径降级返 null）策略对齐。
 */
function rowToEvent(r: Row): (AgentEvent & { id: number }) | null {
  let payload: unknown;
  try {
    payload = JSON.parse(r.payload_json) as unknown;
  } catch (err) {
    logger.warn('[event-repo] payload JSON parse failed; row skipped', {
      operation: 'row-to-event',
      eventId: r.id,
      sessionId: r.session_id,
      kind: r.kind,
      ts: r.ts,
    }, err);
    return null;
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    agentId: '', // events 表不冗余 agent_id；调用者通过 session join 拿
    kind: r.kind as AgentEvent['kind'],
    payload,
    ts: r.ts,
  };
}

/** 批量转换 + 跳过坏行（rowToEvent 返 null 的行被过滤，详 rowToEvent jsdoc）。 */
function rowsToEvents(rows: Row[]): (AgentEvent & { id: number })[] {
  const out: (AgentEvent & { id: number })[] = [];
  for (const r of rows) {
    const e = rowToEvent(r);
    if (e) out.push(e);
  }
  return out;
}

/**
 * 从 event payload 提取 toolUseId。仅 tool-use-start / tool-use-end 才有；其他 kind 返 null
 * 让 tool_use_id 列保持 NULL（partial UNIQUE INDEX 自动跳过）。
 *
 * 守门同步 session-store.ts:99-105 upsertEvent dedup（REVIEW_52 A1）：
 *   - typeof string 必要
 *   - 非空字符串必要（避免空串撞 partial UNIQUE 与历史 toolUseId 冗余漂移）
 */
function extractToolUseId(event: AgentEvent): string | null {
  if (event.kind !== 'tool-use-start' && event.kind !== 'tool-use-end') return null;
  const tid = (event.payload as { toolUseId?: unknown })?.toolUseId;
  return typeof tid === 'string' && tid !== '' ? tid : null;
}

function parsePayloadJson(json: string, ctx: PayloadParseContext): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (err) {
    logger.warn('[event-repo] payload JSON parse failed', ctx, err);
    return null;
  }
}

export const eventRepo = {
  /**
   * INSERT or merge-update depending on dedup eligibility（REVIEW_52 A2 + REVIEW_54）。
   *
   * `tool-use-start` + 有 toolUseId → 命中已有行时合并 payload 后 UPDATE，row id 不变。
   * 这会保留初始 `toolInput.command`，同时吸收后续 app-server outputDelta/status。
   * `tool-use-end` + 有 toolUseId → 同款 merge-update（REVIEW_54）。codex thread
   * restart/resume/重连路径下同 item.id 的 item.completed 会重发多次，每次都新行 →
   * DB 累积 N 行同 toolUseId tool-use-end → ActivityFeed key collision 让 ToolEndRow
   * 点不开。修法与 tool-use-start 对称，保最新一份。
   *
   * 其他 kind / 缺 toolUseId → 普通 INSERT 新行。
   *
   * 显式 SELECT 再 UPDATE，而不是 SQLite ON CONFLICT DO UPDATE，原因是 merge 需要读取旧
   * payload_json 才能保留缺失字段并按 marker 追加 output delta。
   */
  insert(event: AgentEvent): number {
    const toolUseId = extractToolUseId(event);

    if (
      (event.kind === 'tool-use-start' || event.kind === 'tool-use-end') &&
      toolUseId
    ) {
      const existing = getDb()
        .prepare(
          `SELECT id, payload_json
             FROM events
            WHERE session_id = ? AND kind = ? AND tool_use_id = ?
            LIMIT 1`,
        )
        .get(event.sessionId, event.kind, toolUseId) as
        | { id: number; payload_json: string }
        | undefined;
      const payload = existing
        ? mergeToolUsePayload(
          parsePayloadJson(existing.payload_json, {
            operation: 'merge-existing-payload',
            eventId: existing.id,
            sessionId: event.sessionId,
            kind: event.kind,
            toolUseId,
            ts: event.ts,
          }),
          event.payload,
        )
        : mergeToolUsePayload(null, event.payload);
      if (existing) {
        getDb()
          .prepare(`UPDATE events SET payload_json = ?, ts = ? WHERE id = ?`)
          .run(safeStringifyPayload(payload), event.ts, existing.id);
        return existing.id;
      }
      const row = getDb()
        .prepare(
          `INSERT INTO events (session_id, kind, payload_json, ts, tool_use_id)
           VALUES (?, ?, ?, ?, ?)
           RETURNING id`,
        )
        .get(event.sessionId, event.kind, safeStringifyPayload(payload), event.ts, toolUseId) as {
        id: number;
      };
      return row.id;
    }

    const info = getDb()
      .prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts, tool_use_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(event.sessionId, event.kind, safeStringifyPayload(event.payload), event.ts, toolUseId);
    return Number(info.lastInsertRowid);
  },

  listForSession(sessionId: string, limit = 200, offset = 0): (AgentEvent & { id: number })[] {
    // REVIEW_52 F3：加 id DESC 作 secondary key。同毫秒 ts（codex item.updated 推几条
    // 同 toolUseId tool-use-start payload，Date.now() 在 ms 边界可能撞同毫秒）SQLite 不保证
    // 顺序稳定，导致 setRecentEvents read-side dedup「首条即最新」语义破坏（双 reviewer
    // claude MED-1 / codex MED-3 同款 finding）。id AUTOINCREMENT 单调递增 → 同毫秒按 id 取
    // 最大即最晚插入。
    const rows = getDb()
      .prepare(
        `SELECT * FROM events WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(sessionId, limit, offset) as Row[];
    return rowsToEvents(rows);
  },

  listValidForSession(sessionId: string, limit = 200, offset = 0): (AgentEvent & { id: number })[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM events
          WHERE session_id = ? AND json_valid(payload_json)
          ORDER BY ts DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(sessionId, limit, offset) as Row[];
    return rowsToEvents(rows);
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
   * 跨 adapter 聚合（claude-code / codex-cli）。TeamDetail 事件流 section 用。
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
    // 跨多 session IN 查询，同毫秒 ts 跨 session 碰撞概率更高（多个 teammate 并发 emit），
    // 缺 tie-breaker → TeamDetail 事件流刷新跳序。加 `id DESC`（与 listForSession F3 同款，
    // REVIEW_91 双 reviewer 独立共识）。
    const rows = getDb()
      .prepare(
        `SELECT * FROM events
         WHERE session_id IN (${placeholders})
         ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(...sessionIds, limit) as Row[];
    return rowsToEvents(rows);
  },

  /**
   * 找最近一条「Claude 自己说的话」（kind = message AND role = assistant AND error 非真）。
   * summarizer 第二层兜底用：LLM 失败时拿这条作为「Claude 当前在做什么」的近似。
   *
   * 为什么不在调用方过滤 events 数组：
   * - periodic-summary activity evidence 有独立行数/令牌预算，tool 密集会话的窗口可能
   *   没有 message kind，数组 .find 会直接 undefined → 走第三层事件统计
   * - 数组 .find 也没过滤 role/error，会拿到用户输入（"push 一下"）或 ⚠ 警告，
   *   summary 显示成"用户的话"而不是"Claude 在做什么"
   *
   * sinceTs 用于增量语义：只拿"自上次总结后"的最新 assistant message。
   * sinceTs 后没合格 message 时返回 null（让 summarizer 走第三层事件统计兜底，
   * 不要回退到更早的旧 assistant message —— 那会重复展示已经总结过的内容）。
   *
   * SQL 注：sqlite3 json_extract 把 JSON true→1 / false→0 / 字段不存在→SQL NULL。
   * 所以 `error IS NULL OR error = 0` 同时覆盖「无 error 字段」「error: false」「明确 null」。
   * 同毫秒 ts 加 `id DESC` tie-breaker 取最晚插入那条 assistant message（REVIEW_91）。
   *
   * **坏行隔离**（与 rowToEvent skip 同根因）：json_extract 对 malformed JSON 是 SQL 级
   * runtime error，单行损坏会让整个查询抛错。用 CASE WHEN json_valid 包住（CASE 保证
   * 条件求值顺序；裸 `json_valid(x) AND json_extract(x)` 的 AND 项 SQLite 不保证求值序）。
   */
  findLatestAssistantMessage(
    sessionId: string,
    sinceTs?: number,
  ): { text: string; ts: number } | null {
    const validAssistantCond = `CASE WHEN json_valid(payload_json) THEN (
             json_extract(payload_json, '$.role') = 'assistant'
             AND (json_extract(payload_json, '$.error') IS NULL OR json_extract(payload_json, '$.error') = 0)
           ) ELSE 0 END`;
    const sql = sinceTs
      ? `SELECT id, payload_json, ts FROM events
         WHERE session_id = ?
           AND kind = 'message'
           AND ${validAssistantCond}
           AND ts >= ?
         ORDER BY ts DESC, id DESC LIMIT 1`
      : `SELECT id, payload_json, ts FROM events
         WHERE session_id = ?
           AND kind = 'message'
           AND ${validAssistantCond}
         ORDER BY ts DESC, id DESC LIMIT 1`;
    const row = (sinceTs
      ? getDb().prepare(sql).get(sessionId, sinceTs)
      : getDb().prepare(sql).get(sessionId)) as { id: number; payload_json: string; ts: number } | undefined;
    if (!row) return null;
    try {
      const p = JSON.parse(row.payload_json) as { text?: string };
      const text = typeof p.text === 'string' ? p.text : '';
      return text ? { text, ts: row.ts } : null;
    } catch (err) {
      logger.warn('[event-repo] payload JSON parse failed', {
        operation: 'find-latest-assistant-message',
        eventId: row.id,
        sessionId,
        kind: 'message',
        ts: row.ts,
      }, err);
      return null;
    }
  },

  /** Revision-bounded equivalent used by v040 periodic summaries. */
  findLatestAssistantMessageAfterRevision(
    sessionId: string,
    afterRevision: number,
    throughRevision: number,
  ): { text: string; ts: number } | null {
    const row = getDb()
      .prepare(
        `SELECT id, payload_json, ts FROM events
         WHERE session_id = ?
           AND kind = 'message'
           AND COALESCE(change_revision, id) > ?
           AND COALESCE(change_revision, id) <= ?
           AND CASE WHEN json_valid(payload_json) THEN (
             json_extract(payload_json, '$.role') = 'assistant'
             AND (json_extract(payload_json, '$.error') IS NULL
                  OR json_extract(payload_json, '$.error') = 0)
           ) ELSE 0 END
         ORDER BY COALESCE(change_revision, id) DESC, id DESC
         LIMIT 1`,
      )
      .get(sessionId, afterRevision, throughRevision) as
      | { id: number; payload_json: string; ts: number }
      | undefined;
    if (!row) return null;
    try {
      const payload = JSON.parse(row.payload_json) as { text?: string };
      return typeof payload.text === 'string' && payload.text
        ? { text: payload.text, ts: row.ts }
        : null;
    } catch (err) {
      logger.warn('[event-repo] payload JSON parse failed', {
        operation: 'find-latest-assistant-message-after-revision',
        eventId: row.id,
        sessionId,
        kind: 'message',
        ts: row.ts,
      }, err);
      return null;
    }
  },

  /** Latest assistant message inside a frozen revision boundary, optionally after a legacy ts. */
  findLatestAssistantMessageAtOrBeforeRevision(
    sessionId: string,
    throughRevision: number,
    sinceTs?: number,
  ): { text: string; ts: number } | null {
    const sinceClause = sinceTs === undefined ? '' : 'AND ts >= ?';
    const params =
      sinceTs === undefined
        ? [sessionId, throughRevision]
        : [sessionId, throughRevision, sinceTs];
    const row = getDb()
      .prepare(
        `SELECT id, payload_json, ts FROM events
         WHERE session_id = ?
           AND kind = 'message'
           AND COALESCE(change_revision, id) <= ?
           ${sinceClause}
           AND CASE WHEN json_valid(payload_json) THEN (
             json_extract(payload_json, '$.role') = 'assistant'
             AND (json_extract(payload_json, '$.error') IS NULL
                  OR json_extract(payload_json, '$.error') = 0)
           ) ELSE 0 END
         ORDER BY COALESCE(change_revision, id) DESC, id DESC
         LIMIT 1`,
      )
      .get(...params) as { id: number; payload_json: string; ts: number } | undefined;
    if (!row) return null;
    try {
      const payload = JSON.parse(row.payload_json) as { text?: string };
      return typeof payload.text === 'string' && payload.text
        ? { text: payload.text, ts: row.ts }
        : null;
    } catch (err) {
      logger.warn('[event-repo] payload JSON parse failed', {
        operation: 'find-latest-assistant-message-at-or-before-revision',
        eventId: row.id,
        sessionId,
        kind: 'message',
        ts: row.ts,
      }, err);
      return null;
    }
  },

  /** Latest valid user/assistant message time used only to validate phantom-resume freshness. */
  latestConversationMessageTs(sessionId: string): number | null {
    const row = getDb()
      .prepare(
        `SELECT ts FROM events
         WHERE session_id = ?
           AND kind = 'message'
           AND CASE WHEN json_valid(payload_json) THEN (
             json_extract(payload_json, '$.role') IN ('user', 'assistant')
             AND (json_extract(payload_json, '$.error') IS NULL
                  OR json_extract(payload_json, '$.error') = 0)
           ) ELSE 0 END
         ORDER BY ts DESC, id DESC
         LIMIT 1`,
      )
      .get(sessionId) as { ts: number } | undefined;
    return row?.ts ?? null;
  },

  /** Highest persisted event id, used as a bounded handoff preview statistic. */
  maxEventId(sessionId: string): number | null {
    const r = getDb()
      .prepare(`SELECT MAX(id) as m FROM events WHERE session_id = ?`)
      .get(sessionId) as { m: number | null };
    return r.m;
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
    // 坏行隔离：CASE WHEN json_valid 同款守卫（详 findLatestAssistantMessage 注释）。
    const r = getDb()
      .prepare(
        `SELECT 1 FROM events
         WHERE session_id = ?
           AND kind = 'tool-use-start'
           AND CASE WHEN json_valid(payload_json)
                 THEN json_extract(payload_json, '$.toolInput.file_path') = ?
                 ELSE 0 END
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
   * 同毫秒 ts 加 `id ASC` tie-breaker（方向跟 ts ASC 一致 — DESC 配 id DESC / ASC 配
   * id ASC），保证 backfill 时序稳定（REVIEW_91）。
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
         ORDER BY ts ASC, id ASC LIMIT ?`,
      )
      .all(sessionId, fromTs, toTs, limit) as Row[];
    return rowsToEvents(rows);
  },
};
