/**
 * session-repo —— Row 类型 + rowToRecord + parseExtraAllowWriteJson 共享 helper。
 *
 * 拆分历史：从 src/main/store/session-repo.ts 抽出（CHANGELOG_83 / plan
 * deep-review-and-split-20260513 H2 Step 2.3）。所有 sub-module 共享 import 此处。
 */

import type {
  ActivityState,
  LifecycleState,
  PermissionMode,
  SessionRecord,
  SessionSource,
} from '@shared/types';

// ────────────────────────────────────────────────────────────────────────────
// SQLite row shape + record 转换
// ────────────────────────────────────────────────────────────────────────────

export interface Row {
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
  // plan model-wiring-and-handoff-20260514 Step 1.3：SDK / agent model per-session 持久化
  model: string | null;
  // plan cross-adapter-parity-20260515 Phase A Step A.2：SDK sandbox 额外可写根 per-session 持久化
  // (REVIEW_40 R1 reviewer-codex MED-F follow-up)。JSON.stringify(string[]) 全绝对路径 / NULL = 不指定。
  extra_allow_write: string | null;
  // plan codex-handoff-team-alignment-20260518 P1 Step 1.1 / 不变量 5 + D2：mcp enter_worktree marker
  // 标记 caller 显式持有的 worktreePath（archive_plan 预检 4 态分流用），NULL = 未持有 marker。
  cwd_release_marker: string | null;
  spawned_by: string | null;
  spawn_depth: number;
  generic_pty_config: string | null;
}

export function rowToRecord(r: Row): SessionRecord {
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
    codexSandbox:
      (r.codex_sandbox as 'workspace-write' | 'read-only' | 'danger-full-access' | null) ?? null,
    claudeCodeSandbox:
      (r.claude_code_sandbox as 'off' | 'workspace-write' | 'strict' | null) ?? null,
    model: r.model ?? null,
    extraAllowWrite: parseExtraAllowWriteJson(r.extra_allow_write),
    cwdReleaseMarker: r.cwd_release_marker ?? null,
    spawnedBy: r.spawned_by ?? null,
    spawnDepth: r.spawn_depth ?? 0,
  };
}

/**
 * sessions.extra_allow_write 列存的是 JSON.stringify(string[])（绝对路径数组）。
 * 解析失败 / NULL / 类型不对 → null（不抛错,defense-in-depth）。
 *
 * 写入端(setExtraAllowWrite / upsert)做 JSON.stringify;读取端二次校验防止用户手改 DB /
 * migration 故障 / 历史脏数据等情形(过滤掉非数组 / 非 string 元素 / 空数组 → null,
 * 与 caller 不传 extraAllowWrite 行为对齐 sandbox.allowWrite 不增 root)。
 */
export function parseExtraAllowWriteJson(raw: string | null): string[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const filtered = parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return filtered.length > 0 ? filtered : null;
}
