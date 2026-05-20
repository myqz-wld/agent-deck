/**
 * session-repo —— core CRUD（upsert / get / list*）+ per-session settings setter
 * (permissionMode / title / codexSandbox / claudeCodeSandbox / model / extraAllowWrite) + delete。
 *
 * 拆分历史：从 src/main/store/session-repo.ts 抽出（CHANGELOG_83 / plan
 * deep-review-and-split-20260513 H2 Step 2.3）。
 */

import type { PermissionMode, SessionRecord } from '@shared/types';
import { getDb } from '../db';
import { buildKeywordPredicate } from '../search-predicate';
import { rowToRecord, type Row } from './types';

export function upsert(rec: SessionRecord): void {
  // 注意：permission_mode 也参与 INSERT 与 UPDATE，否则 SessionRecord 接口
  // 与 SQL 字段集错位 —— 复活 closed 会话用 `{...existing, lifecycle:'active'}`
  // spread 调 upsert 时，spread 进来的 permissionMode 被静默丢弃，
  // 未来想通过 upsert 改这些字段会神秘失败（写了不报错但不生效）。
  // CHANGELOG_<X> A2a：codex_sandbox 同样必须参与 INSERT / UPDATE，避免 spread 调用
  // 时静默丢弃用户在 NewSessionDialog 选过的 sandbox 档位。
  // CHANGELOG_74：claude_code_sandbox 同款（claude OS 沙盒 per-session 覆盖与 codex 对称）。
  // R4·F2：generic_pty_config 同款 — generic-pty / aider session 的 spawn config 必须
  // 在 upsert 时透传，否则 lifecycle 复活路径丢失 config，resume 按错 args 重 spawn。
  // plan model-wiring-and-handoff-20260514 Step 1.3：model 同款 — spawn 时 frontmatter `model`
  // 透传给 SDK 后持久化，让 SDK resume / dormant 唤醒后保持模型一致；upsert 必须参与
  // 否则 lifecycle 复活路径丢字段，resume 拿不到 model。
  // plan cross-adapter-parity-20260515 Phase A Step A.2：extra_allow_write 同款 — caller
  // 透传的 SDK sandbox 额外可写根 spawn 时持久化,让 recoverer / SDK resume 路径还原
  // sandbox.allowWrite,与 codex_sandbox / claude_code_sandbox / model 同 per-session
  // resilience 模式;upsert 必须参与否则 lifecycle 复活路径丢字段。
  // plan codex-handoff-team-alignment-20260518 P1 Step 1.1 / 不变量 5 + D2：cwd_release_marker
  // 同款 — mcp enter_worktree marker 让 archive_plan 预检 4 态分流认得跨 adapter 路径,upsert
  // 必须参与否则 lifecycle 复活路径丢失 marker（与 codex_sandbox / extra_allow_write 同模式;
  // rename 路径 H1 关键修法也依赖此字段在 fork 后跟到 NEW 行）。
  // plan team-cohesion-fix-20260513 Phase A Step A9：team_name 列已 v014 drop，
  // 不再参与 INSERT / UPDATE / spread，团队归属走 universal team backend SSOT。
  getDb()
    .prepare(
      `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at, ended_at, archived_at, permission_mode, codex_sandbox, claude_code_sandbox, model, extra_allow_write, cwd_release_marker, spawned_by, spawn_depth, generic_pty_config)
       VALUES (@id, @agent_id, @cwd, @title, @source, @lifecycle, @activity, @started_at, @last_event_at, @ended_at, @archived_at, @permission_mode, @codex_sandbox, @claude_code_sandbox, @model, @extra_allow_write, @cwd_release_marker, @spawned_by, @spawn_depth, @generic_pty_config)
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
         model = excluded.model,
         extra_allow_write = excluded.extra_allow_write,
         cwd_release_marker = excluded.cwd_release_marker,
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
      model: rec.model ?? null,
      extra_allow_write:
        rec.extraAllowWrite && rec.extraAllowWrite.length > 0
          ? JSON.stringify(rec.extraAllowWrite)
          : null,
      cwd_release_marker: rec.cwdReleaseMarker ?? null,
      spawned_by: rec.spawnedBy ?? null,
      spawn_depth: rec.spawnDepth ?? 0,
      generic_pty_config: null,
    });
}

export function get(id: string): SessionRecord | null {
  const row = getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

export function listActiveAndDormant(limit = 100): SessionRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE lifecycle IN ('active', 'dormant') AND archived_at IS NULL
       ORDER BY last_event_at DESC
       LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map(rowToRecord);
}

/**
 * 历史面板数据源。语义改为：
 * - 默认（archivedOnly=false）：包含 closed + 任何已归档（不论 lifecycle），
 *   也就是「不在实时面板的所有会话」
 * - archivedOnly=true：只看 archived_at IS NOT NULL
 */
export function listHistory(
  opts: {
    agentId?: string;
    cwd?: string;
    fromTs?: number;
    toTs?: number;
    keyword?: string;
    archivedOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): SessionRecord[] {
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
}

export function _delete(id: string): void {
  // 注：导出名 `_delete` 因 `delete` 是 reserved word；facade 里 spread 时改回 `delete: _delete`
  getDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

/** 写入用户在 UI 上选过的权限模式。null 表示恢复默认（'default'）。 */
export function setPermissionMode(id: string, mode: PermissionMode | null): void {
  getDb().prepare(`UPDATE sessions SET permission_mode = ? WHERE id = ?`).run(mode, id);
}

/**
 * REVIEW_31 Bug 4：spawn_session 路径让 caller 显式给 teammate 一个有意义的 title
 * （如 'reviewer-claude' / 'reviewer-codex' / 自定义角色），覆盖默认的 cwd-basename 派生值。
 * UI 列表 / SessionCard / TeamDetail 全走 session.title 渲染，改这一处即所有显示位生效。
 * caller 只在「确实拿到非空 title」时才调（spawn handler 内 fallback 链：display_name > agent_name）。
 */
export function setTitle(id: string, title: string): void {
  getDb().prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, id);
}

/**
 * 写入 codex sandbox 档位（CHANGELOG_<X> A2a：仅 codex-cli adapter 调用）。
 * null 表示恢复用 settings.codexSandbox 全局值（与 createSession 路径 fallback 同模式）。
 * claude / aider / generic-pty adapter 不应调此方法（字段对它们无意义）。
 */
export function setCodexSandbox(
  id: string,
  sandbox: 'workspace-write' | 'read-only' | 'danger-full-access' | null,
): void {
  getDb().prepare(`UPDATE sessions SET codex_sandbox = ? WHERE id = ?`).run(sandbox, id);
}

/**
 * 写入 claude OS sandbox 档位（CHANGELOG_74：仅 claude-code adapter 调用）。
 * null 表示恢复用 settings.claudeCodeSandbox 全局值（与 createSession 路径 fallback 同模式）。
 * codex / aider / generic-pty adapter 不应调此方法（字段对它们无意义）。
 * 与 setCodexSandbox 完全对称的字面镜像。
 */
export function setClaudeCodeSandbox(
  id: string,
  sandbox: 'off' | 'workspace-write' | 'strict' | null,
): void {
  getDb().prepare(`UPDATE sessions SET claude_code_sandbox = ? WHERE id = ?`).run(sandbox, id);
}

/**
 * 写入 SDK / agent model（plan model-wiring-and-handoff-20260514 Step 1.3）。
 *
 * 调用方：
 * - claude-code adapter createSession：opts.model 非空时调，让 SDK resume / dormant 唤醒后
 *   保持模型一致（与 setPermissionMode / setClaudeCodeSandbox 同款 per-session 持久化）
 * - codex-cli adapter createSession：opts.model 非空时也调（runtime 不生效但写库便于 UI 显示）
 *
 * model=null → 清空（恢复"不指定，跟 SDK 默认 / ANTHROPIC_MODEL env"语义）。
 * 与 setCodexSandbox / setClaudeCodeSandbox 完全对称的字面镜像。
 */
export function setModel(id: string, model: string | null): void {
  getDb().prepare(`UPDATE sessions SET model = ? WHERE id = ?`).run(model, id);
}

/**
 * 写入 SDK sandbox 额外可写根（plan cross-adapter-parity-20260515 Phase A Step A.2 /
 * REVIEW_40 R1 reviewer-codex MED-F follow-up）。
 *
 * 调用方:
 * - claude-code adapter session-finalize:opts.extraAllowWrite 非空时调,让 SDK resume /
 *   dormant 唤醒 / app 重启 / sdk-bridge state lost 后,recoverer 路径仍能从 sessionRepo
 *   读回交还 SDK sandbox.allowWrite(workspace-write 档生效)
 * - codex-cli adapter session-finalize:opts.extraAllowWrite 非空时也调(parity 对称写库,
 *   runtime 不消费 — codex SDK 不支持 extra writable roots);future codex SDK 加支持时零迁移
 * - aider / generic-pty adapter:不应调(字段对它们无意义)
 *
 * `paths`:绝对路径数组;空数组 / null → 列写 NULL(语义同 caller 不传 extraAllowWrite,
 * sandbox.allowWrite 不增 root)。
 */
export function setExtraAllowWrite(id: string, paths: string[] | null): void {
  const json = paths && paths.length > 0 ? JSON.stringify(paths) : null;
  getDb().prepare(`UPDATE sessions SET extra_allow_write = ? WHERE id = ?`).run(json, id);
}

/**
 * 写入 mcp enter_worktree marker（plan codex-handoff-team-alignment-20260518 P1 Step 1.1 /
 * 不变量 5 + D2）。
 *
 * 调用方:
 * - mcp `enter_worktree` handler: git worktree add 成功后调 setCwdReleaseMarker(sid, worktreePath)
 *   标记 caller 显式持有该 worktreePath, 让 archive_plan 预检 4 态分流认得跨 adapter 路径
 * - mcp `exit_worktree` handler: ExitWorktree 完成后调 clearCwdReleaseMarker(sid) = setCwdReleaseMarker(sid, null)
 * - sessionManager.close hook: session close 时调 clearCwdReleaseMarker 避免 marker 残留
 *
 * marker = worktreePath 绝对路径（caller 当前持有）；marker = null 视为「未持有 marker」
 * （caller 走 claude builtin 路径或还没调 mcp enter_worktree）。
 *
 * SDK fork / recover rename 路径必须把此列从 fromRow 复制到 NEW 行（详 rename.ts H1 修法）—
 * 否则 codex teammate enter_worktree 设的 marker 在 fork 后丢失, 下次 archive_plan 预检走
 * 「在 worktree 内 + 无 marker」分支 reject。
 *
 * 与 setCodexSandbox / setClaudeCodeSandbox 完全对称的字面镜像。
 */
export function setCwdReleaseMarker(id: string, marker: string | null): void {
  getDb().prepare(`UPDATE sessions SET cwd_release_marker = ? WHERE id = ?`).run(marker, id);
}

export function clearCwdReleaseMarker(id: string): void {
  setCwdReleaseMarker(id, null);
}
