/**
 * 跨进程共享：Session 与 lifecycle / activity / permission mode 类型。
 */

import type { SessionTeamMembership } from './agent-deck-team';
import type { SessionThinkingLevel } from '../session-metadata';

export type ActivityState = 'idle' | 'working' | 'waiting' | 'finished';
/**
 * 自动生命周期：active → dormant → closed（按 last_event_at 时间衰减，由 LifecycleScheduler 推进）。
 * 「归档」是与 lifecycle 正交的标记，由 SessionRecord.archivedAt 决定（非 null = 已归档）。
 * 这样取消归档可以保留归档前的真实生命周期，而不是粗暴回到某个固定值。
 */
export type LifecycleState = 'active' | 'dormant' | 'closed';
/**
 * SDK 通道的会话级权限模式。SDK Query 自己持有运行时真值但不暴露 getter，
 * 因此把用户选择或 provider 上报的当前权威状态持久化在 sessions.permission_mode 列里，
 * 切回 detail 或恢复会话时精确还原。
 */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
] as const;
/** Modes users may explicitly choose through Agent Deck's public surfaces. */
export type SelectablePermissionMode = (typeof PERMISSION_MODES)[number];
/**
 * Provider runtime states. `dontAsk` remains intentionally absent from the public selectable
 * list, but Claude may report or restore it and Agent Deck must preserve that state exactly.
 */
export const CLAUDE_RUNTIME_PERMISSION_MODES = [
  ...PERMISSION_MODES,
  'dontAsk',
] as const;
export type PermissionMode = (typeof CLAUDE_RUNTIME_PERMISSION_MODES)[number];
export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === 'string' &&
    (CLAUDE_RUNTIME_PERMISSION_MODES as readonly string[]).includes(value)
  );
}
export function isSelectablePermissionMode(
  value: unknown,
): value is SelectablePermissionMode {
  return (
    typeof value === 'string' &&
    (PERMISSION_MODES as readonly string[]).includes(value)
  );
}
/**
 * Restore every provider-valid runtime state exactly; ignore only unknown values. Public parsers
 * use `isSelectablePermissionMode` separately, so preserving `dontAsk` here does not expose it as
 * a new user choice.
 */
export function normalizeStoredPermissionMode(value: unknown): PermissionMode | null {
  return isPermissionMode(value) ? value : null;
}
export const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'] as const;
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];
export function isCodexApprovalPolicy(value: unknown): value is CodexApprovalPolicy {
  return (
    typeof value === 'string' &&
    (CODEX_APPROVAL_POLICIES as readonly string[]).includes(value)
  );
}
/** Exact cumulative ACP counters used only as Grok recovery watermarks. */
export interface GrokUsageWatermark {
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thoughtTokens: number | null;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
}
/** Latest provider-reported snapshot of the current prompt context, not lifetime token usage. */
export interface SessionContextUsage {
  usedTokens: number | null;
  windowTokens: number | null;
  updatedAt: number;
}
/** Partial provider update; omitted fields preserve the last known snapshot value. */
export interface SessionContextUsageUpdate {
  usedTokens?: number | null;
  windowTokens?: number | null;
}
/** Adapter-native work mode. Currently negotiated and implemented by Grok Build ACP. */
export const ADAPTER_SESSION_MODES = ['default', 'plan', 'ask'] as const;
export type AdapterSessionMode = (typeof ADAPTER_SESSION_MODES)[number];
export function isAdapterSessionMode(value: unknown): value is AdapterSessionMode {
  return (
    typeof value === 'string' &&
    (ADAPTER_SESSION_MODES as readonly string[]).includes(value)
  );
}
/** Concrete defaults shown by new-session surfaces after resolving native config and app settings. */
export interface SessionCreationDefaults {
  provider: string;
  model: string;
  thinking: SessionThinkingLevel;
  permissionMode: SelectablePermissionMode;
  sessionMode: AdapterSessionMode;
  approvalPolicy: CodexApprovalPolicy;
  codexSandbox: 'workspace-write' | 'read-only' | 'danger-full-access';
  claudeCodeSandbox: 'off' | 'workspace-write' | 'strict';
  grokSandbox: string;
}
export const AGENT_PROFILE_SOURCES = ['bundled', 'project', 'user', 'plugin'] as const;
export type AgentProfileSource = (typeof AGENT_PROFILE_SOURCES)[number];
export function isAgentProfileSource(value: unknown): value is AgentProfileSource {
  return (
    typeof value === 'string' &&
    (AGENT_PROFILE_SOURCES as readonly string[]).includes(value)
  );
}
/**
 * 'sdk' = 应用内通过 ＋ 按钮新建的会话（可发消息、可响应权限请求）
 * 'cli' = 外部终端里的 Claude / Codex / Grok 通过 hook 上报的会话
 *（只读，UI 提示用户回到对应终端操作）
 */
export type SessionSource = 'sdk' | 'cli';

export interface SessionRecord {
  id: string;
  agentId: string;
  /**
   * Adapter-scoped runtime provider.
   *
   * - claude-code: Gateway profile id resolved from ~/.claude/gateways/<id>.json
   * - codex-cli: native profile id from `$CODEX_HOME/<id>.config.toml`
   * - grok-build: always null; Grok keeps native model-alias routing
   */
  runtimeProvider?: string | null;
  cwd: string;
  title: string;
  source: SessionSource;
  lifecycle: LifecycleState;
  activity: ActivityState;
  startedAt: number;
  lastEventAt: number;
  endedAt: number | null;
  archivedAt: number | null;
  /** Real-time session pin timestamp; null/undefined means unpinned. */
  pinnedAt?: number | null;
  /** Internal runtime rows remain live-addressable but are permanently omitted from History. */
  hiddenFromHistory?: boolean;
  /** Claude SDK 当前权限状态；null/undefined 视为 'default'。其他 adapter 字段无意义。 */
  permissionMode?: PermissionMode | null;
  /** Adapter-native work mode; separate from Claude permission mode. */
  sessionMode?: AdapterSessionMode | null;
  /**
   * Selected adapter-native Agent identity.
   *
   * Claude restores this as SDK `options.agent`; Grok restores it as ACP
   * `_meta.agentProfile`. null/undefined means the session uses the adapter's generic main agent.
   */
  agentProfileName?: string | null;
  /**
   * Discovery source for the selected Agent. Grok needs this to decide whether the bundled Agent
   * plugin or a selected native Plugin root must be mounted again during ACP session/load.
   * Claude currently records `plugin` when a native Plugin root is selected and otherwise leaves
   * the source null because user/project/bundled Agents are resolved by SDK settings.
   */
  agentProfileSource?: AgentProfileSource | null;
  /**
   * Native Plugin root that supplied the selected Agent. Restored into Claude SDK `plugins` or
   * Grok ACP `pluginDirs` after disconnect, app restart, cold runtime restart, and native resume.
   */
  agentPluginDir?: string | null;
  /**
   * plan team-cohesion-fix-20260513 Phase A：universal team backend 反查的 active membership 投影。
   *
   * 由 sessionManager.enrichWithTeams（or batch enrich）填充，不在 sessionRepo.toSessionRecord 内产
   * （repo 层职责单一：纯 DB row → record；team membership 是跨表 JOIN，归 sessionManager 编排层）。
   *
   * 顺序：joined_at DESC（最近加入的在前；多 team 共享时 SessionCard 显示 teams[0]）。
   * undefined = 未 enriched（防御性 default fallback；renderer 应 `?? []`）；空数组 = 不在任何 active team。
   *
   * v014 drop sessions.team_name 后，老 `teamName` 字段已删；显示团队名走 `teams[0]?.teamName`。
   */
  teams?: SessionTeamMembership[];
  /**
   * Codex sandbox 档位（CHANGELOG_<X> A2a：仅 codex-cli adapter 写）。
   * 持久化用户在 NewSessionDialog 选过的 codex sandbox（workspace-write / read-only /
   * danger-full-access），让重启应用后 resume 仍按原 sandbox。null/undefined 视为
   * settings.codexSandbox 全局值（与 createSession 路径 fallback 同模式）。
   * claude-code 会话该字段始终 null。
   */
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access' | null;
  /**
   * Explicit per-session Codex approval override. Null means Agent Deck leaves
   * approval ownership to Codex config/provider defaults. Reviewer sessions
   * persist `never` so dormant/app-restart recovery cannot become interactive.
   */
  codexApprovalPolicy?: CodexApprovalPolicy | null;
  /**
   * Claude Code OS 沙盒档位（CHANGELOG_74：仅 claude-code adapter 写）。
   * 持久化用户在 NewSessionDialog / ComposerSdk 选过的 OS 沙盒档位
   * （off / workspace-write / strict），让重启应用 resume 仍按原档位。
   * null/undefined 视为 settings.claudeCodeSandbox 全局值（与 createSession 路径
   * fallback 同模式 — 与 codexSandbox 完全对称）。
   * codex-cli 会话该字段始终 null。
   */
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict' | null;
  /**
   * Grok Build native sandbox profile requested when its ACP child starts.
   * null delegates to Grok's native configuration precedence.
   */
  grokSandbox?: string | null;
  /**
   * Agent / SDK model（plan model-wiring-and-handoff-20260514 Step 1.3）。
   *
   * 初始值来自 spawn/session 配置，并在 provider 给出更权威的 runtime identity 时校准，让
   * SDK resume / dormant 唤醒后保持模型一致 — 与 permissionMode / claudeCodeSandbox
   * 同款 per-session resilience 模式。
   *
   * - claude-code adapter：值会通过 buildClaudeQueryOptions → SDK `query({ options.model })`
   *   真正传给 cli.js；接受 'fable' / 'opus' / 'sonnet' / 'haiku' alias 或具体 model id 如
   *   'claude-fable-5'，随后以 SDK system/init 报告的主模型更新（Deepseek profile 会先映射
   *   Claude-compatible alias）
   * - codex-cli adapter（codex-sdk v0.131.0+）：值通过 sdk-bridge spread 到 ThreadOptions.model
   *   真正传给 codex CLI runtime + setModel 持久化让 resume / dormant 唤醒一致；user 端
   *   codex CLI 实际可用 model id 由 `~/.codex/config.toml` 配置决定（user 须自行 preflight
   *   model id 在自身 codex CLI 可用,非法 model 会触发 codex SDK ThreadErrorEvent fatal 路径)
   *
   * null/undefined：尚未指定或观测到具体模型；provider 自行选择默认值。
   */
  model?: string | null;
  /**
   * Per-session thinking / reasoning effort display value.
   *
   * Stored as the adapter-facing level selected at creation time, then calibrated when the
   * provider reports a more authoritative runtime value:
   * - claude-code (including Gateway profiles): requested SDK `effort`
   *   (`low` / `medium` / `high` / `xhigh` / `max`), replaced by the latest actual effort
   *   observed from a completed SDK turn (including provider-side silent downgrade)
   * - codex-cli: app-server `model_reasoning_effort`
   *   (`low` / `medium` / `high` / `xhigh` / `max` / `ultra`)
   *
   * null/undefined means no per-session value has been recorded or observed, so the provider
   * default remains in effect.
   */
  thinking?: string | null;
  /**
   * SDK sandbox 额外可写根（plan cross-adapter-parity-20260515 Phase A / REVIEW_40 R1
   * reviewer-codex MED-F follow-up）。
   *
   * 持久化 `mcp__agent-deck__spawn_session` / `hand_off_session` 调用时 caller 透传的
   * `extra_allow_write` 参数（绝对路径数组），让 SDK resume / dormant 唤醒 / app 重启 /
   * sdk-bridge state lost 后,recoverer 路径仍能从 sessionRepo 读回交还 SDK
   * sandbox.allowWrite,与 permissionMode / claudeCodeSandbox / model 同款 per-session
   * resilience 模式。
   *
   * 典型场景:hand_off_session 外置 worktree(cwd=worktreePath 不在 mainRepo subtree)+
   * caller 传 [mainRepo] 让外置 worktree session 能写 mainRepo plan 文件。app 重启 /
   * recoverer fallback 路径若不读回 → SDK sandbox.allowWrite 不含原 mainRepo → 写 plan
   * 文件静默失败(sandbox 拦)→ 用户体感 plan 完成时 frontmatter 更新失败莫名其妙。
   *
   * - claude-code adapter:值通过 finalizeSessionStart → buildSandboxConfig 真正注入
   *   SDK options.sandbox.allowWrite(workspace-write 档生效;strict / off 忽略)
   * - codex-cli adapter:与 additionalDirectories 合并后写入 app-server workspace-write
   *   writableRoots
   *
   * null/undefined:不指定,sandbox.allowWrite 仅含 cwd + /tmp + cache(与 caller 不传
   * extraAllowWrite 行为同款)。
   *
   * 持久化层:sessions.extra_allow_write TEXT 列,JSON.stringify(string[])。
   */
  extraAllowWrite?: string[] | null;
  /**
   * Codex SDK 网络访问开关（plan codex-recover-network-dirs-parity-20260602）。
   *
   * 持久化可信 lifecycle caller 显式提供或同 adapter 继承的网络设置，让 app 重启 /
   * dev hot reload / main crash 后 sessions Map miss 时 recover 路径能从 sessionRepo
   * 读回交还 codex SDK，与 codexSandbox / model 同款 per-session resilience 模式。
   * `reviewer-*` 名称本身不注入此字段。
   *
   * 本字段由 codex SDK runtime **真消费**——经
   * `buildCodexThreadOptions` → `startThread`/`resumeThread` 的 ThreadOptions.networkAccessEnabled
   * 真正控制 codex 子进程能否访问网络。与
   * `extraAllowWrite` / `additionalDirectories` 一样，recover 链上的透传不可删除。
   *
   * - 仅 codex-cli 消费；显式值或同 adapter 继承值由 persistSessionFields 持久化。
   * - null/undefined：不指定，recover 时 `?? undefined` 跳过 → codex SDK 走默认网络策略。
   *
   * 持久化层：sessions.network_access_enabled INTEGER 列（v029），3 态 NULL/0/1。
   * 注意 better-sqlite3 拒绝 raw boolean bind，写入端 boolean→0/1 手转、读取端 `=== 1` 还原。
   */
  networkAccessEnabled?: boolean | null;
  /**
   * Codex SDK 额外可读写目录（plan codex-recover-network-dirs-parity-20260602）。
   *
   * 持久化可信 lifecycle caller 显式提供或同 adapter 继承的额外目录，让 recover
   * 路径能从 sessionRepo 读回交还 codex SDK（与 networkAccessEnabled 配套）。
   * `reviewer-*` 名称本身不注入路径。
   *
   * 本字段由 codex SDK runtime **真消费**——经
   * `buildCodexThreadOptions` → `startThread`/`resumeThread` 的 ThreadOptions.additionalDirectories
   * 真正把这些根加入当前 codex sandbox 可访问范围（实际读写能力仍受 sandboxMode 档位约束；
   * 具体可访问范围仍由当前 session runtime 决定）。
   * `extraAllowWrite` 也会合并进 workspace-write writableRoots；两条 recover 透传都不可删除。
   *
   * - 仅 codex-cli 消费；显式值或同 adapter 继承值由 persistSessionFields 持久化。
   * - null/undefined：不指定，recover 时 `?? undefined` 跳过 → codex SDK 走默认（无额外路径）。
   *
   * 持久化层：sessions.additional_directories TEXT 列（v029），JSON.stringify(string[]) 全绝对路径。
   * 读取端复用 parseStringArrayJson defense-in-depth（与 extraAllowWrite 同款防脏）。
   */
  additionalDirectories?: string[] | null;
  /**
   * Last exact cumulative Grok ACP usage snapshot. Persisting this prevents a
   * recovered runtime from treating the provider's session-wide counters as a
   * new turn. Null on a legacy recovered session means the first standard
   * snapshot establishes a baseline and is not emitted as usage.
   */
  grokUsageWatermark?: GrokUsageWatermark | null;
  /**
   * Current context occupancy and model window. During compaction, usedTokens is reset to null
   * until the provider reports its post-compaction snapshot; windowTokens remains available.
   */
  contextUsage?: SessionContextUsage | null;
  /**
   * Compatibility mirror for the session-owned worktree path. `enter_worktree` stores the absolute
   * path here together with its structured lease; completed `exit_worktree` cleanup clears it.
   * Close/archive preserves an unsettled structured lease so recovery can finish safely.
   *
   * This is per-session transient ownership state. SDK fork/recover rename paths must copy it from
   * the source row so retries, handoff transfer, and legacy-marker adoption still identify the
   * exact owned worktree. A null/undefined value means the session has no compatibility marker.
   *
   * 持久化层: sessions.cwd_release_marker TEXT 列 (v020), 绝对路径 string / NULL。
   */
  cwdReleaseMarker?: string | null;
  /**
   * Agent Deck MCP server (R2 / B'0 ADR §6.5)：spawn 链上的父 session id。
   * - null/undefined：顶层 session（用户 IPC / CLI 直接起 / R2 之前老数据）
   * - 字符串：MCP `spawn_session` tool 调用方的 session id
   *
   * 与 spawnDepth 配合用于 depth / per-parent fan-out 防护。MCP handler 先持有 in-flight
   * reservation；首个可信 SDK session-start 原子写入 spawn link 后立即把 reservation 转成
   * durable active-child 计数，canonical id 完成后再幂等校验一次。
   */
  spawnedBy?: string | null;
  /**
   * Agent Deck MCP server (R2 / B'0 ADR §6.5)：spawn 链层数。
   * - 0（默认）：顶层 session
   * - parent.spawnDepth + 1：MCP 起的子 session
   *
   * 用于 §6.1 depth 上限校验（mcpMaxSpawnDepth 默认 3）。NOT NULL，DEFAULT 0。
   */
  spawnDepth?: number;
  /**
   * CLI 当前 thread sid(plan reverse-rename-sid-stability-20260520 §设计决策 D1)。
   *
   * 与 sessions.id (= applicationSid 应用稳定身份)正交:
   * - **sessions.id**: 应用层稳定身份,spawn 后首次落定 (D2 spawn 主路径 tempKey → first realId rename) 即冻结,
   *   全 lifecycle 内绝不改变 (不变量 1)。caller / wire prefix [sid] / team_members.session_id /
   *   mcp-session-token-map / agent_deck_messages.from_session_id 全部用此维度 (spike3 §3.1-3.7 实证)。
   * - **cliSessionId**: SDK / CLI thread 当前 sid,允许 6 处反向 rename 路径变化 (不变量 2):
   *   recoverer.ts:466 jsonl-missing fallback / codex/recoverer.ts:339 同款 / stream-processor.ts:313 fork detect /
   *   codex/thread-loop.ts:263 case 3 post-resume fork / restart-controller.ts:189 restartWithPermissionMode /
   *   restart-controller.ts:341 restartWithClaudeCodeSandbox。
   *
   * 用途:
   * - jsonl 路径命名:`~/.claude/projects/<encoded-cwd>/<cli_session_id>.jsonl` (spike1 §1.2 实证 5/5 sample
   *   jsonl 文件名 == body.sessionId == cli_session_id 维度)
   * - SDK CLI `--resume` 入参传 cli_session_id (spike1 §1.1 sdk.mjs `if(k)i.push("--resume",k)` verbatim 透传)
   * - sdk-bridge S6 fork detect compare 用 effectiveResumeCliSid (反查 cli_session_id 兜底回填)
   *
   * **null 边角** (D4 cli_session_id 列允许 NULL):
   * - spawn tempKey 阶段:SDK 还没给 first realId,cli_session_id 为 null
   * - jsonl-missing fallback 起 fresh CLI 期间 (resumeMode='fresh-cli-reuse-app'):cli_session_id 暂时 null,
   *   first realId 后通过 sessionManager.updateCliSessionId 写入
   * - 反查路径 (findByCliSessionId) 走 fallback 不强假设 NOT NULL (S6 effectiveResumeCliSid 三分支 guard
   *   `!opts.resume → undefined`,详 §A.4-pre S1)
   *
   * **持久化层**: sessions.cli_session_id TEXT 列 (v021), CLI thread sid string / NULL。
   * 唯一索引 idx_sessions_cli_session_id 保 findByCliSessionId 反查 O(log N) (允许多 NULL,非空唯一)。
   */
  cliSessionId?: string | null;
}

/** Session hand-off metadata emitted on the successor session's first user message event. */
export interface HandOffMetadata {
  /** session hand-off baton marker. */
  mode: 'session';
  /** caller session id that handed off its resources to this successor. */
  fromCallerSid: string;
  /** Stable event boundary captured when the Continuation Context was prepared. */
  sourceMaxEventId?: number | null;
}

export type RuntimeAdapterId =
  | 'claude-code'
  | 'codex-cli'
  | 'grok-build';

export interface RuntimeSelection {
  adapter: RuntimeAdapterId;
  provider?: string;
  model?: string;
  thinking?: string;
}

export type SessionAdapterId = RuntimeAdapterId;

export interface SessionHandOffTarget {
  adapter: SessionAdapterId;
  /** Claude Gateway profile id or Codex config profile id; null delegates to native defaults. */
  provider?: string | null;
  /** Empty/null delegates model selection to the target provider. */
  model?: string | null;
  /** Empty/null delegates thinking selection to the target provider. */
  thinking?: string | null;
  /** Adapter-native work mode; currently meaningful only for Grok Build. */
  sessionMode?: AdapterSessionMode | null;
  /** Optional Grok native sandbox request; omitted follows hand-off inheritance/default rules. */
  grokSandbox?: string | null;
}

export interface SessionHandOffPrepareRequest {
  sourceSessionId: string;
  /** Authoritative successor instruction; generated history remains read-only. */
  continuationInstruction: string;
  target: SessionHandOffTarget;
}

export type SessionContinuationQuality =
  | 'full'
  | 'projected'
  | 'coverage-gap'
  | 'raw-only'
  | 'instruction-only';

/** Bounded renderer projection. Full provider prompt, spool ids, and fingerprints stay in main. */
export interface SessionHandOffPreparation {
  preparationId: string;
  preview: string;
  previewTruncated: boolean;
  quality: SessionContinuationQuality;
  source: {
    eventRevision: number;
    rebuildAfterRevision: number;
  };
  checkpoint: {
    id: number | null;
    throughRevision: number;
    formatVersion: number;
    refreshed: boolean;
  };
  metrics: {
    estimatedPromptTokens: number;
    checkpointTokens: number;
    rawTailTokens: number;
    includedUserMessages: number;
    truncatedBoundaryMessages: number;
    rawRetentionCeilingTokens: number;
    elapsedMs: number;
  };
  warnings: Array<{ code: string; message: string }>;
  target: SessionHandOffTarget;
}

export interface SessionHandOffCommitResult {
  successorSessionId: string;
  /** Durable source boundary accepted immediately before ownership transfer. */
  cutoverEventRevision: number;
  /** Source inputs queued behind the prepared successor turn. */
  lateMessagesDelivered: number;
  /** Successor is usable even when best-effort source close/archive reports a warning. */
  sourceFinalizationWarning: string | null;
}

/** Post-create failure details must cross Electron IPC without relying on Error serialization. */
export interface SessionHandOffExecutionFailure {
  stage: 'cutover' | 'transfer';
  successorSessionId: string;
  successorCleanup: 'ok' | 'failed';
  cutoverReason?: string;
  message: string;
}

/** Serializable UI commit boundary: known post-create failures resolve as structured results. */
export type SessionHandOffCommitResponse =
  | ({ status: 'success' } & SessionHandOffCommitResult)
  | ({ status: 'execution-error' } & SessionHandOffExecutionFailure);
