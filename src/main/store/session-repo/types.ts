/**
 * session-repo —— Row 类型 + rowToRecord + parseStringArrayJson 共享 helper。
 *
 * 拆分历史：从 src/main/store/session-repo.ts 抽出（CHANGELOG_83 / plan
 * deep-review-and-split-20260513 H2 Step 2.3）。所有 sub-module 共享 import 此处。
 */

import type {
  AdapterSessionMode,
  ActivityState,
  LifecycleState,
  PermissionMode,
  SessionRecord,
  SessionSource,
} from '@shared/types';
import log from '@main/utils/logger';

const logger = log.scope('session-repo');

// ────────────────────────────────────────────────────────────────────────────
// SQLite row shape + record 转换
// ────────────────────────────────────────────────────────────────────────────

export interface Row {
  id: string;
  agent_id: string;
  runtime_provider: string | null;
  cwd: string;
  title: string;
  source: string;
  lifecycle: string;
  activity: string;
  started_at: number;
  last_event_at: number;
  ended_at: number | null;
  archived_at: number | null;
  pinned_at: number | null;
  hidden_from_history: number;
  permission_mode: string | null;
  session_mode: string | null;
  // plan team-cohesion-fix-20260513 Phase A Step A9：team_name 列已 v014 drop，Row 接口不再含
  codex_sandbox: string | null;
  claude_code_sandbox: string | null;
  // plan model-wiring-and-handoff-20260514 Step 1.3：SDK / agent model per-session 持久化
  model: string | null;
  thinking: string | null;
  // plan cross-adapter-parity-20260515 Phase A Step A.2：SDK sandbox 额外可写根 per-session 持久化
  // (REVIEW_40 R1 reviewer-codex MED-F follow-up)。JSON.stringify(string[]) 全绝对路径 / NULL = 不指定。
  extra_allow_write: string | null;
  // plan codex-recover-network-dirs-parity-20260602：reviewer-codex spawn-time 的
  // networkAccessEnabled (INTEGER 3 态 NULL/0/1) + additionalDirectories (TEXT JSON string[])
  // 持久化（v029），让 recover / restart 路径读回交还 codex SDK。codex runtime 真消费（区别
  // extra_allow_write persist-only no-op）。详 SessionRecord jsdoc。
  network_access_enabled: number | null;
  additional_directories: string | null;
  // plan codex-handoff-team-alignment-20260518 P1 Step 1.1 / 不变量 5 + D2：mcp enter_worktree marker
  // 标记 caller 显式持有的 worktreePath（archive_plan 预检 4 态分流用），NULL = 未持有 marker。
  cwd_release_marker: string | null;
  spawned_by: string | null;
  spawn_depth: number;
  generic_pty_config: string | null;
  /**
   * plan reverse-rename-sid-stability-20260520 §A.1 / §设计决策 D1 / §不变量 2:
   * CLI 当前 thread sid。允许 6 处反向 rename 路径下变化(详 D2 表 6 处),与 sessions.id
   * (= applicationSid 应用稳定身份,不变量 1) 正交。NULL = spawn tempKey 阶段未拿到 first realId
   * 或 jsonl-missing fallback fresh CLI 起动期间。详 SessionRecord.cliSessionId jsdoc。
   */
  cli_session_id: string | null;
}

export function rowToRecord(r: Row): SessionRecord {
  return {
    id: r.id,
    agentId: r.agent_id,
    runtimeProvider: r.runtime_provider ?? null,
    cwd: r.cwd,
    title: r.title,
    source: (r.source as SessionSource) ?? 'cli',
    lifecycle: r.lifecycle as LifecycleState,
    activity: r.activity as ActivityState,
    startedAt: r.started_at,
    lastEventAt: r.last_event_at,
    endedAt: r.ended_at,
    archivedAt: r.archived_at,
    pinnedAt: r.pinned_at ?? null,
    hiddenFromHistory: r.hidden_from_history === 1,
    permissionMode: (r.permission_mode as PermissionMode) ?? null,
    sessionMode: (r.session_mode as AdapterSessionMode) ?? null,
    // plan team-cohesion-fix-20260513 Phase A Step A9：teamName 字段不在 repo 层投影。
    // sessionManager.enrichWithTeams / enrichWithTeamsBatch 在更高层注入 teams[] 数组 + teamName fallback。
    // 老 sessions.team_name 列已 v014 drop。
    codexSandbox:
      (r.codex_sandbox as 'workspace-write' | 'read-only' | 'danger-full-access' | null) ?? null,
    claudeCodeSandbox:
      (r.claude_code_sandbox as 'off' | 'workspace-write' | 'strict' | null) ?? null,
    model: r.model ?? null,
    thinking: r.thinking ?? null,
    extraAllowWrite: parseStringArrayJson(r.extra_allow_write, {
      sessionId: r.id,
      field: 'extra_allow_write',
    }),
    // plan codex-recover-network-dirs-parity-20260602：INTEGER 3 态 → boolean | null
    // (null=未设跳过 / 0=false / 1=true)；additional_directories 复用 parseStringArrayJson 防脏。
    networkAccessEnabled:
      r.network_access_enabled == null ? null : r.network_access_enabled === 1,
    additionalDirectories: parseStringArrayJson(r.additional_directories, {
      sessionId: r.id,
      field: 'additional_directories',
    }),
    cwdReleaseMarker: r.cwd_release_marker ?? null,
    spawnedBy: r.spawned_by ?? null,
    spawnDepth: r.spawn_depth ?? 0,
    cliSessionId: r.cli_session_id ?? null,
  };
}

/**
 * 通用 string[] JSON 列解析（plan codex-recover-network-dirs-parity-20260602 从
 * parseExtraAllowWriteJson 重命名 —— 现 sessions.extra_allow_write + sessions.additional_directories
 * 两列共用，命名去掉 extraAllowWrite 偏向）。列存的是 JSON.stringify(string[])（绝对路径数组）。
 * 解析失败 / NULL / 类型不对 → null（不抛错,defense-in-depth）。非 NULL 脏数据会
 * warn 一次,避免沙盒额外目录 / codex additionalDirectories 悄悄退化成未设置。
 *
 * 写入端(setExtraAllowWrite / setAdditionalDirectories / upsert)做 JSON.stringify;读取端二次
 * 校验防止用户手改 DB / migration 故障 / 历史脏数据等情形(过滤掉非数组 / 非 string 元素 /
 * 空数组 → null,与 caller 不传对应字段行为对齐 — sandbox.allowWrite 不增 root /
 * additionalDirectories 不增目录)。
 */
interface StringArrayJsonContext {
  sessionId?: string;
  field?: 'extra_allow_write' | 'additional_directories' | string;
}

export function parseStringArrayJson(
  raw: string | null,
  ctx: StringArrayJsonContext = {},
): string[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn('[session-repo] string[] JSON parse failed', {
      sessionId: ctx.sessionId,
      field: ctx.field,
      rawLength: raw.length,
    }, err);
    return null;
  }
  if (!Array.isArray(parsed)) {
    logger.warn('[session-repo] string[] JSON is not an array', {
      sessionId: ctx.sessionId,
      field: ctx.field,
      rawType: typeof parsed,
    });
    return null;
  }
  const filtered = parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (filtered.length !== parsed.length) {
    logger.warn('[session-repo] string[] JSON dropped invalid entries', {
      sessionId: ctx.sessionId,
      field: ctx.field,
      total: parsed.length,
      valid: filtered.length,
    });
  }
  return filtered.length > 0 ? filtered : null;
}
