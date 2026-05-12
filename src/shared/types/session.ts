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
