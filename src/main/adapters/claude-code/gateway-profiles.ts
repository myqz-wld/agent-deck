import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { ClaudeGatewayProfileOption } from '@shared/types';
import type { ClaudeProviderModelAliases } from './sdk-bridge/types';

export const CLAUDE_GATEWAY_PROFILE_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const DEFAULT_DEEPSEEK_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_AUTH_TOKEN: '',
  ANTHROPIC_MODEL: 'deepseek-v4-pro[1m]',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-v4-pro[1m]',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
  CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
  CLAUDE_CODE_EFFORT_LEVEL: 'max',
};

const LEGACY_KEYS = [
  'baseUrl',
  'url',
  'token',
  'authToken',
  'apiKey',
  'model',
  'fableModel',
  'opusModel',
  'sonnetModel',
  'haikuModel',
  'subagentModel',
  'effortLevel',
] as const;

export interface ClaudeGatewayPaths {
  gatewaysDir: string;
  legacyDeepseekSettingsPath: string;
}

export interface ResolvedClaudeGatewayProfile {
  id: string;
  settingsPath: string;
  configRoot?: string;
  defaultModel?: string;
  modelAliases: ClaudeProviderModelAliases;
}

export function defaultClaudeGatewayPaths(): ClaudeGatewayPaths {
  return {
    gatewaysDir: join(homedir(), '.claude', 'gateways'),
    legacyDeepseekSettingsPath: join(
      homedir(),
      '.agent-deck',
      '.deepseek',
      'settings.json',
    ),
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

/**
 * Startup-only migration/initialization. Runtime discovery and resolution never consult legacy
 * adapter paths. Credentials stay inside the user-owned Claude settings file; this function never
 * returns, logs, or persists them in Agent Deck state.
 */
export function initializeBuiltInClaudeGatewayProfiles(
  paths: ClaudeGatewayPaths = defaultClaudeGatewayPaths(),
): string {
  const target = claudeGatewaySettingsPath('deepseek', paths);
  if (existsSync(target)) return target;

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const source = paths.legacyDeepseekSettingsPath;
  const settings = existsSync(source)
    ? normalizeLegacyDeepseekSettings(readJsonObject(source))
    : { env: { ...DEFAULT_DEEPSEEK_ENV } };
  writeJsonAtomically(target, settings);
  return target;
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
  return profiles.sort((a, b) => {
    if (a.id === 'deepseek') return -1;
    if (b.id === 'deepseek') return 1;
    return a.id.localeCompare(b.id);
  });
}

export function resolveClaudeGatewayProfile(
  provider: string | null | undefined,
  paths: ClaudeGatewayPaths = defaultClaudeGatewayPaths(),
): ResolvedClaudeGatewayProfile | null {
  const id = provider?.trim();
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

function normalizeLegacyDeepseekSettings(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const env = {
    ...DEFAULT_DEEPSEEK_ENV,
    ...stringRecord(parsed.env),
  };
  setIfString(env, 'ANTHROPIC_BASE_URL', parsed.baseUrl ?? parsed.url);
  setIfString(
    env,
    'ANTHROPIC_AUTH_TOKEN',
    parsed.authToken ?? parsed.token ?? parsed.apiKey,
  );
  setIfString(env, 'ANTHROPIC_MODEL', parsed.model);
  setIfString(env, 'ANTHROPIC_DEFAULT_FABLE_MODEL', parsed.fableModel);
  setIfString(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL', parsed.opusModel);
  setIfString(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL', parsed.sonnetModel);
  setIfString(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL', parsed.haikuModel);
  setIfString(env, 'CLAUDE_CODE_SUBAGENT_MODEL', parsed.subagentModel);
  setIfString(env, 'CLAUDE_CODE_EFFORT_LEVEL', parsed.effortLevel);

  const normalized = { ...parsed, env };
  for (const key of LEGACY_KEYS) delete normalized[key];
  return normalized;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function setIfString(
  target: Record<string, string>,
  key: string,
  value: unknown,
): void {
  const normalized = nonBlank(value);
  if (normalized) target[key] = normalized;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function writeJsonAtomically(path: string, value: Record<string, unknown>): void {
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(tmp, path);
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Best-effort cleanup only; the final path is never replaced by partial content.
    }
  }
}
