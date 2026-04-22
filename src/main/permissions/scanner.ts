/**
 * 扫描某个 cwd 对应的 Claude Code 三层 settings.json，提取 permissions 字段，
 * 并按 SDK `settingSources: ['user','project','local']` 顺序合并出生效视图。
 *
 * 设计要点：
 * - 只读（fs.readFile + JSON.parse），绝不写文件 / 绝不修改用户配置；
 *   文件落盘交给 SDK 的「Always allow」流程，agent-deck 不参与。
 * - 文件不存在 → 返回 exists=false 的占位结构，UI 仍展示推断路径，让用户知道去哪儿创建。
 * - JSON 解析失败 → 返回 parseError，原文 raw 仍展示，方便用户排错。
 * - 路径白名单：getCandidatePaths 是 open-file handler 的唯一信任源，杜绝任意路径打开。
 */

import { promises as fs } from 'node:fs';
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
  project: string;
  local: string;
}

/** 计算三层 settings 的绝对路径。空 cwd 兜底到 homedir，与 NewSessionDialog / cli.ts 一致。 */
export function getCandidatePaths(cwd: string): CandidatePaths {
  const resolved = cwd && cwd.trim().length > 0 ? cwd : homedir();
  return {
    user: join(homedir(), '.claude', 'settings.json'),
    project: join(resolved, '.claude', 'settings.json'),
    local: join(resolved, '.claude', 'settings.local.json'),
  };
}

async function readLayer(source: SettingsSource, path: string): Promise<SettingsLayer> {
  let content: string;
  try {
    content = await fs.readFile(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        source,
        path,
        exists: false,
        raw: null,
        parsed: null,
        parseError: null,
        permissions: null,
      };
    }
    // 权限不足 / 其它 IO 错误：当成「读不到」处理，把 errno 当 parseError 显示（便于排查）
    return {
      source,
      path,
      exists: false,
      raw: null,
      parsed: null,
      parseError: `${(err as Error).message}`,
      permissions: null,
    };
  }

  let parsed: unknown = null;
  let parseError: string | null = null;
  let pretty = content;
  try {
    parsed = JSON.parse(content);
    // 重新 stringify 一次得到稳定的 pretty 格式（用户原文可能压缩 / 缩进不一）
    pretty = JSON.stringify(parsed, null, 2);
  } catch (err) {
    parseError = (err as Error).message;
  }

  return {
    source,
    path,
    exists: true,
    raw: pretty,
    parsed,
    parseError,
    permissions: extractPermissions(parsed),
  };
}

/** 从 settings.json 解析后的对象里抽取 permissions 块，未知字段忽略。 */
function extractPermissions(parsed: unknown): SettingsPermissionsBlock | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed as Record<string, unknown>;
  const perm = root.permissions;
  if (!perm || typeof perm !== 'object') return null;
  const p = perm as Record<string, unknown>;
  const asStringList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const defaultMode = typeof p.defaultMode === 'string' ? p.defaultMode : null;
  return {
    allow: asStringList(p.allow),
    deny: asStringList(p.deny),
    ask: asStringList(p.ask),
    additionalDirectories: asStringList(p.additionalDirectories),
    defaultMode,
  };
}

/**
 * 合并三层 permissions：
 * - allow / deny / ask / additionalDirectories：按出现顺序 union，每条规则保留其出现过的 source 列表
 * - defaultMode：local > project > user 倒序找第一个非 null（与 SDK 实际行为一致：靠后的 settingSource 覆盖标量字段）
 */
export function mergePermissions(layers: SettingsLayer[]): MergedPermissions {
  const collectRules = (key: 'allow' | 'deny' | 'ask'): MergedRule[] => {
    const order: string[] = [];
    const map = new Map<string, SettingsSource[]>();
    for (const l of layers) {
      if (!l.permissions) continue;
      for (const r of l.permissions[key]) {
        if (!map.has(r)) {
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
  // 倒序：local 先，其次 project，最后 user
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l.permissions?.defaultMode) {
      defaultMode = { value: l.permissions.defaultMode, source: l.source };
      break;
    }
  }

  return {
    allow: collectRules('allow'),
    deny: collectRules('deny'),
    ask: collectRules('ask'),
    additionalDirectories: collectDirs(),
    defaultMode,
  };
}

/**
 * 扫描 cwd 的三层 settings 并返回合并视图。这是 IPC handler 的唯一入口。
 *
 * @param cwd 会话的 cwd；空字符串会兜底到 homedir（与 CHANGELOG_23 的策略一致）。
 */
export async function scanCwdSettings(cwd: string): Promise<PermissionScanResult> {
  const trimmed = (cwd ?? '').trim();
  const cwdResolved = trimmed.length > 0 ? trimmed : homedir();
  const paths = getCandidatePaths(cwdResolved);
  // 三层并发读，加快响应（每个文件 IO 互相独立）
  const [user, project, local] = await Promise.all([
    readLayer('user', paths.user),
    readLayer('project', paths.project),
    readLayer('local', paths.local),
  ]);
  // 注意：当 cwd 实际就是 homedir 时，project 与 user 路径相同。
  // 此时把 project 标成「与 user 同一文件」会让 UI 误以为是两份内容；
  // 我们保留两次读取（结果完全相同），UI 层负责检测 path 相同时给个提示。
  return {
    cwd: trimmed,
    cwdResolved,
    user,
    project,
    local,
    merged: mergePermissions([user, project, local]),
  };
}
