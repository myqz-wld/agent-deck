import { isJsonObject, SESSION_CONSOLE_MAX_OPTION_VALUES, type JsonObject } from '@contracts/index';
import { getAdapterRuntimeProfile } from '@main/adapters/runtime-profiles';
import {
  isAdapterSessionMode,
  isCodexApprovalPolicy,
  isSelectablePermissionMode,
  type SessionAdapterId,
  type SessionCreationDefaults,
} from '@shared/types';

import { hasRemoteSensitiveValue } from './remote-sensitive-data';
import type { ServerCoreProviderSettings } from './provider-settings';

const ADAPTER_IDS = Object.freeze([
  'claude-code', 'codex-cli', 'grok-build',
] as const satisfies readonly SessionAdapterId[]);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_TEXT_BYTES = 512;

export interface ServerCoreSessionCreateCatalogEntry {
  readonly adapterId: SessionAdapterId;
  readonly defaults: SessionCreationDefaults;
  readonly providers: readonly string[];
}

export interface ServerCoreSessionCreateCatalog {
  get(adapterId: SessionAdapterId): ServerCoreSessionCreateCatalogEntry;
}

function fail(field: string): never {
  throw new Error(`runtimeOptions.sessionCreationCatalog.${field} is invalid`);
}

function exact(value: JsonObject, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    fail(field);
  }
}

function safeText(value: unknown, field: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' || (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value) > MAX_TEXT_BYTES || CONTROL.test(value) ||
    hasRemoteSensitiveValue(value)
  ) fail(field);
  return value;
}

function safeProvider(value: unknown, field: string): string {
  const parsed = safeText(value, field);
  if (!SAFE_TOKEN.test(parsed)) fail(field);
  return parsed;
}

function baseDefaults(settings: ServerCoreProviderSettings): SessionCreationDefaults {
  return {
    provider: '',
    model: '',
    thinking: 'high',
    permissionMode: 'bypassPermissions',
    sessionMode: 'default',
    approvalPolicy: 'never',
    codexSandbox: settings.codexSandbox,
    claudeCodeSandbox: settings.claudeCodeSandbox,
    grokSandbox: settings.grokSandbox,
  };
}

function defaultEntry(
  adapterId: SessionAdapterId,
  settings: ServerCoreProviderSettings,
): ServerCoreSessionCreateCatalogEntry {
  return Object.freeze({
    adapterId,
    defaults: Object.freeze({
      ...baseDefaults(settings),
      ...(adapterId === 'grok-build' ? { model: 'grok-4.5' } : {}),
    }),
    providers: Object.freeze([]),
  });
}

function parseEntry(
  value: unknown,
  settings: ServerCoreProviderSettings,
  index: number,
): ServerCoreSessionCreateCatalogEntry {
  const field = `adapters[${index}]`;
  if (!isJsonObject(value)) fail(field);
  const adapterId = value.adapterId;
  if (!ADAPTER_IDS.includes(adapterId as SessionAdapterId)) fail(`${field}.adapterId`);
  const id = adapterId as SessionAdapterId;
  const adapterKeys = id === 'claude-code'
    ? ['adapterId', 'model', 'permissionMode', 'provider', 'providers', 'thinking']
    : id === 'codex-cli'
      ? ['adapterId', 'approvalPolicy', 'model', 'provider', 'providers', 'thinking']
      : ['adapterId', 'model', 'sessionMode', 'thinking'];
  exact(value, adapterKeys, field);
  const providers = id === 'grok-build'
    ? []
    : (() => {
        if (!Array.isArray(value.providers) ||
            value.providers.length > SESSION_CONSOLE_MAX_OPTION_VALUES) {
          fail(`${field}.providers`);
        }
        const parsed = value.providers.map((item, providerIndex) =>
          safeProvider(item, `${field}.providers[${providerIndex}]`));
        if (new Set(parsed).size !== parsed.length) fail(`${field}.providers`);
        return parsed;
      })();
  const provider = id === 'grok-build'
    ? ''
    : safeText(value.provider, `${field}.provider`, true);
  if (provider && !providers.includes(provider)) fail(`${field}.provider`);
  const model = safeText(value.model, `${field}.model`, true);
  const thinking = safeText(value.thinking, `${field}.thinking`);
  if (!getAdapterRuntimeProfile(id).model.thinkingLevels.includes(thinking)) {
    fail(`${field}.thinking`);
  }
  const defaults = baseDefaults(settings);
  defaults.provider = provider;
  defaults.model = model;
  defaults.thinking = thinking as SessionCreationDefaults['thinking'];
  if (id === 'claude-code') {
    if (!isSelectablePermissionMode(value.permissionMode)) fail(`${field}.permissionMode`);
    defaults.permissionMode = value.permissionMode;
  } else if (id === 'codex-cli') {
    if (!isCodexApprovalPolicy(value.approvalPolicy)) fail(`${field}.approvalPolicy`);
    defaults.approvalPolicy = value.approvalPolicy;
  } else {
    if (!isAdapterSessionMode(value.sessionMode)) fail(`${field}.sessionMode`);
    defaults.sessionMode = value.sessionMode;
  }
  return Object.freeze({
    adapterId: id,
    defaults: Object.freeze(defaults),
    providers: Object.freeze(providers),
  });
}

/** Parses an explicit non-secret catalog. No provider Home or provider config file is consulted. */
export function resolveServerCoreSessionCreateCatalog(
  runtimeOptions: JsonObject,
  settings: ServerCoreProviderSettings,
): ServerCoreSessionCreateCatalog {
  const raw = runtimeOptions.sessionCreationCatalog;
  const entries = new Map<SessionAdapterId, ServerCoreSessionCreateCatalogEntry>();
  if (raw !== undefined) {
    if (!isJsonObject(raw)) fail('root');
    exact(raw, ['adapters', 'schemaVersion'], 'root');
    if (raw.schemaVersion !== 1) fail('schemaVersion');
    if (!Array.isArray(raw.adapters) || raw.adapters.length > ADAPTER_IDS.length) {
      fail('adapters');
    }
    raw.adapters.forEach((item, index) => {
      const parsed = parseEntry(item, settings, index);
      if (entries.has(parsed.adapterId)) fail(`adapters[${index}].adapterId`);
      entries.set(parsed.adapterId, parsed);
    });
  }
  for (const adapterId of ADAPTER_IDS) {
    if (!entries.has(adapterId)) entries.set(adapterId, defaultEntry(adapterId, settings));
  }
  return Object.freeze({
    get(adapterId: SessionAdapterId): ServerCoreSessionCreateCatalogEntry {
      return entries.get(adapterId)!;
    },
  });
}
