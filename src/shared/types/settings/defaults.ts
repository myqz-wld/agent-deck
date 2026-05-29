/**
 * DEFAULT_SETTINGS — AppSettings 的默认值常量。
 *
 * 拆分自 src/shared/types/settings.ts（Phase 4 Step 4.10）；
 * 引用 `./app-settings` 的 AppSettings 类型保证形状一致。
 */

import type { AppSettings } from './app-settings';

export const DEFAULT_SETTINGS: AppSettings = {
  hookServerPort: 47821,
  hookServerToken: null,
  enableSound: true,
  enableSystemNotification: true,
  silentWhenFocused: true,
  waitingSoundPath: null,
  finishedSoundPath: null,
  activeWindowMs: 30 * 60 * 1000,
  closeAfterMs: 24 * 60 * 60 * 1000,
  summaryIntervalMs: 5 * 60 * 1000,
  summaryEventCount: 10,
  summaryMaxConcurrent: 2,
  summaryTimeoutMs: 60 * 1000,
  // plan prancy-forging-penguin: provider × model × reasoning 三联字段(summary / handoff 两组)
  // - summaryModel/handOffModel: 默认空 = 沿用各 provider env / alias / config.toml 链
  // - summaryProvider/handOffProvider: 默认 'claude'(走 claude SDK + OAuth 凭证)
  // - summaryReasoning/handOffReasoning: 默认 low/medium 与原 hardcoded 行为对齐(仅 codex provider 生效)
  summaryProvider: 'claude',
  summaryModel: '',
  summaryReasoning: 'low',
  handOffProvider: 'claude',
  handOffModel: '',
  handOffReasoning: 'medium',
  permissionTimeoutMs: 5 * 60 * 1000,
  alwaysOnTop: true,
  windowTransparent: true,
  startOnLogin: false,
  historyRetentionDays: 30,
  // Issue Tracker §D13 GC 阈值（plan issue-tracker-mcp-20260529）：
  // - resolvedRetentionDays 默认 90d (resolved issue 三月后硬删,留充分窗口给用户复盘)
  // - softDeletedRetentionDays 默认 7d (软删一周后硬删,与 history 30d 不同 — 软删本就 implicit 已完成 triage)
  issueResolvedRetentionDays: 90,
  issueSoftDeletedRetentionDays: 7,
  codexCliPath: null,
  claudeCliPath: null,
  injectAgentDeckClaudeMd: true,
  injectAgentDeckCodexAgentsMd: true,
  injectAgentDeckCodexSkills: true,
  injectAgentDeckPlugin: true,
  // R3.E6 (PR-B) 删 agentTeamsEnabled / autoApproveTeammateMode；
  // plan task-mcp-merge-into-agent-deck-mcp-20260521 删 enableTaskManager；
  // REMOVED_KEYS + smart migration 自动清历史 + 守护老用户 ON 值（详 settings-store.ts）
  autoSummariseOnFallback: true,
  claudeCodeSandbox: 'off',
  codexSandbox: 'workspace-write',
  codexMcpServers: [],
  // R3.E6 删 autoApproveTeammateMode；REMOVED_KEYS 自动清历史
  // B'0 ADR §7：Agent Deck MCP server 默认 OFF（task tools 跟随，详 enableAgentDeckMcp jsdoc）
  enableAgentDeckMcp: false,
  mcpServerToken: null,
  mcpHttpEnabled: true,
  mcpStdioEnabled: true,
  mcpMaxSpawnDepth: 3,
  mcpSpawnRatePerMinute: 20,
  mcpMaxFanOutPerParent: 10,
  // R3.E0 ADR §7.5：universal-message-watcher 限流默认值
  mcpMessageRatePerTeamPerMin: 60,
  mcpMessageMaxTargetInflight: 10,
};
