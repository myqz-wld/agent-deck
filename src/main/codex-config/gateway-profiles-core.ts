import * as TOML from '@iarna/toml';

import { isCodexThinkingLevel, type CodexThinkingLevel } from '@shared/session-metadata';
import {
  isCodexApprovalPolicy,
  type CodexApprovalPolicy,
  type CodexGatewayProfileOption,
} from '@shared/types';
import type { CodexConfigObject } from './agent-deck-mcp-injector';

export const CODEX_GATEWAY_PROFILE_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNSAFE_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface CodexGatewayPaths {
  gatewaysDir: string;
}

export interface CodexGatewayDirectoryEntry {
  name: string;
  isFile: boolean;
  isSymbolicLink: boolean;
}

export interface CodexGatewayProfileHost {
  joinPath(directory: string, name: string): string;
  listDirectory(directory: string): readonly CodexGatewayDirectoryEntry[];
  isFile(path: string): boolean;
  pathExists(path: string): boolean;
  readText(path: string): string;
}

export interface ResolvedCodexGatewayProfile {
  /** Public Gateway id derived only from the TOML filename stem. */
  id: string;
  profilePath: string;
  /** Complete parsed TOML configuration supplied as the selected session layer. */
  configOverrides: CodexConfigObject;
  /** Native app-server selector read from the selected TOML, independent of the Gateway id. */
  modelProvider?: string;
  defaultModel?: string;
  defaultThinking?: CodexThinkingLevel;
  defaultApproval?: CodexApprovalPolicy;
}

export function codexGatewayProfilePathCore(
  profileId: string,
  paths: CodexGatewayPaths,
  host: CodexGatewayProfileHost,
): string {
  assertCodexGatewayProfileIdCore(profileId);
  return host.joinPath(paths.gatewaysDir, `${profileId}.toml`);
}

export function assertCodexGatewayProfileIdCore(profileId: string): void {
  if (!CODEX_GATEWAY_PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error(
      `Codex 模型网关名称 "${profileId}" 无效；请从模型网关列表中重新选择。`,
    );
  }
}

/** Match Claude Gateway discovery: enumerate safe file stems without parsing profile contents. */
export function listCodexGatewayProfilesCore(
  paths: CodexGatewayPaths,
  host: CodexGatewayProfileHost,
): CodexGatewayProfileOption[] {
  let entries: readonly CodexGatewayDirectoryEntry[];
  try {
    entries = host.listDirectory(paths.gatewaysDir);
  } catch {
    return [];
  }

  const profiles: CodexGatewayProfileOption[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.toml')) continue;
    const id = entry.name.slice(0, -'.toml'.length);
    if (!CODEX_GATEWAY_PROFILE_ID_PATTERN.test(id)) continue;
    if (!entry.isFile && !entry.isSymbolicLink) continue;
    const profilePath = host.joinPath(paths.gatewaysDir, entry.name);
    try {
      if (!host.isFile(profilePath)) continue;
    } catch {
      continue;
    }
    profiles.push({ id, profilePath });
  }
  return profiles.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Resolve one complete Codex TOML configuration by public Gateway id.
 *
 * A non-empty Agent Deck selection is always file-backed. Missing or malformed selected profiles
 * fail closed; only an empty selection delegates to Codex's ordinary config.toml.
 */
export function resolveCodexGatewayProfileCore(
  gateway: string | null | undefined,
  paths: CodexGatewayPaths,
  host: CodexGatewayProfileHost,
): ResolvedCodexGatewayProfile | null {
  const id = gateway?.trim();
  if (!id) return null;
  assertCodexGatewayProfileIdCore(id);
  const profilePath = codexGatewayProfilePathCore(id, paths, host);
  if (!host.pathExists(profilePath)) {
    throw new Error(
      `Codex 模型网关 "${id}" 不存在；请刷新列表后选择其他模型网关。`,
    );
  }
  if (!host.isFile(profilePath)) {
    throw new Error(`Codex 模型网关 "${id}" 的配置文件不可用。`);
  }
  return parseCodexGatewayProfileTextCore(id, profilePath, host.readText(profilePath));
}

/** Parse a selected Gateway with full TOML semantics and a JSON-RPC-safe value projection. */
export function parseCodexGatewayProfileTextCore(
  id: string,
  profilePath: string,
  text: string,
): ResolvedCodexGatewayProfile {
  let parsed: unknown;
  try {
    parsed = TOML.parse(text);
  } catch (error) {
    throw profileReadError(profilePath, tomlSyntaxSummary(error));
  }
  const configOverrides = normalizeConfigObject(parsed, profilePath);
  const modelProvider = optionalNonBlankString(
    configOverrides.model_provider,
    'model_provider',
    profilePath,
  );
  const model = optionalNonBlankString(configOverrides.model, 'model', profilePath);
  const thinking = configOverrides.model_reasoning_effort;
  if (thinking !== undefined && !isCodexThinkingLevel(thinking)) {
    throw profileReadError(
      profilePath,
      new Error('model_reasoning_effort 不是 Codex 支持的思考档位'),
    );
  }
  const approval = configOverrides.approval_policy;
  if (approval !== undefined && !isCodexApprovalPolicy(approval)) {
    throw profileReadError(
      profilePath,
      new Error('approval_policy 不是 Codex 支持的审批策略'),
    );
  }
  validateCapacity(configOverrides, profilePath);

  return {
    id,
    profilePath,
    configOverrides,
    ...(modelProvider !== undefined ? { modelProvider } : {}),
    ...(model !== undefined ? { defaultModel: model } : {}),
    ...(isCodexThinkingLevel(thinking) ? { defaultThinking: thinking } : {}),
    ...(isCodexApprovalPolicy(approval) ? { defaultApproval: approval } : {}),
  };
}

function normalizeConfigObject(value: unknown, profilePath: string): CodexConfigObject {
  const normalized = normalizeConfigValue(value, 'config', profilePath);
  if (!isRecord(normalized)) {
    throw profileReadError(profilePath, new Error('TOML 根节点必须是 table'));
  }
  return normalized as CodexConfigObject;
}

function normalizeConfigValue(value: unknown, key: string, profilePath: string): unknown {
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeConfigValue(entry, `${key}[${index}]`, profilePath));
  }
  if (isRecord(value) && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, entry]) => {
      if (UNSAFE_CONFIG_KEYS.has(childKey)) {
        throw profileReadError(
          profilePath,
          new Error(`${key}.${childKey} 不是安全的配置键`),
        );
      }
      return [
        childKey,
        normalizeConfigValue(entry, `${key}.${childKey}`, profilePath),
      ];
    }));
  }
  throw profileReadError(
    profilePath,
    new Error(`${key} 包含 app-server JSON 配置不支持的 TOML 值`),
  );
}

function optionalNonBlankString(
  value: unknown,
  key: string,
  profilePath: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw profileReadError(profilePath, new Error(`${key} 必须是非空字符串`));
  }
  return value.trim();
}

function validateCapacity(config: CodexConfigObject, profilePath: string): void {
  const modelContextWindow = positiveSafeInteger(
    config.model_context_window,
    'model_context_window',
    profilePath,
  );
  const autoCompactTokenLimit = positiveSafeInteger(
    config.model_auto_compact_token_limit,
    'model_auto_compact_token_limit',
    profilePath,
  );
  if (
    modelContextWindow !== undefined &&
    autoCompactTokenLimit !== undefined &&
    autoCompactTokenLimit > modelContextWindow
  ) {
    throw profileReadError(
      profilePath,
      new Error('model_auto_compact_token_limit 不能大于 model_context_window'),
    );
  }
}

function positiveSafeInteger(
  value: unknown,
  key: string,
  profilePath: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw profileReadError(profilePath, new Error(`${key} 必须是正安全整数`));
  }
  return value as number;
}

function tomlSyntaxSummary(error: unknown): Error {
  if (!isRecord(error)) return new Error('TOML 语法无效');
  const line = typeof error.line === 'number' ? error.line + 1 : null;
  const column = typeof error.col === 'number' ? error.col + 1 : null;
  return new Error(
    line === null
      ? 'TOML 语法无效'
      : `TOML 语法无效（第 ${line} 行${column === null ? '' : `，第 ${column} 列`}）`,
  );
}

function profileReadError(profilePath: string, error: unknown): Error {
  return new Error(
    `读取 Codex 模型网关配置失败（${profilePath}）：${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
