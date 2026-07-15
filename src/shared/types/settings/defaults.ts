/**
 * DEFAULT_SETTINGS — AppSettings 的默认值常量。
 *
 * 拆分自 src/shared/types/settings.ts（Phase 4 Step 4.10）；
 * 引用 `./app-settings` 的 AppSettings 类型保证形状一致。
 */

import type { AppSettings } from './app-settings';

export const DEFAULT_CONTINUATION_RAW_RETENTION_TOKENS = 64_000;
export const MIN_CONTINUATION_RAW_RETENTION_TOKENS = 8_000;
export const MAX_CONTINUATION_RAW_RETENTION_TOKENS = 128_000;
export const DEFAULT_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES = 30;
export const MIN_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES = 5;
export const MAX_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES = 1_440;
export const DEFAULT_CONTINUATION_CHECKPOINT_MAX_CONCURRENT = 2;
export const MIN_CONTINUATION_CHECKPOINT_MAX_CONCURRENT = 1;
export const MAX_CONTINUATION_CHECKPOINT_MAX_CONCURRENT = 10;
/** Stable runtime fallbacks; unlike electron-store defaults these values are never store-owned. */
export const DEFAULT_SUMMARY_REASONING = 'low' as const;
export const DEFAULT_CONTINUATION_CHECKPOINT_THINKING = 'medium' as const;

export const DEFAULT_SETTINGS: AppSettings = {
  hookServerPort: 47821,
  hookServerToken: null,
  enableSound: true,
  enableSystemNotification: true,
  silentWhenFocused: true,
  waitingSoundPath: null,
  finishedSoundPath: null,
  activeWindowMs: 60 * 60 * 1000,
  closeAfterMs: 24 * 60 * 60 * 1000,
  summaryEnabled: true,
  summaryIntervalMs: 5 * 60 * 1000,
  summaryEventCount: 30,
  summaryMaxConcurrent: 2,
  summaryTimeoutMs: 60 * 1000,
  // 周期总结与会话续接检查点分开配置；两者的 provider/model/thinking 互不影响。
  summaryProvider: 'claude',
  summaryModel: '',
  summaryReasoning: DEFAULT_SUMMARY_REASONING,
  continuationCheckpointProvider: 'claude',
  continuationCheckpointModel: '',
  continuationCheckpointThinking: DEFAULT_CONTINUATION_CHECKPOINT_THINKING,
  continuationCheckpointAutoRefreshEnabled: true,
  continuationCheckpointAutoRefreshIntervalMinutes:
    DEFAULT_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES,
  continuationCheckpointMaxConcurrent: DEFAULT_CONTINUATION_CHECKPOINT_MAX_CONCURRENT,
  continuationRawRetentionTokens: DEFAULT_CONTINUATION_RAW_RETENTION_TOKENS,
  permissionTimeoutMs: 30 * 60 * 1000,
  alwaysOnTop: true,
  windowTransparent: true,
  startOnLogin: false,
  historyRetentionDays: 30,
  // Issue Tracker §D13 GC 阈值（plan issue-tracker-mcp-20260529）：
  // - resolvedRetentionDays 默认 30d (与历史 / 消息保留默认窗口对齐)
  // - softDeletedRetentionDays 默认 7d (软删一周后硬删,与 history 30d 不同 — 软删本就 implicit 已完成 triage)
  issueResolvedRetentionDays: 30,
  issueSoftDeletedRetentionDays: 7,
  // plan message-retention-and-index-20260602 §D3：agent_deck_messages retention GC 阈值。
  // 默认 30d（与 historyRetentionDays 起步一致，用户可单独调）。MessageLifecycleScheduler 6h tick
  // 删 status IN terminal && sent_at < now-Nd 的超期消息（pending/delivering 永不删）。0 = 关闭 GC。
  messageRetentionDays: 30,
  codexCliPath: null,
  claudeCliPath: null,
  injectAgentDeckClaudeMd: true,
  injectAgentDeckCodexAgentsMd: true,
  injectAgentDeckCodexSkills: true,
  injectAgentDeckCodexAgents: true,
  injectAgentDeckClaudeSkills: true,
  injectAgentDeckClaudeAgents: true,
  // R3.E6 (PR-B) 删 agentTeamsEnabled / autoApproveTeammateMode；
  // plan task-mcp-merge-into-agent-deck-mcp-20260521 删 enableTaskManager；
  // plan resume-inject-raw-messages-20260601 删 autoSummariseOnFallback（无条件注入历史 — UI
  // toggle 早删字段成孤儿，REMOVED_KEYS 清历史 + 改 fallback 路径无条件走注入，详 settings-store.ts）；
  // REMOVED_KEYS + smart migration 自动清历史 + 守护老用户 ON 值（详 settings-store.ts）
  claudeCodeSandbox: 'workspace-write',
  codexSandbox: 'workspace-write',
  codexMcpServers: [],
  // R3.E6 删 autoApproveTeammateMode；REMOVED_KEYS 自动清历史
  // B'0 ADR §7：Agent Deck MCP server 默认 ON（task tools 跟随，详 enableAgentDeckMcp jsdoc）
  enableAgentDeckMcp: true,
  mcpServerToken: null,
  mcpHttpEnabled: true,
  mcpStdioEnabled: true,
  mcpMaxSpawnDepth: 3,
  mcpSpawnRatePerMinute: 20,
  mcpMaxFanOutPerParent: 10,
  // R3.E0 ADR §7.5：universal-message-watcher 限流默认值
  mcpMessageRatePerTeamPerMin: 60,
  mcpMessageMaxTargetInflight: 10,
  // Plan runtime-logging-electron-log-20260529 §D4 §D14: 日志 file transport 默认 'info'
  // (console 永远 'silly' 固定不变, 详 logger.ts)
  logLevel: 'info',
};
