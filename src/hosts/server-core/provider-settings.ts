import { isAbsolute, normalize } from 'node:path';

import { isJsonObject, type JsonObject } from '@contracts/index';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
} from '@shared/types';
import { normalizeGrokSandboxProfile } from '@shared/grok-sandbox';
import { normalizeBundledAgentRuntimeOverrideMap } from '@main/bundled-agent-runtime-validation';

const MAX_PATH_BYTES = 4_096;
const MAX_TEXT_BYTES = 512;
const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export const SERVER_CORE_PROVIDER_SETTINGS_KEYS = Object.freeze([
  'bundledAgentRuntimeOverrides',
  'claudeCliPath',
  'claudeCodeSandbox',
  'codexCliPath',
  'codexSandbox',
  'enableAgentDeckMcp',
  'grokCliPath',
  'grokSandbox',
  'injectAgentDeckClaudeAgents',
  'injectAgentDeckClaudeMd',
  'injectAgentDeckClaudeSkills',
  'injectAgentDeckCodexAgents',
  'injectAgentDeckCodexAgentsMd',
  'injectAgentDeckCodexSkills',
  'injectAgentDeckGrokAgents',
  'injectAgentDeckGrokAgentsMd',
  'injectAgentDeckGrokSkills',
  'mcpHttpEnabled',
  'permissionTimeoutMs',
  'summaryModel',
  'summaryThinking',
  'summaryTimeoutMs',
] as const);

export type ServerCoreProviderSettingKey =
  (typeof SERVER_CORE_PROVIDER_SETTINGS_KEYS)[number];

export type ServerCoreProviderSettings = Readonly<
  Pick<AppSettings, ServerCoreProviderSettingKey>
>;

function fail(field: string): never {
  throw new Error(`runtimeOptions.providerSettings.${field} is invalid`);
}

function exactKeys(value: JsonObject): void {
  const allowed = new Set<string>(SERVER_CORE_PROVIDER_SETTINGS_KEYS);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(key);
  }
}

function optionalPath(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    Buffer.byteLength(value) === 0 ||
    Buffer.byteLength(value) > MAX_PATH_BYTES ||
    CONTROL.test(value)
  ) {
    fail(field);
  }
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field);
  return value;
}

function duration(value: unknown, field: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_DURATION_MS
  ) {
    fail(field);
  }
  return value as number;
}

function text(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > MAX_TEXT_BYTES ||
    CONTROL.test(value)
  ) {
    fail(field);
  }
  return value.trim();
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(field);
  return value as T;
}

function resolveValue<K extends ServerCoreProviderSettingKey>(
  raw: JsonObject,
  key: K,
): AppSettings[K] {
  const value = raw[key];
  if (value === undefined) {
    return (key === 'bundledAgentRuntimeOverrides'
      ? Object.freeze({})
      : DEFAULT_SETTINGS[key]) as AppSettings[K];
  }
  switch (key) {
    case 'bundledAgentRuntimeOverrides':
      try {
        return Object.freeze(Object.fromEntries(
          Object.entries(normalizeBundledAgentRuntimeOverrideMap(value)).map(
            ([agentId, override]) => [agentId, Object.freeze({ ...override })],
          ),
        )) as AppSettings[K];
      } catch {
        return fail(key);
      }
    case 'claudeCliPath':
    case 'codexCliPath':
    case 'grokCliPath':
      return optionalPath(value, key) as AppSettings[K];
    case 'claudeCodeSandbox':
      return enumValue(value, ['off', 'workspace-write', 'strict'], key) as AppSettings[K];
    case 'codexSandbox':
      return enumValue(
        value,
        ['workspace-write', 'read-only', 'danger-full-access'],
        key,
      ) as AppSettings[K];
    case 'grokSandbox': {
      if (typeof value !== 'string') fail(key);
      let normalized: string;
      try {
        normalized = normalizeGrokSandboxProfile(value);
      } catch {
        fail(key);
      }
      if (!normalized) fail(key);
      return normalized as AppSettings[K];
    }
    case 'permissionTimeoutMs':
    case 'summaryTimeoutMs':
      return duration(value, key) as AppSettings[K];
    case 'summaryModel':
      return text(value, key) as AppSettings[K];
    case 'summaryThinking':
      return enumValue(
        value,
        ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        key,
      ) as AppSettings[K];
    default:
      return bool(value, key) as AppSettings[K];
  }
}

/**
 * Resolves the immutable provider-only settings snapshot owned by one Server Core process.
 * Unknown root runtime options remain available to later Core composition, while this nested
 * object is exact so a misspelled security or sandbox setting cannot silently fall back.
 */
export function resolveServerCoreProviderSettings(
  runtimeOptions: JsonObject,
): ServerCoreProviderSettings {
  const candidate = runtimeOptions.providerSettings;
  if (candidate !== undefined && !isJsonObject(candidate)) {
    throw new Error('runtimeOptions.providerSettings must be an object');
  }
  const raw = candidate ?? {};
  exactKeys(raw);
  return Object.freeze(Object.fromEntries(
    SERVER_CORE_PROVIDER_SETTINGS_KEYS.map((key) => [
      key,
      resolveValue(raw, key),
    ]),
  ) as unknown as ServerCoreProviderSettings);
}
