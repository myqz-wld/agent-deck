import type { ClaudeGatewayProfileOption } from '@shared/types';
import type { ResolvedClaudeGatewayProfile } from './sdk-bridge/session-defaults-core';

export type { ResolvedClaudeGatewayProfile } from './sdk-bridge/session-defaults-core';

export const CLAUDE_GATEWAY_PROFILE_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ClaudeGatewayPaths {
  gatewaysDir: string;
}

export interface ClaudeGatewayDirectoryEntry {
  name: string;
  isFile: boolean;
  isSymbolicLink: boolean;
}

export interface ClaudeGatewayProfileHost {
  joinPath(directory: string, name: string): string;
  listDirectory(directory: string): readonly ClaudeGatewayDirectoryEntry[];
  isFile(path: string): boolean;
  pathExists(path: string): boolean;
  readText(path: string): string;
}

export function assertClaudeGatewayProfileIdCore(profileId: string): void {
  if (!CLAUDE_GATEWAY_PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error(
      `Claude 模型网关名称 "${profileId}" 无效；请从模型网关列表中重新选择。`,
    );
  }
}

export function claudeGatewaySettingsPathCore(
  profileId: string,
  paths: ClaudeGatewayPaths,
  host: ClaudeGatewayProfileHost,
): string {
  assertClaudeGatewayProfileIdCore(profileId);
  return host.joinPath(paths.gatewaysDir, `${profileId}.json`);
}

export function listClaudeGatewayProfilesCore(
  paths: ClaudeGatewayPaths,
  host: ClaudeGatewayProfileHost,
): ClaudeGatewayProfileOption[] {
  let entries: readonly ClaudeGatewayDirectoryEntry[];
  try {
    entries = host.listDirectory(paths.gatewaysDir);
  } catch {
    return [];
  }

  const profiles: ClaudeGatewayProfileOption[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    if (!CLAUDE_GATEWAY_PROFILE_ID_PATTERN.test(id)) continue;
    if (!entry.isFile && !entry.isSymbolicLink) continue;
    const settingsPath = host.joinPath(paths.gatewaysDir, entry.name);
    try {
      if (!host.isFile(settingsPath)) continue;
    } catch {
      continue;
    }
    profiles.push({ id, settingsPath });
  }
  return profiles.sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveClaudeGatewayProfileCore(
  gateway: string | null | undefined,
  paths: ClaudeGatewayPaths,
  host: ClaudeGatewayProfileHost,
): ResolvedClaudeGatewayProfile | null {
  const id = gateway?.trim();
  if (!id) return null;
  assertClaudeGatewayProfileIdCore(id);
  const settingsPath = claudeGatewaySettingsPathCore(id, paths, host);
  if (!host.pathExists(settingsPath)) {
    throw new Error(
      `Claude 模型网关 "${id}" 不存在；请刷新列表后选择其他模型网关。`,
    );
  }
  const parsed = readJsonObject(settingsPath, host);
  const env = stringRecord(parsed.env);
  return {
    id,
    settingsPath,
    configRoot: nonBlank(env.CLAUDE_CONFIG_DIR),
    defaultModel: nonBlank(env.ANTHROPIC_MODEL),
    modelAliases: {
      fable:
        nonBlank(env.ANTHROPIC_DEFAULT_FABLE_MODEL) ??
        nonBlank(env.ANTHROPIC_MODEL),
      opus:
        nonBlank(env.ANTHROPIC_DEFAULT_OPUS_MODEL) ??
        nonBlank(env.ANTHROPIC_MODEL),
      sonnet:
        nonBlank(env.ANTHROPIC_DEFAULT_SONNET_MODEL) ??
        nonBlank(env.ANTHROPIC_MODEL),
      haiku:
        nonBlank(env.ANTHROPIC_DEFAULT_HAIKU_MODEL) ??
        nonBlank(env.ANTHROPIC_MODEL),
    },
  };
}

function readJsonObject(
  path: string,
  host: ClaudeGatewayProfileHost,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(host.readText(path)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `读取 Claude 模型网关配置失败（${path}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
