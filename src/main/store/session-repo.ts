import type {
  ActivityState,
  LifecycleState,
  PermissionMode,
  SessionRecord,
  SessionSource,
} from '@shared/types';
import { getDb } from './db';
import { buildKeywordPredicate } from './search-predicate';

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
  team_name: string | null;
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
    teamName: r.team_name ?? null,
  };
}

export const sessionRepo = {
  upsert(rec: SessionRecord): void {
    // 注意：permission_mode 与 team_name 也参与 INSERT 与 UPDATE，否则 SessionRecord 接口
    // 与 SQL 字段集错位 —— 复活 closed 会话用 `{...existing, lifecycle:'active'}`
    // spread 调 upsert 时，spread 进来的 permissionMode / teamName 被静默丢弃，
    // 未来想通过 upsert 改这些字段会神秘失败（写了不报错但不生效）。
    getDb()
      .prepare(
        `INSERT INTO sessions
         (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at, ended_at, archived_at, permission_mode, team_name)
         VALUES (@id, @agent_id, @cwd, @title, @source, @lifecycle, @activity, @started_at, @last_event_at, @ended_at, @archived_at, @permission_mode, @team_name)
         ON CONFLICT(id) DO UPDATE SET
           cwd = excluded.cwd,
           title = excluded.title,
           source = excluded.source,
           lifecycle = excluded.lifecycle,
           activity = excluded.activity,
           last_event_at = excluded.last_event_at,
           ended_at = excluded.ended_at,
           archived_at = excluded.archived_at,
           permission_mode = excluded.permission_mode,
           team_name = excluded.team_name`,
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
        team_name: rec.teamName ?? null,
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
      // 关键词谓词由 search-predicate.ts/buildKeywordPredicate 构造，详见该文件注释。
      // < 3 字符走 title LIKE-only（trigram tokenizer 需要 ≥ 3 gram）；
      // ≥ 3 字符走 title LIKE OR events_fts MATCH OR summaries_fts MATCH，
      // FTS5 + trigram 索引 substring 友好，远快于历史的 events.payload_json LIKE 全表扫。
      const pred = buildKeywordPredicate(opts.keyword);
      conditions.push(pred.sql);
      Object.assign(params, pred.params);
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

  /** 写入会话所属团队名（Agent Teams）。null 表示不属于任何 team。 */
  setTeamName(id: string, teamName: string | null): void {
    getDb().prepare(`UPDATE sessions SET team_name = ? WHERE id = ?`).run(teamName, id);
  },

  /**
   * Agent Teams M3 (C 方案)：批量把指定 team_name 下所有 sessions 的 team_name 设为 NULL，
   * 返回被影响的 session id 列表（让上层 emit upserts 同步 renderer store）。
   *
   * 触发场景：team-watcher 监听到 ~/.claude/teams/<name>/ 整个目录被 unlinkDir
   * （Claude TeamDelete 自然成功 / 用户点 force-cleanup 按钮 / 外部 rm -rf）→
   * 应用 DB 自动解绑 sessions.team_name → distinctTeamNames 不再返回该 name →
   * TeamHub 列表自然移除该 team。sessions 本身不删，仍能在历史 tab 找到。
   */
  clearTeamName(teamName: string): string[] {
    const db = getDb();
    const rows = db
      .prepare(`SELECT id FROM sessions WHERE team_name = ?`)
      .all(teamName) as { id: string }[];
    if (rows.length === 0) return [];
    db.prepare(`UPDATE sessions SET team_name = NULL WHERE team_name = ?`).run(teamName);
    return rows.map((r) => r.id);
  },

  /** Agent Teams：列出所有非 NULL team_name（去重，按字典序）。M2 Team Hub 用。 */
  distinctTeamNames(): string[] {
    const rows = getDb()
      .prepare(`SELECT DISTINCT team_name FROM sessions WHERE team_name IS NOT NULL ORDER BY team_name`)
      .all() as { team_name: string }[];
    return rows.map((r) => r.team_name);
  },

  /** Agent Teams：找出指定 team 名下的所有会话（含 closed / archived）。M2 TeamDetail 用。 */
  findByTeamName(teamName: string): SessionRecord[] {
    const rows = getDb()
      .prepare(`SELECT * FROM sessions WHERE team_name = ? ORDER BY last_event_at DESC`)
      .all(teamName) as Row[];
    return rows.map(rowToRecord);
  },

  /**
   * 把 sessions 表里 fromId 改名 toId，并把 events / file_changes / summaries
   * 的 session_id 引用一起迁移。整体在事务内做，避免外键 CASCADE 误删历史。
   * 用于 SDK fallback：tempKey 占位行 → 真实 session_id 出现后无损迁移。
   *
   * REVIEW_17 R2 / H1-R2：toExists=true 分支（recoverAndSend jsonl-missing 走
   * 不带 resume 的 createSession + 事后 rename 时触发——NEW_ID 已被 createSession
   * 写过一行）原本仅迁子表 + DELETE OLD，team_name / permission_mode 等用户预期
   * 跟随 OLD 一起搬过来的字段被丢弃。比如：lead 在 team-X 收到「会话恢复」后
   * 永久 team_name=NULL，TeamHub 卡片消失 + inbox-watcher refreshAutoSubscribe
   * 取消订阅 → teammate 写入的 permission_request 全部丢失（违反 CLAUDE.md
   * 「会话恢复 / resume 优先」节会话身份持续性约束）。
   *
   * 修法：toExists=true 时把 fromRow 的 team_name / permission_mode 同步覆盖到
   * 新行（这两列「会话身份持续性」相关）。其他列（cwd / title / activity / lifecycle
   * 等）由 createSession 已写就绪，不应被 OLD 行旧值覆盖。
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
        // 13 列 = 13 个 ?；CHANGELOG_35 引入 team_name 时一度多算了一个 ? 占位（14 个），
        // 触发场景是 SDK fallback rename / CLI 隐式 fork（first realId !== opts.resume）
        // 走到这条 INSERT 时 better-sqlite3 抛 `14 values for 13 columns`。务必让 ? 数与列数一致。
        db.prepare(
          `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at, ended_at, archived_at, permission_mode, team_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          fromRow.team_name,
        );
      }
      // 迁移子表引用（外键 ON DELETE CASCADE 在删 fromId 时不会误删，因为 session_id 已改）
      db.prepare(`UPDATE events SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
      db.prepare(`UPDATE file_changes SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
      db.prepare(`UPDATE summaries SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
      // REVIEW_17 R2 / H1-R2：toExists=true 时（recoverAndSend jsonl-missing fallback）
      // 把会话身份相关字段从 OLD 行覆盖到 NEW 行，避免 team_name / permission_mode 被 NEW 行
      // createSession 时写的默认值（NULL / 'default'）「淹没」掉用户的真实状态。
      // 仅在 toExists=true 才需要手动覆盖：toExists=false 走上面 INSERT 已经全列复制。
      if (toExists && fromRow.team_name) {
        db.prepare(`UPDATE sessions SET team_name = ? WHERE id = ?`).run(fromRow.team_name, toId);
      }
      if (toExists && fromRow.permission_mode) {
        db.prepare(`UPDATE sessions SET permission_mode = ? WHERE id = ?`).run(
          fromRow.permission_mode,
          toId,
        );
      }
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
