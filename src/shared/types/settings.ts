/**
 * 跨进程共享：AppSettings + Hook 安装状态 + 权限设置扫描结果类型 — facade re-export。
 *
 * Phase 4 Step 4.10 拆分（plan deep-project-review-comprehensive-20260528）：
 * 原 544 LOC 单文件按 entity 域拆 4 子模块：
 * - `./settings/app-settings` — AppSettings + CodexMcpServerConfigShared + HookInstallStatus
 * - `./settings/defaults` — DEFAULT_SETTINGS const
 * - `./settings/permission-scan` — 7 permission scan types（SettingsSource / SettingsPermissionsBlock /
 *   SettingsLayer / MergedRule / MergedDirectory / MergedPermissions / PermissionScanResult）
 *
 * 所有 caller 经 `src/shared/types.ts` barrel `export * from './types/settings'` 间接引用，
 * 本 facade 保 byte-identical 11 export。直接 `from '@shared/types/settings'` 0 caller。
 */

export type {
  CodexMcpServerConfigShared,
  AppSettings,
  HookInstallStatus,
} from './settings/app-settings';

export { DEFAULT_SETTINGS } from './settings/defaults';

export type {
  SettingsSource,
  SettingsPermissionsBlock,
  SettingsLayer,
  MergedRule,
  MergedDirectory,
  MergedPermissions,
  PermissionScanResult,
  CodexSandboxMode,
  CodexAgentDeckMcpStatus,
  CodexEffectivePermissions,
  CodexConfigLayer,
  CodexPermissionScanResult,
} from './settings/permission-scan';
