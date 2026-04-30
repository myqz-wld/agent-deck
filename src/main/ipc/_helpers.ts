/**
 * IPC 入参校验 helper（REVIEW_4 M1-M3）。
 * 原则：在 IPC 边界一次性校验 + 收口，handler 内部直接拿强类型值用。
 * renderer 给到非法输入直接抛 IpcInputError，UI 看到 `setSettings 失败：...`。
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { PermissionMode } from '@shared/types';
import { SANDBOX_MODE_VALUES, type SandboxMode } from '@main/adapters/claude-code/sandbox-config';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>;

export function on<T extends string>(channel: T, handler: Handler): void {
  ipcMain.handle(channel, handler);
}

export class IpcInputError extends Error {
  constructor(field: string, reason: string) {
    super(`invalid ipc input: ${field} (${reason})`);
    this.name = 'IpcInputError';
  }
}

export function parsePositiveInt(
  field: string,
  value: unknown,
  defaults: { fallback: number; min: number; max: number },
): number {
  if (value === undefined || value === null) return defaults.fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new IpcInputError(field, `not a positive integer: ${String(value)}`);
  }
  if (n < defaults.min || n > defaults.max) {
    throw new IpcInputError(field, `out of range [${defaults.min}, ${defaults.max}]: ${n}`);
  }
  return n;
}

export function parseStringId(field: string, value: unknown, maxLen = 256): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IpcInputError(field, 'must be non-empty string');
  }
  if (value.length > maxLen) {
    throw new IpcInputError(field, `length > ${maxLen}`);
  }
  return value;
}

export function parseHookScope(value: unknown): 'user' | 'project' {
  if (value === 'user' || value === 'project') return value;
  throw new IpcInputError('scope', `must be 'user' or 'project', got ${String(value)}`);
}

// user scope 装在 ~/.claude/settings.json，与 cwd 无关 → cwd 允许缺省（renderer 设置面板正是这条路径）；
// project scope 装在 <cwd>/.claude/settings.json → cwd 必填。把 scope-aware 校验集中到一个 helper，
// 避免三个 hook handler 各自 if-else 漏掉一处。
export function parseHookCwd(scope: 'user' | 'project', cwd: unknown): string | undefined {
  if (scope === 'user') return undefined;
  return parseStringId('cwd', cwd, 4096);
}

const PERMISSION_MODE_VALUES: ReadonlyArray<PermissionMode> = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
];

export function parsePermissionMode(value: unknown): PermissionMode | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new IpcInputError('permissionMode', `not a string: ${String(value)}`);
  }
  if (!PERMISSION_MODE_VALUES.includes(value as PermissionMode)) {
    throw new IpcInputError(
      'permissionMode',
      `must be one of ${PERMISSION_MODE_VALUES.join('|')}, got ${value}`,
    );
  }
  return value as PermissionMode;
}

/**
 * 校验 claudeCodeSandbox 字段（REVIEW_14 阶段 2）。语义同 parsePermissionMode：
 * - undefined / null → null（调用方决定是否兜底成 'off'）
 * - 非 string / 非白名单值 → throw IpcInputError（避免静默存入非法值导致 sdk-bridge 时无效）
 *
 * SANDBOX_MODE_VALUES 直接复用 sandbox-config.ts 的常量（单点真值），避免 ipc.ts 与
 * sdk-bridge 两边各维护一份白名单漂移。
 */
export function parseSandboxMode(value: unknown): SandboxMode | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new IpcInputError('claudeCodeSandbox', `not a string: ${String(value)}`);
  }
  if (!SANDBOX_MODE_VALUES.includes(value as SandboxMode)) {
    throw new IpcInputError(
      'claudeCodeSandbox',
      `must be one of ${SANDBOX_MODE_VALUES.join('|')}, got ${value}`,
    );
  }
  return value as SandboxMode;
}

/**
 * 校验 Agent Teams 团队名（M1）。规则：
 * - undefined / null / 空串 / 全空白 → null（不属于任何 team，DB 列保 NULL）
 * - 必须是 string；长度 ≤ 64；只允许字母数字 . _ -
 * 同步 Claude Code 自身对 ~/.claude/teams/<name>/ 目录命名的限制（避免路径越权 +
 * 跨平台兼容），且与 M2 fs 路径前缀校验匹配。
 */
export function parseTeamName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new IpcInputError('teamName', `not a string: ${String(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 64) {
    throw new IpcInputError('teamName', `length > 64 (got ${trimmed.length})`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new IpcInputError(
      'teamName',
      `must match /^[A-Za-z0-9._-]+$/, got "${trimmed}"`,
    );
  }
  return trimmed;
}

export function parseStringIdArray(field: string, value: unknown, maxItems = 500): string[] {
  if (!Array.isArray(value)) {
    throw new IpcInputError(field, 'must be array');
  }
  if (value.length > maxItems) {
    throw new IpcInputError(field, `length > ${maxItems} items`);
  }
  return value.map((v, i) => parseStringId(`${field}[${i}]`, v));
}
