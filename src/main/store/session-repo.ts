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
    getDb()
      .prepare(
        `INSERT INTO sessions
         (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at, ended_at, archived_at)
         VALUES (@id, @agent_id, @cwd, @title, @source, @lifecycle, @activity, @started_at, @last_event_at, @ended_at, @archived_at)
         ON CONFLICT(id) DO UPDATE SET
           cwd = excluded.cwd,
           title = excluded.title,
           source = excluded.source,
           lifecycle = excluded.lifecycle,
           activity = excluded.activity,
           last_event_at = excluded.last_event_at,
           ended_at = excluded.ended_at,
           archived_at = excluded.archived_at`,
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
      conditions.push(
        `(title LIKE @kw OR id IN (SELECT session_id FROM events WHERE payload_json LIKE @kw)
          OR id IN (SELECT session_id FROM summaries WHERE content LIKE @kw))`,
      );
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
};
