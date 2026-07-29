/** Read-only, bounded scanner for the four Claude Code settings layers. */

import { constants, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  MergedDirectory,
  MergedPermissions,
  MergedRule,
  PermissionScanResult,
  SettingsLayer,
  SettingsPermissionsBlock,
  SettingsSource,
} from '@shared/types';

interface CandidatePaths {
  user: string;
  userLocal: string;
  project: string;
  local: string;
}

export const MAX_PERMISSION_SETTINGS_BYTES = 256 * 1024;
export const MAX_PERMISSION_CWD_BYTES = 4_096;
export const MAX_PERMISSION_JSON_DEPTH = 64;
export const MAX_PERMISSION_JSON_NODES = 20_000;
export const MAX_PERMISSION_RULES_PER_FIELD = 500;
export const MAX_PERMISSION_RULE_LENGTH = 4_096;
export const MAX_MERGED_PERMISSION_ENTRIES = 500;

const FILE_LIMIT_ERROR = '设置文件超过安全扫描上限';
const READ_ERROR = '设置文件读取失败';
const JSON_PARSE_ERROR = 'JSON 解析失败';
const JSON_LIMIT_ERROR = 'JSON 结构超过安全扫描上限';
const RULE_LIMIT_ERROR = '权限规则超过安全扫描上限';

interface LayerData {
  exists: boolean;
  raw: string | null;
  parseError: string | null;
  permissions: SettingsPermissionsBlock | null;
}

export interface ScanCwdSettingsOptions {
  homeDir?: string;
  canonicalize?: (path: string) => Promise<string>;
  readFile?: (path: string) => Promise<string>;
}

class PermissionScanLimitError extends Error {}

/** Candidate paths are also the allowlist used by the open-file IPC. */
export function getCandidatePaths(
  cwd: string,
  homeDir: string = homedir(),
): CandidatePaths {
  const resolved = cwd && cwd.trim().length > 0 ? cwd : homeDir;
  return {
    user: join(homeDir, '.claude', 'settings.json'),
    userLocal: join(homeDir, '.claude', 'settings.local.json'),
    project: join(resolved, '.claude', 'settings.json'),
    local: join(resolved, '.claude', 'settings.local.json'),
  };
}

async function readBoundedUtf8(path: string): Promise<string> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > MAX_PERMISSION_SETTINGS_BYTES) {
      throw new PermissionScanLimitError(FILE_LIMIT_ERROR);
    }

    const buffer = Buffer.allocUnsafe(MAX_PERMISSION_SETTINGS_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_PERMISSION_SETTINGS_BYTES) {
      throw new PermissionScanLimitError(FILE_LIMIT_ERROR);
    }
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function isJsonWithinLimits(root: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_PERMISSION_JSON_NODES || current.depth > MAX_PERMISSION_JSON_DEPTH) {
      return false;
    }
    if (!current.value || typeof current.value !== 'object') continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const value of children) {
      stack.push({ value, depth: current.depth + 1 });
    }
  }
  return true;
}

function boundedStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (
      Buffer.byteLength(item, 'utf8') > MAX_PERMISSION_RULE_LENGTH ||
      result.length >= MAX_PERMISSION_RULES_PER_FIELD
    ) {
      return null;
    }
    result.push(item);
  }
  return result;
}

function extractPermissions(
  parsed: unknown,
): { permissions: SettingsPermissionsBlock | null; limitExceeded: boolean } {
  if (!parsed || typeof parsed !== 'object') {
    return { permissions: null, limitExceeded: false };
  }
  const perm = (parsed as Record<string, unknown>).permissions;
  if (!perm || typeof perm !== 'object') {
    return { permissions: null, limitExceeded: false };
  }
  const value = perm as Record<string, unknown>;
  const allow = boundedStringList(value.allow);
  const deny = boundedStringList(value.deny);
  const ask = boundedStringList(value.ask);
  const additionalDirectories = boundedStringList(value.additionalDirectories);
  const defaultMode = typeof value.defaultMode === 'string'
    ? value.defaultMode
    : null;
  if (
    !allow ||
    !deny ||
    !ask ||
    !additionalDirectories ||
    (defaultMode !== null
      && Buffer.byteLength(defaultMode, 'utf8') > MAX_PERMISSION_RULE_LENGTH)
  ) {
    return { permissions: null, limitExceeded: true };
  }
  return {
    permissions: { allow, deny, ask, additionalDirectories, defaultMode },
    limitExceeded: false,
  };
}

async function readLayerData(
  canonicalPath: string,
  readFile: (path: string) => Promise<string>,
): Promise<LayerData> {
  let content: string;
  try {
    content = await readFile(canonicalPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { exists: false, raw: null, parseError: null, permissions: null };
    }
    if (err instanceof PermissionScanLimitError) {
      return {
        exists: true,
        raw: null,
        parseError: FILE_LIMIT_ERROR,
        permissions: null,
      };
    }
    return { exists: true, raw: null, parseError: READ_ERROR, permissions: null };
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_PERMISSION_SETTINGS_BYTES) {
    return {
      exists: true,
      raw: null,
      parseError: FILE_LIMIT_ERROR,
      permissions: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      exists: true,
      raw: content,
      parseError: JSON_PARSE_ERROR,
      permissions: null,
    };
  }
  if (!isJsonWithinLimits(parsed)) {
    return {
      exists: true,
      raw: content,
      parseError: JSON_LIMIT_ERROR,
      permissions: null,
    };
  }
  const extracted = extractPermissions(parsed);
  if (extracted.limitExceeded) {
    return {
      exists: true,
      raw: content,
      parseError: RULE_LIMIT_ERROR,
      permissions: null,
    };
  }
  return {
    exists: true,
    raw: content,
    parseError: null,
    permissions: extracted.permissions,
  };
}

/**
 * 合并四层 permissions：
 * - allow / deny / ask / additionalDirectories：按出现顺序 union，每条规则保留其出现过的 source 列表
 * - defaultMode：local > project > user-local > user 倒序找第一个非 null（与 SDK 实际行为一致：靠后的 settingSource 覆盖标量字段）
 */
export function mergePermissions(layers: SettingsLayer[]): MergedPermissions {
  let truncated = false;
  const collectRules = (key: 'allow' | 'deny' | 'ask'): MergedRule[] => {
    const order: string[] = [];
    const map = new Map<string, SettingsSource[]>();
    for (const l of layers) {
      if (!l.permissions) continue;
      for (const r of l.permissions[key]) {
        if (!map.has(r)) {
          if (order.length >= MAX_MERGED_PERMISSION_ENTRIES) {
            truncated = true;
            continue;
          }
          order.push(r);
          map.set(r, []);
        }
        const arr = map.get(r)!;
        if (!arr.includes(l.source)) arr.push(l.source);
      }
    }
    return order.map((rule) => ({ rule, sources: map.get(rule)! }));
  };

  const collectDirs = (): MergedDirectory[] => {
    const order: string[] = [];
    const map = new Map<string, SettingsSource[]>();
    for (const l of layers) {
      if (!l.permissions) continue;
      for (const d of l.permissions.additionalDirectories) {
        if (!map.has(d)) {
          if (order.length >= MAX_MERGED_PERMISSION_ENTRIES) {
            truncated = true;
            continue;
          }
          order.push(d);
          map.set(d, []);
        }
        const arr = map.get(d)!;
        if (!arr.includes(l.source)) arr.push(l.source);
      }
    }
    return order.map((dir) => ({ dir, sources: map.get(dir)! }));
  };

  let defaultMode: MergedPermissions['defaultMode'] = null;
  // 倒序：local 先，依次往前（与 SDK 实际优先级一致：高优先级覆盖低优先级）
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l.permissions?.defaultMode) {
      defaultMode = { value: l.permissions.defaultMode, source: l.source };
      break;
    }
  }

  const allow = collectRules('allow');
  const deny = collectRules('deny');
  const ask = collectRules('ask');
  const additionalDirectories = collectDirs();
  return {
    allow,
    deny,
    ask,
    additionalDirectories,
    defaultMode,
    truncated,
  };
}

/** Scan unique canonical files concurrently, then project results onto all four sources. */
export async function scanCwdSettings(
  cwd: string,
  options: ScanCwdSettingsOptions = {},
): Promise<PermissionScanResult> {
  const homeDir = options.homeDir ?? homedir();
  const canonicalize = options.canonicalize ?? fs.realpath;
  const readFile = options.readFile ?? readBoundedUtf8;
  const trimmed = (cwd ?? '').trim();
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_PERMISSION_CWD_BYTES) {
    throw new Error('权限扫描目录超过长度上限');
  }
  const cwdResolved = trimmed.length > 0 ? trimmed : homeDir;
  const paths = getCandidatePaths(cwdResolved, homeDir);
  const candidates: Array<{ source: SettingsSource; path: string }> = [
    { source: 'user', path: paths.user },
    { source: 'user-local', path: paths.userLocal },
    { source: 'project', path: paths.project },
    { source: 'local', path: paths.local },
  ];
  const resolved = await Promise.all(candidates.map(async (candidate) => {
    try {
      const canonicalPath = await canonicalize(candidate.path);
      return { ...candidate, canonicalPath: canonicalPath || candidate.path };
    } catch {
      return { ...candidate, canonicalPath: candidate.path };
    }
  }));
  const reads = new Map<string, Promise<LayerData>>();
  for (const candidate of resolved) {
    if (!reads.has(candidate.canonicalPath)) {
      reads.set(
        candidate.canonicalPath,
        readLayerData(candidate.canonicalPath, readFile),
      );
    }
  }
  const layers = await Promise.all(resolved.map(async (candidate): Promise<SettingsLayer> => ({
    source: candidate.source,
    path: candidate.path,
    ...await reads.get(candidate.canonicalPath)!,
  })));
  const [user, userLocal, project, local] = layers;
  return {
    cwd: trimmed,
    cwdResolved,
    user,
    userLocal,
    project,
    local,
    merged: mergePermissions([user, userLocal, project, local]),
  };
}
