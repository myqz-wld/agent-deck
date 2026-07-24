/**
 * session-repo —— core CRUD（upsert / get / list*）+ per-session settings setter
 * (permissionMode / title / codexSandbox / claudeCodeSandbox / model / thinking / extraAllowWrite /
 *  networkAccessEnabled / additionalDirectories) + delete。
 *
 * 拆分历史：从 src/main/store/session-repo.ts 抽出（CHANGELOG_83 / plan
 * deep-review-and-split-20260513 H2 Step 2.3）。
 */

import type {
  AdapterSessionMode,
  PermissionMode,
  SessionRecord,
} from '@shared/types';
import { getDb } from '../db';
import { rowToRecord, type Row } from './types';
export function upsert(rec: SessionRecord): void {
  // 注意：permission_mode 也参与 INSERT 与 UPDATE，否则 SessionRecord 接口
  // 与 SQL 字段集错位 —— 复活 closed 会话用 `{...existing, lifecycle:'active'}`
  // spread 调 upsert 时，spread 进来的 permissionMode 被静默丢弃，
  // 未来想通过 upsert 改这些字段会神秘失败（写了不报错但不生效）。
  // CHANGELOG_<X> A2a：codex_sandbox 同样必须参与 INSERT / UPDATE，避免 spread 调用
  // 时静默丢弃用户在 NewSessionDialog 选过的 sandbox 档位。
  // CHANGELOG_74：claude_code_sandbox 同款（claude OS 沙盒 per-session 覆盖与 codex 对称）。
  // R4·F2：generic_pty_config 同款 — 老 PTY-based session 的 spawn config 必须
  // 在 upsert 时透传，否则 lifecycle 复活路径丢失 config，resume 按错 args 重 spawn。
  // (plan remove-aider-generic-pty-adapters-20260520 后 adapter 已删,新 session
  // 永远 binding null;column 保留兼容老 SQLite rows。)
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
  // plan codex-handoff-team-alignment-20260518 P1 Step 1.1 / 不变量 5 + D2：cwd_release_marker
  // 同款 — mcp enter_worktree marker 让 archive_plan 预检 4 态分流认得跨 adapter 路径,upsert
  // 必须参与否则 lifecycle 复活路径丢失 marker（与 codex_sandbox / extra_allow_write 同模式;
  // rename 路径 H1 关键修法也依赖此字段在 fork 后跟到 NEW 行）。
  // plan reverse-rename-sid-stability-20260520 §A.1 / 设计决策 D1 / 不变量 2:cli_session_id
  // 列扩 (列 21,与 v020 cwd_release_marker pattern 同款 upsert 透传) — 让 lifecycle 复活路径不
  // 丢 cli_session_id;rename 路径 §A.2 重写规则:spawn 主路径 (toExists=false INSERT) hardcode
  // toId / toExists=true 分支保留 NEW 行已有 cli_session_id 不覆盖(详 rename.ts)。
  // plan team-cohesion-fix-20260513 Phase A Step A9：team_name 列已 v014 drop，
  // 不再参与 INSERT / UPDATE / spread，团队归属走 universal team backend SSOT。
  // plan codex-recover-network-dirs-parity-20260602：network_access_enabled +
  // additional_directories 同款（v029）— reviewer-codex spawn-time default 持久化让 recover /
  // restart 路径还原 codex SDK 网络访问 + 额外可读写目录；upsert 必须参与否则 lifecycle 复活
  // 路径丢字段。**boolean→int 手转**（better-sqlite3 拒绝 raw boolean bind）。
  getDb()
    .prepare(
      `INSERT INTO sessions
       (id, agent_id, runtime_provider, cwd, title, source, lifecycle, activity, started_at, last_event_at, ended_at, archived_at, permission_mode, session_mode, codex_sandbox, claude_code_sandbox, model, thinking, extra_allow_write, cwd_release_marker, spawned_by, spawn_depth, generic_pty_config, cli_session_id, network_access_enabled, additional_directories, pinned_at, hidden_from_history)
       VALUES (@id, @agent_id, @runtime_provider, @cwd, @title, @source, @lifecycle, @activity, @started_at, @last_event_at, @ended_at, @archived_at, @permission_mode, @session_mode, @codex_sandbox, @claude_code_sandbox, @model, @thinking, @extra_allow_write, @cwd_release_marker, @spawned_by, @spawn_depth, @generic_pty_config, @cli_session_id, @network_access_enabled, @additional_directories, @pinned_at, @hidden_from_history)
       ON CONFLICT(id) DO UPDATE SET
         runtime_provider = excluded.runtime_provider,
         cwd = excluded.cwd,
         title = excluded.title,
         source = excluded.source,
         lifecycle = excluded.lifecycle,
         activity = excluded.activity,
         last_event_at = excluded.last_event_at,
         ended_at = excluded.ended_at,
         archived_at = excluded.archived_at,
         permission_mode = excluded.permission_mode,
         session_mode = excluded.session_mode,
         codex_sandbox = excluded.codex_sandbox,
         claude_code_sandbox = excluded.claude_code_sandbox,
         model = excluded.model,
         thinking = excluded.thinking,
         extra_allow_write = excluded.extra_allow_write,
         cwd_release_marker = excluded.cwd_release_marker,
         spawned_by = excluded.spawned_by,
         spawn_depth = excluded.spawn_depth,
         generic_pty_config = excluded.generic_pty_config,
         cli_session_id = excluded.cli_session_id,
         network_access_enabled = excluded.network_access_enabled,
         additional_directories = excluded.additional_directories`,
    )
    .run({
      id: rec.id,
      agent_id: rec.agentId,
      runtime_provider: rec.runtimeProvider ?? null,
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
      session_mode: rec.sessionMode ?? null,
      codex_sandbox: rec.codexSandbox ?? null,
      claude_code_sandbox: rec.claudeCodeSandbox ?? null,
      model: rec.model ?? null,
      thinking: rec.thinking ?? null,
      extra_allow_write:
        rec.extraAllowWrite && rec.extraAllowWrite.length > 0
          ? JSON.stringify(rec.extraAllowWrite)
          : null,
      cwd_release_marker: rec.cwdReleaseMarker ?? null,
      spawned_by: rec.spawnedBy ?? null,
      spawn_depth: rec.spawnDepth ?? 0,
      generic_pty_config: null,
      cli_session_id: rec.cliSessionId ?? null,
      // plan codex-recover-network-dirs-parity-20260602：boolean→int 手转（better-sqlite3 拒绝
      // raw boolean bind）。null（未设）保持 null 走 SDK 默认；additional_directories 同
      // extra_allow_write JSON.stringify 空数组→null。
      network_access_enabled:
        rec.networkAccessEnabled == null ? null : rec.networkAccessEnabled ? 1 : 0,
      additional_directories:
        rec.additionalDirectories && rec.additionalDirectories.length > 0
          ? JSON.stringify(rec.additionalDirectories)
          : null,
      // Pin state has one dedicated setter. It participates in first INSERT, but is deliberately
      // absent from ON CONFLICT so a stale full-record upsert cannot undo a concurrent pin toggle.
      pinned_at: rec.pinnedAt ?? null,
      // Internal visibility is registration-owned and immutable across stale full-record upserts.
      hidden_from_history: rec.hiddenFromHistory ? 1 : 0,
    });
}

export function get(id: string): SessionRecord | null {
  const row = getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

export function listActiveAndDormant(
  limit = 100,
  offset = 0,
  lifecycle?: 'active' | 'dormant',
  spawnedBy?: string,
  agentId?: string,
): SessionRecord[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (lifecycle) {
    conditions.push(`lifecycle = ?`);
    params.push(lifecycle);
  } else {
    conditions.push(`lifecycle IN ('active', 'dormant')`);
  }
  conditions.push(`archived_at IS NULL`);
  if (spawnedBy !== undefined) {
    conditions.push(`spawned_by = ?`);
    params.push(spawnedBy);
  }
  if (agentId !== undefined) {
    conditions.push(`agent_id = ?`);
    params.push(agentId);
  }
  params.push(limit, offset);
  const rows = getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE ${conditions.join(' AND ')}
       ORDER BY last_event_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params) as Row[];
  return rows.map(rowToRecord);
}

/**
 * Real-time renderer list: every pinned row survives capacity, then the result expands beyond that
 * capacity for live structural owners required by the renderer tree. The recursive closure follows
 * both spawn ancestors and active universal-team leads for teammate rows; UNION dedupes cycles.
 */
export function listLiveForUi(limit = 100): SessionRecord[] {
  const db = getDb();
  return db.transaction(() => {
    const pinnedCount = db
      .prepare(
        `SELECT COUNT(*) FROM sessions
         WHERE archived_at IS NULL AND lifecycle IN ('active', 'dormant')
           AND pinned_at IS NOT NULL`,
      )
      .pluck()
      .get() as number;
    const effectiveLimit = Math.max(Math.trunc(limit), pinnedCount, 0);
    const rows = db
      .prepare(
        `WITH RECURSIVE
         seed_ids(id) AS (
           SELECT id FROM sessions
           WHERE archived_at IS NULL AND lifecycle IN ('active', 'dormant')
           ORDER BY pinned_at DESC, last_event_at DESC, id ASC
           LIMIT ?
         ),
         visible_ids(id) AS (
           SELECT id FROM seed_ids
           UNION
           SELECT parent.id
           FROM visible_ids AS visible
           INNER JOIN sessions AS child ON child.id = visible.id
           INNER JOIN sessions AS parent ON parent.id = child.spawned_by
           WHERE parent.archived_at IS NULL
             AND parent.lifecycle IN ('active', 'dormant')
           UNION
           SELECT lead_session.id
           FROM visible_ids AS visible
           INNER JOIN agent_deck_team_members AS teammate
             ON teammate.session_id = visible.id
            AND teammate.role = 'teammate'
            AND teammate.left_at IS NULL
           INNER JOIN agent_deck_team_members AS lead
             ON lead.team_id = teammate.team_id
            AND lead.role = 'lead'
            AND lead.left_at IS NULL
           INNER JOIN sessions AS lead_session ON lead_session.id = lead.session_id
           WHERE lead_session.archived_at IS NULL
             AND lead_session.lifecycle IN ('active', 'dormant')
         )
         SELECT session.* FROM sessions AS session
         INNER JOIN visible_ids AS visible ON visible.id = session.id
         ORDER BY session.pinned_at DESC, session.last_event_at DESC, session.id ASC`,
      )
      .all(effectiveLimit) as Row[];
    return rows.map(rowToRecord);
  })();
}

export function _delete(id: string): void {
  // 注：导出名 `_delete` 因 `delete` 是 reserved word；facade 里 spread 时改回 `delete: _delete`
  getDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

/** 写入用户在 UI 上选过的权限模式。null 表示恢复默认（'default'）。 */
export function setPermissionMode(id: string, mode: PermissionMode | null): void {
  getDb().prepare(`UPDATE sessions SET permission_mode = ? WHERE id = ?`).run(mode, id);
}

export function setSessionMode(id: string, mode: AdapterSessionMode | null): void {
  getDb().prepare(`UPDATE sessions SET session_mode = ? WHERE id = ?`).run(mode, id);
}

/** Persist a Claude Gateway profile id or Codex model_provider for the session. */
export function setRuntimeProvider(id: string, provider: string | null): void {
  getDb().prepare(`UPDATE sessions SET runtime_provider = ? WHERE id = ?`).run(provider, id);
}

/**
 * REVIEW_31 Bug 4：spawn_session 路径让 caller 显式给 teammate 一个有意义的 title
 * （如 'reviewer-claude' / 'reviewer-codex' / 自定义角色），覆盖默认的 cwd-basename 派生值。
 * UI 列表 / SessionCard / TeamDetail 全走 session.title 渲染，改这一处即所有显示位生效。
 * caller 只在「确实拿到非空 title」时才调（spawn handler 内 fallback 链：displayName > agentName）。
 */
export function setTitle(id: string, title: string): void {
  getDb().prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, id);
}

/**
 * 写入 codex sandbox 档位（CHANGELOG_<X> A2a：仅 codex-cli adapter 调用）。
 * null 表示恢复用 settings.codexSandbox 全局值（与 createSession 路径 fallback 同模式）。
 * claude-code adapter 不应调此方法（字段对它无意义）。
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
 * codex-cli adapter 不应调此方法（字段对它无意义）。
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
 * - codex-cli adapter createSession（codex-sdk v0.131.0+）：opts.model 非空时也调,持久化 +
 *   bridge spread 到 ThreadOptions.model 真生效,resume / dormant 唤醒一致(prompt-asset-review-optimize-20260527
 *   修订:原 "runtime 不生效但写库便于 UI 显示" 判断已过期)
 *
 * model=null → 清空（恢复"不指定，跟 SDK 默认 / ANTHROPIC_MODEL env"语义）。
 * 与 setCodexSandbox / setClaudeCodeSandbox 完全对称的字面镜像。
 */
export function setModel(id: string, model: string | null): void {
  getDb().prepare(`UPDATE sessions SET model = ? WHERE id = ?`).run(model, id);
}

export function setThinking(id: string, thinking: string | null): void {
  getDb().prepare(`UPDATE sessions SET thinking = ? WHERE id = ?`).run(thinking, id);
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
 *
 * `paths`:绝对路径数组;空数组 / null → 列写 NULL(语义同 caller 不传 extraAllowWrite,
 * sandbox.allowWrite 不增 root)。
 */
export function setExtraAllowWrite(id: string, paths: string[] | null): void {
  const json = paths && paths.length > 0 ? JSON.stringify(paths) : null;
  getDb().prepare(`UPDATE sessions SET extra_allow_write = ? WHERE id = ?`).run(json, id);
}

/**
 * 写入 Codex SDK 网络访问开关（plan codex-recover-network-dirs-parity-20260602）。
 *
 * 调用方：codex-cli adapter session-finalize persistSessionFields —— reviewer-codex spawn 时
 * options-builder 注入的 `networkAccessEnabled: true` 持久化，让 recover / restart 路径还原
 * codex SDK 网络访问能力（与 setCodexSandbox / setModel 同款 per-session resilience）。
 * 普通 codex session（非 reviewer-*）+ claude session 不调（字段对它们无意义）。
 *
 * **boolean→int 手转**：better-sqlite3 拒绝 raw boolean bind。`enabled=null` → 列写 NULL
 * （恢复「不指定，recover ?? undefined 跳过走 SDK 默认」语义）；true→1 / false→0。
 * 与 setCodexSandbox / setModel 完全对称的字面镜像。
 */
export function setNetworkAccessEnabled(id: string, enabled: boolean | null): void {
  const intVal = enabled == null ? null : enabled ? 1 : 0;
  getDb().prepare(`UPDATE sessions SET network_access_enabled = ? WHERE id = ?`).run(intVal, id);
}

/**
 * 写入 Codex SDK 额外可读写目录（plan codex-recover-network-dirs-parity-20260602）。
 *
 * 调用方：codex-cli adapter session-finalize persistSessionFields —— reviewer-codex spawn 时
 * options-builder 注入的 `additionalDirectories: ['~/.claude', '~/.codex', '/tmp']` 持久化，
 * 让 recover / restart 路径还原 codex SDK 额外可读写根（配合 setNetworkAccessEnabled）。
 * 普通 codex session + claude session 不调。
 *
 * `dirs`：绝对路径数组；空数组 / null → 列写 NULL（语义同 caller 不传，codex SDK 走默认无额外
 * 目录）。与 setExtraAllowWrite 完全对称的字面镜像（JSON.stringify string[]）。
 */
export function setAdditionalDirectories(id: string, dirs: string[] | null): void {
  const json = dirs && dirs.length > 0 ? JSON.stringify(dirs) : null;
  getDb().prepare(`UPDATE sessions SET additional_directories = ? WHERE id = ?`).run(json, id);
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

/**
 * 反查 cli_session_id 列对应的 sessions row(plan reverse-rename-sid-stability-20260520
 * §A.2 / §设计决策 D7 / 不变量 5)。
 *
 * 调用方:
 * - sessionManager.ingest 入口(manager.ts §A.3 4 态分流 3a):hook event sessionId 是 CLI thread sid
 *   维度,findByCliSessionId 反查 application sid → 覆写 event.sessionId 走原 dedupOrClaim 5 段流程
 * - sdk-bridge / recoverer S1 effective resolver 反查兜底回填 (caller 不传 resumeCliSid 时
 *   `sessionRepo.get(opts.resume)?.cliSessionId ?? opts.resume`,详 §A.4-pre S1)
 *
 * 行为:
 * - 命中 → SessionRecord 投影(rowToRecord 处理子表 enrichment 在更高层)
 * - 不命中 → null(caller 走 fallback,反查路径不强假设 NOT NULL)
 *
 * 性能:走唯一索引 idx_sessions_cli_session_id (v021),O(log N) 反查。允许多 NULL,非空唯一。
 */
export function findByCliSessionId(cliSessionId: string): SessionRecord | null {
  const row = getDb()
    .prepare(`SELECT * FROM sessions WHERE cli_session_id = ?`)
    .get(cliSessionId) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * 更新 sessions.cli_session_id 列(plan reverse-rename-sid-stability-20260520 §A.2 /
 * §设计决策 D5 / §不变量 2)。
 *
 * **关键 invariant**: 仅 UPDATE cli_session_id 单列,不动 sessions.id (= applicationSid 应用稳定身份)。
 * 与 rename(fromId, toId) 跨表事务复杂迁移**完全不同** — 本 helper 是纯单列 UPDATE。
 *
 * 调用方(必须经 sessionManager.updateCliSessionId 包装,**不**直接调本 helper 绕过黑名单):
 * - 6 处反向 rename 路径(详 D2 表):recoverer.ts:466 jsonl-missing fallback / codex/recoverer.ts:339
 *   同款 / stream-processor.ts:313 fork detect / codex/thread-loop.ts:263 case 3 post-resume fork /
 *   restart-controller.ts:189 restartWithPermissionMode / restart-controller.ts:341 restartWithClaudeCodeSandbox
 *
 * **applicationSid 入参语义**: caller 传 sessions.id (应用稳定身份),不能传 cli sid (会撞表中错 row)。
 * S6 fork detect compare 时第一参数必须是 `internal.applicationSid` (详 R3 MED-R3-1 修订)。
 *
 * **黑名单链不变量**(R5 HIGH-R5-1 + R6 MED-R6-1 修订): caller 必须经 sessionManager.updateCliSessionId
 * 包装 — manager 内部读 oldCliSid + 调本 helper 单列 UPDATE + 调 recentlyDeleted.set(oldCliSid, ...) 包黑名单。
 * 直接调本 helper 跳过 sessionManager 会让 OLD_CLI 黑名单链断,迟到 hook event 撞 D7 3b miss 复活幽灵 record。
 */
export function updateCliSessionId(applicationSid: string, newCliSessionId: string): void {
  getDb()
    .prepare(`UPDATE sessions SET cli_session_id = ? WHERE id = ?`)
    .run(newCliSessionId, applicationSid);
}
