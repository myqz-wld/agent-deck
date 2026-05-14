/**
 * session-repo —— Row 类型 + rowToRecord + parseGenericPtyConfigJson 共享 helper。
 *
 * 拆分历史：从 src/main/store/session-repo.ts 抽出（CHANGELOG_83 / plan
 * deep-review-and-split-20260513 H2 Step 2.3）。所有 sub-module 共享 import 此处。
 */

import type {
  ActivityState,
  GenericPtyConfig,
  LifecycleState,
  PermissionMode,
  SessionRecord,
  SessionSource,
} from '@shared/types';
import { genericPtyConfigSchema } from '@shared/types';

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
export function parseGenericPtyConfigJson(raw: string | null): GenericPtyConfig | null {
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
