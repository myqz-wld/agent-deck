import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type { ClaudeGatewayProfileOption } from '@shared/types';
import type { ClaudeGatewayModelAliases } from './sdk-bridge/types';

export const CLAUDE_GATEWAY_PROFILE_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ClaudeGatewayPaths {
  gatewaysDir: string;
}

export interface ResolvedClaudeGatewayProfile {
  id: string;
  settingsPath: string;
  configRoot?: string;
  defaultModel?: string;
  modelAliases: ClaudeGatewayModelAliases;
}

export function defaultClaudeGatewayPaths(): ClaudeGatewayPaths {
  return {
    gatewaysDir: join(homedir(), '.claude', 'gateways'),
  };
}

export function claudeGatewaySettingsPath(
  profileId: string,
  paths: ClaudeGatewayPaths = defaultClaudeGatewayPaths(),
): string {
  assertClaudeGatewayProfileId(profileId);
  return join(paths.gatewaysDir, `${profileId}.json`);
}

export function assertClaudeGatewayProfileId(profileId: string): void {
  if (!CLAUDE_GATEWAY_PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error(
      `Invalid Claude Gateway profile "${profileId}". Use 1-128 letters, digits, dot, underscore, or hyphen; the first character must be alphanumeric.`,
    );
  }
}

export function listClaudeGatewayProfiles(
  paths: ClaudeGatewayPaths = defaultClaudeGatewayPaths(),
): ClaudeGatewayProfileOption[] {
  let entries;
  try {
    entries = readdirSync(paths.gatewaysDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const profiles: ClaudeGatewayProfileOption[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const id = basename(entry.name, '.json');
    if (!CLAUDE_GATEWAY_PROFILE_ID_PATTERN.test(id)) continue;
    const settingsPath = join(paths.gatewaysDir, entry.name);
    try {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!statSync(settingsPath).isFile()) continue;
    } catch {
      continue;
    }
    profiles.push({ id, settingsPath });
  }
  return profiles.sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveClaudeGatewayProfile(
  gateway: string | null | undefined,
  paths: ClaudeGatewayPaths = defaultClaudeGatewayPaths(),
): ResolvedClaudeGatewayProfile | null {
  const id = gateway?.trim();
  if (!id) return null;
  assertClaudeGatewayProfileId(id);
  const settingsPath = claudeGatewaySettingsPath(id, paths);
  if (!existsSync(settingsPath)) {
    throw new Error(
      `Claude Gateway profile "${id}" was not found at ${settingsPath}. Create that settings file or choose another profile.`,
    );
  }
  const parsed = readJsonObject(settingsPath);
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

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Failed to read Claude Gateway settings ${path}: ${
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
