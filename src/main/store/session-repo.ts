import type {
  ActivityState,
  GenericPtyConfig,
  LifecycleState,
  PermissionMode,
  SessionRecord,
  SessionSource,
} from '@shared/types';
import { genericPtyConfigSchema } from '@shared/types';
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
  // plan team-cohesion-fix-20260513 Phase A Step A9：team_name 列已 v014 drop，Row 接口不再含
  codex_sandbox: string | null;
  claude_code_sandbox: string | null;
  spawned_by: string | null;
  spawn_depth: number;
  generic_pty_config: string | null;
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
    // plan team-cohesion-fix-20260513 Phase A Step A9：teamName 字段不在 repo 层投影。
    // sessionManager.enrichWithTeams / enrichWithTeamsBatch 在更高层注入 teams[] 数组 + teamName fallback。
    // 老 sessions.team_name 列已 v014 drop。
    codexSandbox: (r.codex_sandbox as
      | 'workspace-write'
      | 'read-only'
      | 'danger-full-access'
      | null) ?? null,
    claudeCodeSandbox: (r.claude_code_sandbox as
      | 'off'
      | 'workspace-write'
      | 'strict'
      | null) ?? null,
    spawnedBy: r.spawned_by ?? null,
    spawnDepth: r.spawn_depth ?? 0,
    genericPtyConfig: parseGenericPtyConfigJson(r.generic_pty_config),
  };
}

/**
 * sessions.generic_pty_config 列存的是 JSON.stringify(GenericPtyConfig)。
 * 解析失败 / NULL → null（不抛错，老脏数据 / NULL 都安全 fallback）。
 *
 * REVIEW_24 codex MED 6：原仅 JSON.parse + cast，合法 JSON 如 `"x"` / `42` / `[]` /
 * `{}` 不会 fallback null 而被当 GenericPtyConfig 返回 → 下游 adapter 拿 invalid config
 * 起 PTY 时 spawn 失败或更糟 silent 误用。修法：JSON.parse 后再走 zod schema parse 二次
 * 校验，partial / 类型不对都 fallback null。
 *
 * 设计取舍：写入端（IPC handler / adapter.createSession）已 zod parse 防脏；读取端二次
 * 校验是 defense-in-depth — 防止用户手改 DB / migration 故障 / 历史脏数据等情形。
 */
function parseGenericPtyConfigJson(raw: string | null): GenericPtyConfig | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = genericPtyConfigSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export const sessionRepo = {
  upsert(rec: SessionRecord): void {
    // 注意：permission_mode 也参与 INSERT 与 UPDATE，否则 SessionRecord 接口
    // 与 SQL 字段集错位 —— 复活 closed 会话用 `{...existing, lifecycle:'active'}`
    // spread 调 upsert 时，spread 进来的 permissionMode 被静默丢弃，
    // 未来想通过 upsert 改这些字段会神秘失败（写了不报错但不生效）。
    // CHANGELOG_<X> A2a：codex_sandbox 同样必须参与 INSERT / UPDATE，避免 spread 调用
    // 时静默丢弃用户在 NewSessionDialog 选过的 sandbox 档位。
    // CHANGELOG_74：claude_code_sandbox 同款（claude OS 沙盒 per-session 覆盖与 codex 对称）。
    // R4·F2：generic_pty_config 同款 — generic-pty / aider session 的 spawn config 必须
    // 在 upsert 时透传，否则 lifecycle 复活路径丢失 config，resume 按错 args 重 spawn。
    // plan team-cohesion-fix-20260513 Phase A Step A9：team_name 列已 v014 drop，
    // 不再参与 INSERT / UPDATE / spread，团队归属走 universal team backend SSOT。
    getDb()
      .prepare(
        `INSERT INTO sessions
         (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at, ended_at, archived_at, permission_mode, codex_sandbox, claude_code_sandbox, spawned_by, spawn_depth, generic_pty_config)
         VALUES (@id, @agent_id, @cwd, @title, @source, @lifecycle, @activity, @started_at, @last_event_at, @ended_at, @archived_at, @permission_mode, @codex_sandbox, @claude_code_sandbox, @spawned_by, @spawn_depth, @generic_pty_config)
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
           codex_sandbox = excluded.codex_sandbox,
           claude_code_sandbox = excluded.claude_code_sandbox,
           spawned_by = excluded.spawned_by,
           spawn_depth = excluded.spawn_depth,
           generic_pty_config = excluded.generic_pty_config`,
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
        codex_sandbox: rec.codexSandbox ?? null,
        claude_code_sandbox: rec.claudeCodeSandbox ?? null,
        spawned_by: rec.spawnedBy ?? null,
        spawn_depth: rec.spawnDepth ?? 0,
        generic_pty_config: rec.genericPtyConfig ? JSON.stringify(rec.genericPtyConfig) : null,
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

  /**
   * 写入 codex sandbox 档位（CHANGELOG_<X> A2a：仅 codex-cli adapter 调用）。
   * null 表示恢复用 settings.codexSandbox 全局值（与 createSession 路径 fallback 同模式）。
   * claude / aider / generic-pty adapter 不应调此方法（字段对它们无意义）。
   */
  setCodexSandbox(
    id: string,
    sandbox: 'workspace-write' | 'read-only' | 'danger-full-access' | null,
  ): void {
    getDb().prepare(`UPDATE sessions SET codex_sandbox = ? WHERE id = ?`).run(sandbox, id);
  },

  /**
   * 写入 claude OS sandbox 档位（CHANGELOG_74：仅 claude-code adapter 调用）。
   * null 表示恢复用 settings.claudeCodeSandbox 全局值（与 createSession 路径 fallback 同模式）。
   * codex / aider / generic-pty adapter 不应调此方法（字段对它们无意义）。
   * 与 setCodexSandbox 完全对称的字面镜像。
   */
  setClaudeCodeSandbox(
    id: string,
    sandbox: 'off' | 'workspace-write' | 'strict' | null,
  ): void {
    getDb().prepare(`UPDATE sessions SET claude_code_sandbox = ? WHERE id = ?`).run(sandbox, id);
  },

  /**
   * R4·F2：写入 generic-pty / aider session 的 spawn config。
   * 仅 generic-pty / aider adapter 的 createSession / config 微调路径调；
   * claude-code / codex-cli adapter 不应调（字段对它们无意义）。
   * config=null → 清空（极少用，正常 session 删除走 sessionRepo.delete 整行）。
   */
  setGenericPtyConfig(id: string, config: GenericPtyConfig | null): void {
    const json = config ? JSON.stringify(config) : null;
    getDb().prepare(`UPDATE sessions SET generic_pty_config = ? WHERE id = ?`).run(json, id);
  },

  /**
   * 把 sessions 表里 fromId 改名 toId，并把 events / file_changes / summaries
   * 的 session_id 引用一起迁移。整体在事务内做，避免外键 CASCADE 误删历史。
   * 用于 SDK fallback：tempKey 占位行 → 真实 session_id 出现后无损迁移。
   *
   * REVIEW_17 R2 / H1-R2：toExists=true 分支（recoverAndSend jsonl-missing 走
   * 不带 resume 的 createSession + 事后 rename 时触发——NEW_ID 已被 createSession
   * 写过一行）原本仅迁子表 + DELETE OLD，permission_mode 等用户预期
   * 跟随 OLD 一起搬过来的字段被丢弃。比如：用户在 OLD 里选了 acceptEdits 模式，
   * recoverAndSend 路径 createSession 默认 'default' → 修复后用户 permissionMode 丢档。
   *
   * 修法：toExists=true 时把 fromRow 的 permission_mode / spawn_link 同步覆盖到
   * 新行（这两类是「会话身份持续性」相关）。其他列（cwd / title / activity / lifecycle
   * 等）由 createSession 已写就绪，不应被 OLD 行旧值覆盖。
   *
   * plan team-cohesion-fix-20260513 Phase A Step A9：team_name 列已 v014 drop，
   * rename 路径不再需要复制 team_name 字段。team 关系由 universal team backend
   * (agent_deck_team_members) 维护，session_id 改名时需调 sessionManager.delete
   * 路径的 leaveTeam 兜底（已实现），或 rename 后由 caller 自行 leaveTeam(OLD) +
   * addMember(NEW)。
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
        // CHANGELOG_<X> R2 / B'0 ADR §6.5.2 #2-#3：列清单扩到 16 列（顺手补 v008
        // codex_sandbox 漏列 latent bug，再加 R2 v009 spawned_by/spawn_depth）。
        // R4·F2：列再扩 1 → 17 列（generic_pty_config）。
        // CHANGELOG_74：列再扩 1 → 18 列（claude_code_sandbox）。
        // plan team-cohesion-fix-20260513 Phase A Step A9：v014 drop sessions.team_name 后
        // 列回缩 1 → 17 列。
        db.prepare(
          `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at, ended_at, archived_at, permission_mode, codex_sandbox, claude_code_sandbox, spawned_by, spawn_depth, generic_pty_config)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          fromRow.codex_sandbox,
          fromRow.claude_code_sandbox,
          fromRow.spawned_by,
          fromRow.spawn_depth,
          fromRow.generic_pty_config,
        );
      }
      // 迁移子表引用（外键 ON DELETE CASCADE 在删 fromId 时不会误删，因为 session_id 已改）
      db.prepare(`UPDATE events SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
      db.prepare(`UPDATE file_changes SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
      db.prepare(`UPDATE summaries SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
      // REVIEW_17 R2 / H1-R2：toExists=true 时（recoverAndSend jsonl-missing fallback）
      // 把会话身份相关字段从 OLD 行覆盖到 NEW 行，避免 permission_mode 被 NEW 行
      // createSession 时写的默认值（'default'）「淹没」掉用户的真实状态。
      // 仅在 toExists=true 才需要手动覆盖：toExists=false 走上面 INSERT 已经全列复制。
      if (toExists && fromRow.permission_mode) {
        db.prepare(`UPDATE sessions SET permission_mode = ? WHERE id = ?`).run(
          fromRow.permission_mode,
          toId,
        );
      }
      if (toExists && fromRow.codex_sandbox) {
        db.prepare(`UPDATE sessions SET codex_sandbox = ? WHERE id = ?`).run(
          fromRow.codex_sandbox,
          toId,
        );
      }
      if (toExists && fromRow.claude_code_sandbox) {
        // CHANGELOG_74：与 codex_sandbox 同款 — recoverAndSend / SDK fallback rename 时
        // 必须从 fromRow 覆盖到 NEW 行，否则用户在 NewSessionDialog / ComposerSdk 选过的
        // OS 沙盒档位被 NEW 行 createSession 时写的全局默认值「淹没」掉。
        db.prepare(`UPDATE sessions SET claude_code_sandbox = ? WHERE id = ?`).run(
          fromRow.claude_code_sandbox,
          toId,
        );
      }
      if (toExists && fromRow.spawned_by) {
        db.prepare(`UPDATE sessions SET spawned_by = ? WHERE id = ?`).run(
          fromRow.spawned_by,
          toId,
        );
      }
      if (toExists && fromRow.spawn_depth > 0) {
        db.prepare(`UPDATE sessions SET spawn_depth = ? WHERE id = ?`).run(
          fromRow.spawn_depth,
          toId,
        );
      }
      if (toExists && fromRow.generic_pty_config) {
        // R4·F2：generic-pty / aider session 的 spawn config 是会话身份相关字段，
        // recoverAndSend / SDK fallback rename 时必须从 fromRow 覆盖到 NEW 行，
        // 否则 lifecycle 复活路径丢失 config，resume 按错 args 重 spawn（与 codex_sandbox 同模式）。
        db.prepare(`UPDATE sessions SET generic_pty_config = ? WHERE id = ?`).run(
          fromRow.generic_pty_config,
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

  // ──────────── Agent Deck MCP server (R2 / B'0 ADR §6.5) ────────────

  /**
   * 单查 sessions.spawn_depth。session 不存在返回 0（兜底，与 spawn_session
   * handler 计算「parent_depth + 1」保持一致：未知 caller → 默认顶层）。
   * 用于 §6.1 depth 上限校验。
   */
  getSpawnDepth(id: string): number {
    const row = getDb()
      .prepare(`SELECT spawn_depth FROM sessions WHERE id = ?`)
      .get(id) as { spawn_depth: number } | undefined;
    return row?.spawn_depth ?? 0;
  },

  /**
   * UPDATE sessions SET spawned_by, spawn_depth WHERE id = ?。
   * MCP `spawn_session` handler 在 reserve 占位行 + createSession 后调，
   * 写入 spawn 链路关系。session 必须先存在（通常先 INSERT 占位行 / 由 createSession
   * adapter 写入），否则该调用静默失败（changes=0）。
   */
  setSpawnLink(id: string, spawnedBy: string | null, depth: number): void {
    getDb()
      .prepare(`UPDATE sessions SET spawned_by = ?, spawn_depth = ? WHERE id = ?`)
      .run(spawnedBy, depth, id);
  },

  /**
   * 沿 spawn_chain 整链回溯：返回 id 所有祖先（不含 id 自身）的 SessionRecord 数组，
   * 按祖先深度从近到远排列（直接父在 [0]，祖父在 [1] ...）。
   * 链长 ≤ MAX_DEPTH（默认 3），反查 cost O(depth) 可忽略。
   *
   * **2026-05 deprecated**（REVIEW_28）：原 §6.2 cwd realpath 整链 cycle 检测已移除
   * （详 spawn-guards.ts 头注释）。当前生产代码无调用点；保留实现避免 R3 / R4 重构
   * churn，未来若确认无新依赖可一并删除。
   *
   * 防御循环：若链上出现自指向（不应发生，但 ON DELETE SET NULL + 历史脏数据可能），
   * 用 visited Set 提前 break，避免死循环。
   */
  listAncestors(id: string): SessionRecord[] {
    const ancestors: SessionRecord[] = [];
    const visited = new Set<string>([id]);
    const db = getDb();
    const stmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
    let cursor: string | null = id;
    while (cursor !== null) {
      const row = stmt.get(cursor) as Row | undefined;
      if (!row) break;
      const parentId = row.spawned_by;
      if (parentId === null || parentId === undefined) break;
      if (visited.has(parentId)) break; // 自指向防御
      visited.add(parentId);
      const parentRow = stmt.get(parentId) as Row | undefined;
      if (!parentRow) break;
      ancestors.push(rowToRecord(parentRow));
      cursor = parentRow.spawned_by;
    }
    return ancestors;
  },

  /**
   * 列出 spawnedBy = parentId 的所有 active children（用于 §6.4 per-parent fan-out）。
   * 默认仅返回 lifecycle = 'active'；可通过 lifecycle 参数 override（'all' = 不限）。
   */
  listChildren(parentId: string, lifecycle: LifecycleState | 'all' = 'active'): SessionRecord[] {
    const db = getDb();
    const rows =
      lifecycle === 'all'
        ? (db
            .prepare(
              `SELECT * FROM sessions WHERE spawned_by = ? AND archived_at IS NULL ORDER BY started_at DESC`,
            )
            .all(parentId) as Row[])
        : (db
            .prepare(
              `SELECT * FROM sessions WHERE spawned_by = ? AND lifecycle = ? AND archived_at IS NULL ORDER BY started_at DESC`,
            )
            .all(parentId, lifecycle) as Row[]);
    return rows.map(rowToRecord);
  },
};
