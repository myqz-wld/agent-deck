import type {
  ActivityState,
  LifecycleState,
  PermissionMode,
  SessionRecord,
  SessionSource,
} from '@shared/types';
import { getDb } from './db';

interface Row {
  id: string;
  agent_id: string;
  cwd: string;
  title: string;
  source: string;
  lifecycle: string;
  activity: string;
  started_at: number;
  last_event_at: number;
  ended_at: number | null;
  archived_at: number | null;
  permission_mode: string | null;
}

function rowToRecord(r: Row): SessionRecord {
  return {
    id: r.id,
    agentId: r.agent_id,
    cwd: r.cwd,
    title: r.title,
    source: (r.source as SessionSource) ?? 'cli',
    lifecycle: r.lifecycle as LifecycleState,
    activity: r.activity as ActivityState,
    startedAt: r.started_at,
    lastEventAt: r.last_event_at,
    endedAt: r.ended_at,
    archivedAt: r.archived_at,
    permissionMode: (r.permission_mode as PermissionMode) ?? null,
  };
}

export const sessionRepo = {
  upsert(rec: SessionRecord): void {
    // 注意：permission_mode 列也参与 INSERT 与 UPDATE，否则 SessionRecord 接口
    // 与 SQL 字段集错位 —— 复活 closed 会话用 `{...existing, lifecycle:'active'}`
    // spread 调 upsert 时，spread 进来的 permissionMode 被静默丢弃，
    // 未来想通过 upsert 改 permission_mode 会神秘失败（写了不报错但不生效）。
    getDb()
      .prepare(
        `INSERT INTO sessions
         (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at, ended_at, archived_at, permission_mode)
         VALUES (@id, @agent_id, @cwd, @title, @source, @lifecycle, @activity, @started_at, @last_event_at, @ended_at, @archived_at, @permission_mode)
         ON CONFLICT(id) DO UPDATE SET
           cwd = excluded.cwd,
           title = excluded.title,
           source = excluded.source,
           lifecycle = excluded.lifecycle,
           activity = excluded.activity,
           last_event_at = excluded.last_event_at,
           ended_at = excluded.ended_at,
           archived_at = excluded.archived_at,
           permission_mode = excluded.permission_mode`,
      )
      .run({
        id: rec.id,
        agent_id: rec.agentId,
        cwd: rec.cwd,
        title: rec.title,
        source: rec.source,
        lifecycle: rec.lifecycle,
        activity: rec.activity,
        started_at: rec.startedAt,
        last_event_at: rec.lastEventAt,
        ended_at: rec.endedAt,
        archived_at: rec.archivedAt,
        permission_mode: rec.permissionMode ?? null,
      });
  },

  get(id: string): SessionRecord | null {
    const row = getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToRecord(row) : null;
  },

  listActiveAndDormant(limit = 100): SessionRecord[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM sessions
         WHERE lifecycle IN ('active', 'dormant') AND archived_at IS NULL
         ORDER BY last_event_at DESC
         LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map(rowToRecord);
  },

  /**
   * 历史面板数据源。语义改为：
   * - 默认（archivedOnly=false）：包含 closed + 任何已归档（不论 lifecycle），
   *   也就是「不在实时面板的所有会话」
   * - archivedOnly=true：只看 archived_at IS NOT NULL
   */
  listHistory(opts: {
    agentId?: string;
    cwd?: string;
    fromTs?: number;
    toTs?: number;
    keyword?: string;
    archivedOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {}): SessionRecord[] {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const conditions: string[] = [];
    const params: Record<string, unknown> = { limit, offset };

    if (opts.archivedOnly) {
      conditions.push(`archived_at IS NOT NULL`);
    } else {
      conditions.push(`(lifecycle = 'closed' OR archived_at IS NOT NULL)`);
    }
    if (opts.agentId) {
      conditions.push(`agent_id = @agent_id`);
      params.agent_id = opts.agentId;
    }
    if (opts.cwd) {
      conditions.push(`cwd LIKE @cwd`);
      params.cwd = `%${opts.cwd}%`;
    }
    if (opts.fromTs) {
      conditions.push(`last_event_at >= @from_ts`);
      params.from_ts = opts.fromTs;
    }
    if (opts.toTs) {
      conditions.push(`last_event_at <= @to_ts`);
      params.to_ts = opts.toTs;
    }
    if (opts.keyword) {
      // 短关键词只搜 title：events.payload_json / summaries.content 是任意大文本
      // （tool_result 单条可能几百 KB），LIKE %kw% 没法用 B-tree 索引，会做全表扫描 +
      // 全文字符串匹配。1-2 字符的关键词命中量大、性能差且对用户帮助小，
      // 先卡掉这层让常见的"敲一两个字"不会拖死历史面板。
      // ≥ 3 字符再走子查询全扫，性价比可接受。
      //
      // 子查询用 EXISTS (... LIMIT 1) 而不是 IN (SELECT ...)：
      // - IN 会把整个子查询结果集物化成临时集合再做 hash join，
      //   events 表大几万条时这一步本身就要遍历整张表。
      // - EXISTS 配合 LIMIT 1 + 关联子查询，匹配到第一条就短路。
      //   是当前不上 FTS5 前的最低成本优化（仍是 O(n) 全表扫，但常数显著降低）。
      if (opts.keyword.length >= 3) {
        conditions.push(
          `(title LIKE @kw
            OR EXISTS (SELECT 1 FROM events e WHERE e.session_id = sessions.id AND e.payload_json LIKE @kw LIMIT 1)
            OR EXISTS (SELECT 1 FROM summaries su WHERE su.session_id = sessions.id AND su.content LIKE @kw LIMIT 1))`,
        );
      } else {
        conditions.push(`title LIKE @kw`);
      }
      params.kw = `%${opts.keyword}%`;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM sessions ${where} ORDER BY last_event_at DESC LIMIT @limit OFFSET @offset`;
    const rows = getDb().prepare(sql).all(params) as Row[];
    return rows.map(rowToRecord);
  },

  setLifecycle(id: string, lifecycle: LifecycleState, ts: number): void {
    if (lifecycle === 'closed') {
      getDb()
        .prepare(`UPDATE sessions SET lifecycle = ?, ended_at = ? WHERE id = ?`)
        .run(lifecycle, ts, id);
    } else {
      // active / dormant：清掉结束时间（不再「已结束」）。归档与否由 archived_at 单独管。
      getDb()
        .prepare(`UPDATE sessions SET lifecycle = ?, ended_at = NULL WHERE id = ?`)
        .run(lifecycle, id);
    }
  },

  /** 标记归档（ts=null 表示取消归档）。lifecycle 不动，保留原始生命周期。 */
  setArchived(id: string, ts: number | null): void {
    getDb().prepare(`UPDATE sessions SET archived_at = ? WHERE id = ?`).run(ts, id);
  },

  /** 写入用户在 UI 上选过的权限模式。null 表示恢复默认（'default'）。 */
  setPermissionMode(id: string, mode: PermissionMode | null): void {
    getDb().prepare(`UPDATE sessions SET permission_mode = ? WHERE id = ?`).run(mode, id);
  },

  /**
   * 把 sessions 表里 fromId 改名 toId，并把 events / file_changes / summaries
   * 的 session_id 引用一起迁移。整体在事务内做，避免外键 CASCADE 误删历史。
   * 用于 SDK fallback：tempKey 占位行 → 真实 session_id 出现后无损迁移。
   */
  rename(fromId: string, toId: string): void {
    if (fromId === toId) return;
    const db = getDb();
    const tx = db.transaction(() => {
      const fromRow = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(fromId) as Row | undefined;
      if (!fromRow) return; // tempKey 行不存在就什么都不做
      const toExists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(toId) as { 1: number } | undefined;
      if (!toExists) {
        // 复制 fromRow 内容到新 id（id 是 PK，必须 INSERT 新行）
        db.prepare(
          `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at, ended_at, archived_at, permission_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          toId,
          fromRow.agent_id,
          fromRow.cwd,
          fromRow.title,
          fromRow.source,
          fromRow.lifecycle,
          fromRow.activity,
          fromRow.started_at,
          fromRow.last_event_at,
          fromRow.ended_at,
          fromRow.archived_at,
          fromRow.permission_mode,
        );
      }
      // 迁移子表引用（外键 ON DELETE CASCADE 在删 fromId 时不会误删，因为 session_id 已改）
      db.prepare(`UPDATE events SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
      db.prepare(`UPDATE file_changes SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
      db.prepare(`UPDATE summaries SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(fromId);
    });
    tx();
  },

  setActivity(id: string, activity: ActivityState, lastEventAt: number): void {
    getDb()
      .prepare(`UPDATE sessions SET activity = ?, last_event_at = ? WHERE id = ?`)
      .run(activity, lastEventAt, id);
  },

  delete(id: string): void {
    getDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  },

  /** lifecycle scheduler 用：找出所有可能要从 active → dormant 的会话；归档的不参与衰减 */
  findActiveExpiring(threshold: number): SessionRecord[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM sessions WHERE lifecycle = 'active' AND archived_at IS NULL AND last_event_at < ?`,
      )
      .all(threshold) as Row[];
    return rows.map(rowToRecord);
  },

  /** lifecycle scheduler 用：找出所有可能要从 dormant → closed 的会话；归档的不参与衰减 */
  findDormantExpiring(threshold: number): SessionRecord[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM sessions WHERE lifecycle = 'dormant' AND archived_at IS NULL AND last_event_at < ?`,
      )
      .all(threshold) as Row[];
    return rows.map(rowToRecord);
  },

  /**
   * lifecycle scheduler 批量推进：单事务里把多个 sessionId 的 lifecycle
   * 一次推到目标态，避免每条都跑「get → setLifecycle → get → emit」3 次 SQL。
   * 返回真正发生状态变化的行（再让上层 emit upserted 通知 renderer）。
   *
   * SQL 不用动态拼 IN(?, ?, ?) —— 一次性 prepare + transaction 内多次 run，
   * better-sqlite3 内部会复用 statement，比拼 IN 更稳。
   */
  batchSetLifecycle(ids: readonly string[], lifecycle: LifecycleState, ts: number): SessionRecord[] {
    if (ids.length === 0) return [];
    const db = getDb();
    const updateClosed = db.prepare(
      `UPDATE sessions SET lifecycle = ?, ended_at = ? WHERE id = ? AND lifecycle != ?`,
    );
    const updateOther = db.prepare(
      `UPDATE sessions SET lifecycle = ?, ended_at = NULL WHERE id = ? AND lifecycle != ?`,
    );
    const fetch = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
    const updated: SessionRecord[] = [];
    const tx = db.transaction(() => {
      for (const id of ids) {
        const info =
          lifecycle === 'closed'
            ? updateClosed.run(lifecycle, ts, id, lifecycle)
            : updateOther.run(lifecycle, id, lifecycle);
        if (info.changes > 0) {
          const row = fetch.get(id) as Row | undefined;
          if (row) updated.push(rowToRecord(row));
        }
      }
    });
    tx();
    return updated;
  },

  /**
   * 历史会话自动清理：找出 lastEventAt < threshold 且不在实时面板的会话 id。
   * 「不在实时面板」= lifecycle = 'closed' 或 archived_at IS NOT NULL，
   * 与 listHistory 的范围一致。active / dormant 即便最后事件很久也不删
   * （用户可能开着窗口在等长任务），由 LifecycleScheduler 先推到 closed 再考虑清理。
   */
  findHistoryOlderThan(threshold: number, limit = 500): string[] {
    const rows = getDb()
      .prepare(
        `SELECT id FROM sessions
         WHERE last_event_at < ?
           AND (lifecycle = 'closed' OR archived_at IS NOT NULL)
         ORDER BY last_event_at ASC
         LIMIT ?`,
      )
      .all(threshold, limit) as { id: string }[];
    return rows.map((r) => r.id);
  },

  /**
   * 批量删除会话（events / file_changes / summaries 由外键 ON DELETE CASCADE 自动清理）。
   * 单事务内逐条 DELETE，事务保证「要么全删要么全不删」，避免中途异常留下半残行。
   * 返回 IPC 上层用来一次性广播 session-removed 的 id 数组（已存在的才返回）。
   */
  batchDelete(ids: readonly string[]): string[] {
    if (ids.length === 0) return [];
    const db = getDb();
    const exists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`);
    const del = db.prepare(`DELETE FROM sessions WHERE id = ?`);
    const removed: string[] = [];
    const tx = db.transaction(() => {
      for (const id of ids) {
        if (exists.get(id)) {
          del.run(id);
          removed.push(id);
        }
      }
    });
    tx();
    return removed;
  },
};
