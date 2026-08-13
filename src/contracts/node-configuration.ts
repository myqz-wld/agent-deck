import { isJsonObject, type JsonObject } from './json';

export const NODE_CONFIGURATION_ADAPTER_IDS = Object.freeze([
  'claude-code',
  'codex-cli',
  'grok-build',
] as const);
export type NodeConfigurationAdapterId =
  (typeof NODE_CONFIGURATION_ADAPTER_IDS)[number];

export interface NodeProviderDefaultsDto extends JsonObject {
  claudeCliPath: string | null;
  claudeCodeSandbox: 'off' | 'workspace-write' | 'strict';
  codexCliPath: string | null;
  codexSandbox: 'workspace-write' | 'read-only' | 'danger-full-access';
  enableAgentDeckMcp: boolean;
  grokCliPath: string | null;
  grokSandbox: string;
  injectAgentDeckClaudeAgents: boolean;
  injectAgentDeckClaudeMd: boolean;
  injectAgentDeckClaudeSkills: boolean;
  injectAgentDeckCodexAgents: boolean;
  injectAgentDeckCodexAgentsMd: boolean;
  injectAgentDeckCodexSkills: boolean;
  injectAgentDeckGrokAgents: boolean;
  injectAgentDeckGrokAgentsMd: boolean;
  injectAgentDeckGrokSkills: boolean;
  mcpHttpEnabled: boolean;
  permissionTimeoutMs: number;
  summaryModel: string;
  summaryThinking: string;
  summaryTimeoutMs: number;
}

export interface NodeSessionLifecycleDto extends JsonObject {
  activeWindowMs: number;
  closeAfterMs: number;
  historyRetentionDays: number;
}

export interface NodeConfigurationGetResult {
  providerDefaults: NodeProviderDefaultsDto;
  sessionLifecycle: NodeSessionLifecycleDto;
  revision: number;
}

export interface NodeHookParams {
  adapterId: NodeConfigurationAdapterId;
}

export interface NodeHookStatusDto {
  installed: boolean;
  scope: 'user' | 'project' | null;
  settingsPath: string | null;
  installedHooks: string[];
}

export const NODE_HOOK_PROJECTION_STATES = Object.freeze([
  'installed',
  'partial',
  'not-installed',
  'unavailable',
] as const);
export type NodeHookProjectionState = (typeof NODE_HOOK_PROJECTION_STATES)[number];

export const NODE_HOOK_DISABLED_REASONS = Object.freeze([
  'adapter-unavailable',
  'status-unavailable',
  'mutation-unavailable',
] as const);
export type NodeHookDisabledReason = (typeof NODE_HOOK_DISABLED_REASONS)[number];

/** Remote-safe Hook projection. It deliberately contains no path or raw Hook identifiers. */
export interface NodeHookProjectionStatusDto extends JsonObject {
  supported: boolean;
  state: NodeHookProjectionState;
  scope: 'user' | null;
  writeAllowed: boolean;
  disabledReason: NodeHookDisabledReason | null;
}

export interface NodeHookProjectionResult {
  adapterId: NodeConfigurationAdapterId;
  status: NodeHookProjectionStatusDto;
  revision: number;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_PATH_BYTES = 4_096;
const MAX_TEXT_BYTES = 512;
const MAX_HOOKS = 64;

function fail(field: string): never {
  throw new Error(`Invalid node configuration contract: ${field}`);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(field);
  }
}

function text(value: unknown, field: string, maxBytes = MAX_TEXT_BYTES): string {
  if (
    typeof value !== 'string' || new TextEncoder().encode(value).byteLength > maxBytes ||
    CONTROL.test(value)
  ) fail(field);
  return value;
}

function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(field);
  return Number(value);
}

export function parseNodeConfigurationAdapterId(
  value: unknown,
  field = 'adapterId',
): NodeConfigurationAdapterId {
  if (!NODE_CONFIGURATION_ADAPTER_IDS.includes(value as NodeConfigurationAdapterId)) fail(field);
  return value as NodeConfigurationAdapterId;
}

export function parseNodeHookParams(value: unknown): NodeHookParams {
  if (!isJsonObject(value)) fail('node.hook.params');
  exactKeys(value, ['adapterId'], 'node.hook.params');
  return { adapterId: parseNodeConfigurationAdapterId(value.adapterId) };
}

export function parseNodeHookStatus(value: unknown): NodeHookStatusDto {
  if (!isJsonObject(value)) fail('node.hook.status');
  exactKeys(
    value,
    ['installed', 'installedHooks', 'scope', 'settingsPath'],
    'node.hook.status',
  );
  if (typeof value.installed !== 'boolean') fail('node.hook.status.installed');
  if (value.scope !== null && value.scope !== 'user' && value.scope !== 'project') {
    fail('node.hook.status.scope');
  }
  const settingsPath = value.settingsPath === null
    ? null
    : text(value.settingsPath, 'node.hook.status.settingsPath', MAX_PATH_BYTES);
  if (!Array.isArray(value.installedHooks) || value.installedHooks.length > MAX_HOOKS) {
    fail('node.hook.status.installedHooks');
  }
  const installedHooks = value.installedHooks.map((item, index) =>
    text(item, `node.hook.status.installedHooks[${index}]`));
  return {
    installed: value.installed,
    scope: value.scope,
    settingsPath,
    installedHooks,
  };
}

export function parseNodeHookProjectionStatus(value: unknown): NodeHookProjectionStatusDto {
  if (!isJsonObject(value)) fail('node.hook.projection.status');
  exactKeys(
    value,
    ['disabledReason', 'scope', 'state', 'supported', 'writeAllowed'],
    'node.hook.projection.status',
  );
  if (typeof value.supported !== 'boolean') fail('node.hook.projection.status.supported');
  if (typeof value.writeAllowed !== 'boolean') fail('node.hook.projection.status.writeAllowed');
  if (!NODE_HOOK_PROJECTION_STATES.includes(value.state as NodeHookProjectionState)) {
    fail('node.hook.projection.status.state');
  }
  if (value.scope !== null && value.scope !== 'user') fail('node.hook.projection.status.scope');
  if (
    value.disabledReason !== null &&
    !NODE_HOOK_DISABLED_REASONS.includes(value.disabledReason as NodeHookDisabledReason)
  ) {
    fail('node.hook.projection.status.disabledReason');
  }
  if (
    (!value.supported && value.state !== 'unavailable') ||
    (!value.supported && value.scope !== null) ||
    (!value.supported && value.writeAllowed) ||
    (value.supported && value.scope !== 'user') ||
    (value.writeAllowed && value.disabledReason !== null)
  ) {
    fail('node.hook.projection.status.consistency');
  }
  return {
    supported: value.supported,
    state: value.state as NodeHookProjectionState,
    scope: value.scope,
    writeAllowed: value.writeAllowed,
    disabledReason: value.disabledReason as NodeHookDisabledReason | null,
  };
}

export function parseNodeHookProjectionResult(value: unknown): NodeHookProjectionResult {
  if (!isJsonObject(value)) fail('node.hook.projection.result');
  exactKeys(value, ['adapterId', 'revision', 'status'], 'node.hook.projection.result');
  return {
    adapterId: parseNodeConfigurationAdapterId(value.adapterId),
    status: parseNodeHookProjectionStatus(value.status),
    revision: revision(value.revision, 'node.hook.projection.result.revision'),
  };
}

export function parseNodeConfigurationGetResult(value: unknown): NodeConfigurationGetResult {
  if (!isJsonObject(value)) fail('node.configuration.get.result');
  exactKeys(
    value,
    ['providerDefaults', 'revision', 'sessionLifecycle'],
    'node.configuration.get.result',
  );
  if (!isJsonObject(value.providerDefaults)) fail('node.configuration.providerDefaults');
  const defaults = value.providerDefaults;
  exactKeys(defaults, [
    'claudeCliPath', 'claudeCodeSandbox', 'codexCliPath', 'codexSandbox',
    'enableAgentDeckMcp', 'grokCliPath', 'grokSandbox',
    'injectAgentDeckClaudeAgents', 'injectAgentDeckClaudeMd',
    'injectAgentDeckClaudeSkills', 'injectAgentDeckCodexAgents',
    'injectAgentDeckCodexAgentsMd', 'injectAgentDeckCodexSkills',
    'injectAgentDeckGrokAgents', 'injectAgentDeckGrokAgentsMd',
    'injectAgentDeckGrokSkills', 'mcpHttpEnabled', 'permissionTimeoutMs',
    'summaryModel', 'summaryThinking', 'summaryTimeoutMs',
  ], 'node.configuration.providerDefaults');
  if (!['off', 'workspace-write', 'strict'].includes(String(defaults.claudeCodeSandbox))) {
    fail('node.configuration.providerDefaults.claudeCodeSandbox');
  }
  if (!['workspace-write', 'read-only', 'danger-full-access'].includes(String(defaults.codexSandbox))) {
    fail('node.configuration.providerDefaults.codexSandbox');
  }
  if (typeof defaults.enableAgentDeckMcp !== 'boolean') {
    fail('node.configuration.providerDefaults.enableAgentDeckMcp');
  }
  const booleanKeys = [
    'injectAgentDeckClaudeAgents', 'injectAgentDeckClaudeMd',
    'injectAgentDeckClaudeSkills', 'injectAgentDeckCodexAgents',
    'injectAgentDeckCodexAgentsMd', 'injectAgentDeckCodexSkills',
    'injectAgentDeckGrokAgents', 'injectAgentDeckGrokAgentsMd',
    'injectAgentDeckGrokSkills', 'mcpHttpEnabled',
  ] as const;
  for (const key of booleanKeys) {
    if (typeof defaults[key] !== 'boolean') {
      fail(`node.configuration.providerDefaults.${key}`);
    }
  }
  const cliPath = (key: 'claudeCliPath' | 'codexCliPath' | 'grokCliPath'): string | null =>
    defaults[key] === null
      ? null
      : text(defaults[key], `node.configuration.providerDefaults.${key}`, MAX_PATH_BYTES);
  const permissionTimeoutMs = revision(
    defaults.permissionTimeoutMs,
    'node.configuration.providerDefaults.permissionTimeoutMs',
  );
  const summaryTimeoutMs = revision(
    defaults.summaryTimeoutMs,
    'node.configuration.providerDefaults.summaryTimeoutMs',
  );
  if (!isJsonObject(value.sessionLifecycle)) fail('node.configuration.sessionLifecycle');
  const lifecycle = value.sessionLifecycle;
  exactKeys(
    lifecycle,
    ['activeWindowMs', 'closeAfterMs', 'historyRetentionDays'],
    'node.configuration.sessionLifecycle',
  );
  const activeWindowMs = revision(
    lifecycle.activeWindowMs,
    'node.configuration.sessionLifecycle.activeWindowMs',
  );
  const closeAfterMs = revision(
    lifecycle.closeAfterMs,
    'node.configuration.sessionLifecycle.closeAfterMs',
  );
  const historyRetentionDays = revision(
    lifecycle.historyRetentionDays,
    'node.configuration.sessionLifecycle.historyRetentionDays',
  );
  if (activeWindowMs === 0 || closeAfterMs <= activeWindowMs) {
    fail('node.configuration.sessionLifecycle.consistency');
  }
  return {
    providerDefaults: {
      claudeCliPath: cliPath('claudeCliPath'),
      claudeCodeSandbox: defaults.claudeCodeSandbox as NodeProviderDefaultsDto['claudeCodeSandbox'],
      codexCliPath: cliPath('codexCliPath'),
      codexSandbox: defaults.codexSandbox as NodeProviderDefaultsDto['codexSandbox'],
      enableAgentDeckMcp: defaults.enableAgentDeckMcp,
      grokCliPath: cliPath('grokCliPath'),
      grokSandbox: text(defaults.grokSandbox, 'node.configuration.providerDefaults.grokSandbox'),
      injectAgentDeckClaudeAgents: defaults.injectAgentDeckClaudeAgents as boolean,
      injectAgentDeckClaudeMd: defaults.injectAgentDeckClaudeMd as boolean,
      injectAgentDeckClaudeSkills: defaults.injectAgentDeckClaudeSkills as boolean,
      injectAgentDeckCodexAgents: defaults.injectAgentDeckCodexAgents as boolean,
      injectAgentDeckCodexAgentsMd: defaults.injectAgentDeckCodexAgentsMd as boolean,
      injectAgentDeckCodexSkills: defaults.injectAgentDeckCodexSkills as boolean,
      injectAgentDeckGrokAgents: defaults.injectAgentDeckGrokAgents as boolean,
      injectAgentDeckGrokAgentsMd: defaults.injectAgentDeckGrokAgentsMd as boolean,
      injectAgentDeckGrokSkills: defaults.injectAgentDeckGrokSkills as boolean,
      mcpHttpEnabled: defaults.mcpHttpEnabled as boolean,
      permissionTimeoutMs,
      summaryModel: text(defaults.summaryModel, 'node.configuration.providerDefaults.summaryModel'),
      summaryThinking: text(defaults.summaryThinking, 'node.configuration.providerDefaults.summaryThinking'),
      summaryTimeoutMs,
    },
    sessionLifecycle: { activeWindowMs, closeAfterMs, historyRetentionDays },
    revision: revision(value.revision, 'node.configuration.get.revision'),
  };
}
