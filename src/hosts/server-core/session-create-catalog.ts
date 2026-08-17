import { isJsonObject, SESSION_CONSOLE_MAX_OPTION_VALUES, type JsonObject } from '@contracts/index';
import {
  canonicalProviderDirectory,
  readOptionalProviderFile,
} from '@hosts/provider-state/provider-home-files';
import { PROVIDER_SESSION_CATALOG_FILE } from '@hosts/provider-state/provider-session-projection';
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
const MAX_CATALOG_BYTES = 64 * 1024;

interface ServerCoreSessionCreateProviderProfile {
  readonly id: string;
  readonly model: string;
  readonly thinking: SessionCreationDefaults['thinking'];
  readonly approvalPolicy?: SessionCreationDefaults['approvalPolicy'];
}

export interface ServerCoreSessionCreateCatalogEntry {
  readonly adapterId: SessionAdapterId;
  readonly defaults: SessionCreationDefaults;
  readonly providers: readonly string[];
  readonly providerProfiles: readonly ServerCoreSessionCreateProviderProfile[];
}

export interface ServerCoreSessionCreateCatalog {
  get(
    adapterId: SessionAdapterId,
    provider?: string | null,
  ): ServerCoreSessionCreateCatalogEntry;
}

function fail(field: string): never {
  throw new Error(`Worker provider session projection ${field} is invalid`);
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
    providerProfiles: Object.freeze([]),
  });
}

function parseProfile(
  value: unknown,
  adapterId: SessionAdapterId,
  field: string,
): ServerCoreSessionCreateProviderProfile {
  if (!isJsonObject(value)) fail(field);
  exact(
    value,
    adapterId === 'codex-cli'
      ? ['approvalPolicy', 'id', 'model', 'thinking']
      : ['id', 'model', 'thinking'],
    field,
  );
  const id = safeProvider(value.id, `${field}.id`);
  const model = safeText(value.model, `${field}.model`, true);
  const thinking = safeText(value.thinking, `${field}.thinking`);
  if (!getAdapterRuntimeProfile(adapterId).model.thinkingLevels.includes(thinking)) {
    fail(`${field}.thinking`);
  }
  const approvalPolicy = adapterId === 'codex-cli'
    ? value.approvalPolicy
    : undefined;
  if (adapterId === 'codex-cli' && !isCodexApprovalPolicy(approvalPolicy)) {
    fail(`${field}.approvalPolicy`);
  }
  return Object.freeze({
    id,
    model,
    thinking: thinking as SessionCreationDefaults['thinking'],
    ...(isCodexApprovalPolicy(approvalPolicy) ? { approvalPolicy } : {}),
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
      : ['adapterId', 'model', 'provider', 'providers', 'sessionMode', 'thinking'];
  exact(value, adapterKeys, field);
  if (!Array.isArray(value.providers) ||
      value.providers.length > SESSION_CONSOLE_MAX_OPTION_VALUES) {
    fail(`${field}.providers`);
  }
  const profiles = value.providers.map((item, providerIndex) =>
    parseProfile(item, id, `${field}.providers[${providerIndex}]`));
  const providers = profiles.map((profile) => profile.id);
  if (new Set(providers).size !== providers.length) fail(`${field}.providers`);
  if (id === 'grok-build' && providers.length > 0) fail(`${field}.providers`);
  const provider = safeText(value.provider, `${field}.provider`, true);
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
    providerProfiles: Object.freeze(profiles),
  });
}

function readProjection(providerHomeRoot: string): JsonObject | null {
  const root = canonicalProviderDirectory(
    providerHomeRoot,
    'provider session projection home',
    true,
  );
  const bytes = readOptionalProviderFile(root, PROVIDER_SESSION_CATALOG_FILE, {
    maxBytes: MAX_CATALOG_BYTES,
    private: true,
  });
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!isJsonObject(parsed)) fail('root');
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Worker provider session projection')) {
      throw error;
    }
    return fail('root');
  } finally {
    bytes.fill(0);
  }
}

/** Reads one trusted, derived snapshot; Remote requests never open raw provider configuration. */
export function resolveServerCoreSessionCreateCatalog(
  providerHomeRoot: string,
  settings: ServerCoreProviderSettings,
): ServerCoreSessionCreateCatalog {
  const raw = readProjection(providerHomeRoot);
  const entries = new Map<SessionAdapterId, ServerCoreSessionCreateCatalogEntry>();
  if (raw !== null) {
    exact(raw, ['adapters', 'schemaVersion'], 'root');
    if (raw.schemaVersion !== 3) fail('schemaVersion');
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
    get(adapterId, provider): ServerCoreSessionCreateCatalogEntry {
      const entry = entries.get(adapterId)!;
      const requested = provider?.trim();
      if (!requested) return entry;
      const profile = entry.providerProfiles.find((candidate) => candidate.id === requested);
      if (!profile) return entry;
      return Object.freeze({
        ...entry,
        defaults: Object.freeze({
          ...entry.defaults,
          provider: profile.id,
          model: profile.model,
          thinking: profile.thinking,
          ...(profile.approvalPolicy !== undefined
            ? { approvalPolicy: profile.approvalPolicy }
            : {}),
        }),
      });
    },
  });
}
