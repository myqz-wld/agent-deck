/**
 * 跨进程共享：Session 与 lifecycle / activity / permission mode 类型。
 */

import type { GenericPtyConfig } from './generic-pty';
import type { SessionTeamMembership } from './agent-deck-team';

export type ActivityState = 'idle' | 'working' | 'waiting' | 'finished';
/**
 * 自动生命周期：active → dormant → closed（按 last_event_at 时间衰减，由 LifecycleScheduler 推进）。
 * 「归档」是与 lifecycle 正交的标记，由 SessionRecord.archivedAt 决定（非 null = 已归档）。
 * 这样取消归档可以保留归档前的真实生命周期，而不是粗暴回到某个固定值。
 */
export type LifecycleState = 'active' | 'dormant' | 'closed';
/**
 * SDK 通道的会话级权限模式。SDK Query 自己持有运行时真值但不暴露 getter，
 * 因此把「用户上次主动选过的值」持久化在 sessions.permission_mode 列里，
 * 切回 detail 或恢复会话时还原。
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
/**
 * 'sdk' = 应用内通过 ＋ 按钮新建的会话（可发消息、可响应权限请求）
 * 'cli' = 外部终端 `claude` 通过 hook 上报的会话（只读，UI 提示用户去终端操作）
 */
export type SessionSource = 'sdk' | 'cli';

export interface SessionRecord {
  id: string;
  agentId: string;
  cwd: string;
  title: string;
  source: SessionSource;
  lifecycle: LifecycleState;
  activity: ActivityState;
  startedAt: number;
  lastEventAt: number;
  endedAt: number | null;
  archivedAt: number | null;
  /** SDK 通道：上次手动选过的权限模式；null/undefined 视为 'default'。CLI 通道字段无意义。 */
  permissionMode?: PermissionMode | null;
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
   * claude / aider / generic-pty 会话该字段始终 null。
   */
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access' | null;
  /**
   * Claude Code OS 沙盒档位（CHANGELOG_74：仅 claude-code adapter 写）。
   * 持久化用户在 NewSessionDialog / ComposerSdk 选过的 OS 沙盒档位
   * （off / workspace-write / strict），让重启应用 resume 仍按原档位。
   * null/undefined 视为 settings.claudeCodeSandbox 全局值（与 createSession 路径
   * fallback 同模式 — 与 codexSandbox 完全对称）。
   * codex / aider / generic-pty 会话该字段始终 null。
   */
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict' | null;
  /**
   * Agent / SDK model（plan model-wiring-and-handoff-20260514 Step 1.3）。
   *
   * 持久化 spawn 时来源（含 agent_name 触发的 frontmatter `model` 字段、未来 caller 显式
   * 传入），让 SDK resume / dormant 唤醒后保持模型一致 — 与 permissionMode /
   * claudeCodeSandbox 同款 per-session resilience 模式。
   *
   * - claude-code adapter：值会通过 buildClaudeQueryOptions → SDK `query({ options.model })`
   *   真正传给 cli.js；接受 'opus' / 'sonnet' / 'haiku' alias 或具体 model id 如
   *   'claude-opus-4-7-thinking-max[1m]'
   * - codex-cli adapter：值仅写入持久化（让 UI 看到 frontmatter 设的 model），runtime
   *   仍由 ~/.codex/config.toml 顶层 `model` 字段决定（codex SDK startThread 不接受 per-thread
   *   model override，详 plan D5）
   * - aider / generic-pty adapter：始终 null
   *
   * null/undefined：不指定，SDK 自己读 ANTHROPIC_MODEL env / 自己默认值（与 settings 全局
   * model 设置无关 — settings.summaryModel/handOffModel 只在 oneshot summary/hand-off 路径用，
   * spawn/resume 路径不查 settings）。
   */
  model?: string | null;
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
   * - codex-cli adapter:字段持久化(parity 对称),但 codex bridge createSession opts
   *   不消费(codex SDK 不支持 extra writable roots);future codex SDK 加支持时零迁移成本
   * - aider / generic-pty adapter:始终 null
   *
   * null/undefined:不指定,sandbox.allowWrite 仅含 cwd + /tmp + cache(与 caller 不传
   * extraAllowWrite 行为同款)。
   *
   * 持久化层:sessions.extra_allow_write TEXT 列,JSON.stringify(string[])。
   */
  extraAllowWrite?: string[] | null;
  /**
   * mcp enter_worktree marker（plan codex-handoff-team-alignment-20260518 P1 Step 1.1 /
   * 不变量 5 + D2）：caller 走 mcp `enter_worktree` 进 worktree 时设为 worktreePath 绝对路径,
   * 走 mcp `exit_worktree` 或 session close hook 清回 null。
   *
   * 与 archive_plan 预检 4 态分流配合解锁场景 C（codex / 外部 caller 走 mcp 路径进 worktree）：
   * - !inWorktree                  → 放过（caller 已 ExitWorktree, 现有 claude builtin 路径）
   * - inWorktree + marker == wt    → 放过（caller 持 mcp enter_worktree marker, 跨 adapter 路径）
   * - inWorktree + marker == null  → reject（走 claude builtin 路径但忘 ExitWorktree）
   * - inWorktree + marker != wt    → reject（marker 指向另一个 worktree, 不允许跨 worktree archive）
   *
   * per-session 字段（非全局）,不同 caller 各自持自己 marker。SDK fork / recover rename 路径
   * 必须把此列从 fromRow 复制到 NEW 行（详 session-repo/rename.ts），否则 codex teammate
   * enter_worktree 设的 marker 在 fork 后丢失,下次 archive_plan 预检走「在 worktree 内 +
   * 无 marker」分支 reject（plan H1 关键修法 — 20 列扩展 + toExists UPDATE 覆盖块）。
   *
   * null/undefined: 未持有 marker（caller 走 claude builtin 路径或还没调 mcp enter_worktree）。
   * 持久化层: sessions.cwd_release_marker TEXT 列 (v020), 绝对路径 string / NULL。
   */
  cwdReleaseMarker?: string | null;
  /**
   * Agent Deck MCP server (R2 / B'0 ADR §6.5)：spawn 链上的父 session id。
   * - null/undefined：顶层 session（用户 IPC / CLI 直接起 / R2 之前老数据）
   * - 字符串：MCP `spawn_session` tool 调用方的 session id
   *
   * 与 spawnDepth 配合用于防递归 4 条规则（depth 上限 / per-parent fan-out /
   * cwd realpath 整链回溯）。MCP spawn_session handler 在 createSession 前 reserve
   * 占位时调 sessionRepo.setSpawnLink 写入。
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
   * R4·F2：generic-pty / aider session 的 spawn config（持久化到 sessions.generic_pty_config 列）。
   * - generic-pty / aider adapter：createSession 时落库，resume 时读回 spawn 同 config
   * - claude-code / codex-cli adapter：始终 null（字段无意义，与 codexSandbox 同模式）
   */
  genericPtyConfig?: GenericPtyConfig | null;
}
