import type { AppSettings, CodexMcpServerConfigShared } from './app-settings';

/**
 * Permission Settings Scan — Claude Code settings.json 四层 permissions 扫描结果 schema。
 *
 * 拆分自 src/shared/types/settings.ts（Phase 4 Step 4.10）；
 * entity 域：扫描器（main 进程）的输出契约,renderer PermissionsView 消费。
 */

/**
 * Claude Code 的 settings 四层来源（与 SDK 实际读取行为对齐）。
 * 优先级低 → 高（高覆盖低）：
 * - user:       ~/.claude/settings.json
 * - user-local: ~/.claude/settings.local.json   ← 官方文档未明示，但 SDK / CLI 实际会读
 * - project:    <cwd>/.claude/settings.json
 * - local:      <cwd>/.claude/settings.local.json
 */
export type SettingsSource = 'user' | 'user-local' | 'project' | 'local';

/** 每层 settings.json 解析出的 permissions 字段（按 SDK schema 抽取，未知字段忽略）。 */
export interface SettingsPermissionsBlock {
  allow: string[];
  deny: string[];
  ask: string[];
  additionalDirectories: string[];
  defaultMode: string | null;
}

/** 单层 settings 文件的扫描结果。文件不存在也会返回（exists=false + raw=null）。 */
export interface SettingsLayer {
  source: SettingsSource;
  /** 推断出的绝对路径，无论是否存在 */
  path: string;
  exists: boolean;
  /** 原文（pretty-print 后），文件不存在为 null */
  raw: string | null;
  /** JSON.parse 结果，解析失败 / 文件不存在为 null */
  parsed: unknown | null;
  /** 解析失败时记错误消息 */
  parseError: string | null;
  /** 提取出的 permissions 块；不存在 / 解析失败时为 null */
  permissions: SettingsPermissionsBlock | null;
}

/** 合并视图：去重后每条规则带来源层标签。 */
export interface MergedRule {
  rule: string;
  sources: SettingsSource[];
}

export interface MergedDirectory {
  dir: string;
  sources: SettingsSource[];
}

export interface MergedPermissions {
  allow: MergedRule[];
  deny: MergedRule[];
  ask: MergedRule[];
  additionalDirectories: MergedDirectory[];
  /** 倒序找第一个非 null：local > project > user-local > user */
  defaultMode: { value: string; source: SettingsSource } | null;
}

export interface PermissionScanResult {
  /** 入参 cwd 原值（trim 后；为空时 main 进程会替换成 homedir，并在 cwdResolved 标记） */
  cwd: string;
  /** 实际用于解析 project / local 的 cwd（兜底为 homedir） */
  cwdResolved: string;
  user: SettingsLayer;
  /** ~/.claude/settings.local.json，user 级个人覆盖 */
  userLocal: SettingsLayer;
  project: SettingsLayer;
  local: SettingsLayer;
  merged: MergedPermissions;
}

export type CodexSandboxMode = AppSettings['codexSandbox'];

export interface CodexAgentDeckMcpStatus {
  enabled: boolean;
  httpEnabled: boolean;
  injectedForNewSessions: boolean;
  toolTimeoutSec: number | null;
  reason: string | null;
}

export interface CodexEffectivePermissions {
  sandboxMode: CodexSandboxMode;
  sandboxSource: 'session' | 'settings';
  approvalPolicy: 'never';
  skipGitRepoCheck: true;
  agentDeckMcp: CodexAgentDeckMcpStatus;
}

export interface CodexConfigLayer {
  path: string;
  exists: boolean;
  raw: string | null;
  readError: string | null;
  topLevelModel: string | null;
  markerManagedMcpServers: CodexMcpServerConfigShared[];
}

export interface CodexPermissionScanResult {
  adapter: 'codex-cli';
  config: CodexConfigLayer;
  appManagedMcpServers: CodexMcpServerConfigShared[];
  effective: CodexEffectivePermissions;
}
