import { isJsonObject, type JsonObject } from './json';

export const NODE_CONFIGURATION_ADAPTER_IDS = Object.freeze([
  'claude-code',
  'codex-cli',
  'grok-build',
] as const);
export type NodeConfigurationAdapterId =
  (typeof NODE_CONFIGURATION_ADAPTER_IDS)[number];
export const NODE_CONFIGURATION_THINKING_LEVELS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const);
export type NodeConfigurationThinkingLevel =
  (typeof NODE_CONFIGURATION_THINKING_LEVELS)[number];

export interface NodeProviderDefaultsDto extends JsonObject {
  claudeCliPath: string | null;
  claudeCodeSandbox: 'off' | 'workspace-write' | 'strict';
  codexCliPath: string | null;
  codexSandbox: 'workspace-write' | 'read-only' | 'danger-full-access';
  continuationCheckpointAdapter: NodeConfigurationAdapterId;
  continuationCheckpointAutoRefreshEnabled: boolean;
  continuationCheckpointAutoRefreshIntervalMinutes: number;
  continuationCheckpointMaxConcurrent: number;
  continuationCheckpointModel: string;
  continuationCheckpointRuntimeProvider: string;
  continuationCheckpointThinking: NodeConfigurationThinkingLevel;
  continuationRawRetentionTokens: number;
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
  mcpMaxFanOutPerParent: number;
  mcpMaxSpawnDepth: number;
  mcpSpawnRatePerMinute: number;
  permissionTimeoutMs: number;
  summaryAdapter: NodeConfigurationAdapterId;
  summaryEnabled: boolean;
  summaryEventCount: number;
  summaryIntervalMs: number;
  summaryMaxConcurrent: number;
  summaryModel: string;
  summaryRuntimeProvider: string;
  summaryThinking: NodeConfigurationThinkingLevel;
}

export interface NodeSessionLifecycleDto extends JsonObject {
  activeWindowMs: number;
  closeAfterMs: number;
  historyRetentionDays: number;
  issueResolvedRetentionDays: number;
  issueSoftDeletedRetentionDays: number;
  messageRetentionDays: number;
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

function integer(value: unknown, field: string, min: number, max: number): number {
  const parsed = revision(value, field);
  if (parsed < min || parsed > max) fail(field);
  return parsed;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field);
  return value;
}

function enumText<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(field);
  return value as T;
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
    'continuationCheckpointAdapter', 'continuationCheckpointAutoRefreshEnabled',
    'continuationCheckpointAutoRefreshIntervalMinutes',
    'continuationCheckpointMaxConcurrent', 'continuationCheckpointModel',
    'continuationCheckpointRuntimeProvider', 'continuationCheckpointThinking',
    'continuationRawRetentionTokens',
    'enableAgentDeckMcp', 'grokCliPath', 'grokSandbox',
    'injectAgentDeckClaudeAgents', 'injectAgentDeckClaudeMd',
    'injectAgentDeckClaudeSkills', 'injectAgentDeckCodexAgents',
    'injectAgentDeckCodexAgentsMd', 'injectAgentDeckCodexSkills',
    'injectAgentDeckGrokAgents', 'injectAgentDeckGrokAgentsMd',
    'injectAgentDeckGrokSkills', 'mcpHttpEnabled', 'mcpMaxFanOutPerParent',
    'mcpMaxSpawnDepth', 'mcpSpawnRatePerMinute', 'permissionTimeoutMs',
    'summaryAdapter', 'summaryEnabled', 'summaryEventCount', 'summaryIntervalMs',
    'summaryMaxConcurrent', 'summaryModel', 'summaryRuntimeProvider',
    'summaryThinking',
  ], 'node.configuration.providerDefaults');
  const field = (name: string): string => `node.configuration.providerDefaults.${name}`;
  const booleanKeys = [
    'continuationCheckpointAutoRefreshEnabled', 'enableAgentDeckMcp',
    'injectAgentDeckClaudeAgents', 'injectAgentDeckClaudeMd',
    'injectAgentDeckClaudeSkills', 'injectAgentDeckCodexAgents',
    'injectAgentDeckCodexAgentsMd', 'injectAgentDeckCodexSkills',
    'injectAgentDeckGrokAgents', 'injectAgentDeckGrokAgentsMd',
    'injectAgentDeckGrokSkills', 'mcpHttpEnabled', 'summaryEnabled',
  ] as const;
  for (const key of booleanKeys) {
    boolean(defaults[key], field(key));
  }
  const cliPath = (key: 'claudeCliPath' | 'codexCliPath' | 'grokCliPath'): string | null =>
    defaults[key] === null
      ? null
      : text(defaults[key], field(key), MAX_PATH_BYTES);
  if (!isJsonObject(value.sessionLifecycle)) fail('node.configuration.sessionLifecycle');
  const lifecycle = value.sessionLifecycle;
  exactKeys(
    lifecycle,
    [
      'activeWindowMs', 'closeAfterMs', 'historyRetentionDays',
      'issueResolvedRetentionDays', 'issueSoftDeletedRetentionDays',
      'messageRetentionDays',
    ],
    'node.configuration.sessionLifecycle',
  );
  const lifecycleField = (name: string): string => `node.configuration.sessionLifecycle.${name}`;
  const activeWindowMs = integer(
    lifecycle.activeWindowMs, lifecycleField('activeWindowMs'), 1, 365 * 86_400_000,
  );
  const closeAfterMs = integer(
    lifecycle.closeAfterMs, lifecycleField('closeAfterMs'), 1, 365 * 86_400_000,
  );
  const retention = (key: 'historyRetentionDays' | 'issueResolvedRetentionDays' |
    'issueSoftDeletedRetentionDays' | 'messageRetentionDays'): number =>
    integer(lifecycle[key], lifecycleField(key), 0, 3_650);
  if (activeWindowMs === 0 || closeAfterMs <= activeWindowMs) {
    fail('node.configuration.sessionLifecycle.consistency');
  }
  return {
    providerDefaults: {
      claudeCliPath: cliPath('claudeCliPath'),
      claudeCodeSandbox: enumText(
        defaults.claudeCodeSandbox, ['off', 'workspace-write', 'strict'],
        field('claudeCodeSandbox'),
      ),
      codexCliPath: cliPath('codexCliPath'),
      codexSandbox: enumText(
        defaults.codexSandbox, ['workspace-write', 'read-only', 'danger-full-access'],
        field('codexSandbox'),
      ),
      continuationCheckpointAdapter: parseNodeConfigurationAdapterId(
        defaults.continuationCheckpointAdapter, field('continuationCheckpointAdapter'),
      ),
      continuationCheckpointAutoRefreshEnabled: boolean(
        defaults.continuationCheckpointAutoRefreshEnabled,
        field('continuationCheckpointAutoRefreshEnabled'),
      ),
      continuationCheckpointAutoRefreshIntervalMinutes: integer(
        defaults.continuationCheckpointAutoRefreshIntervalMinutes,
        field('continuationCheckpointAutoRefreshIntervalMinutes'), 5, 1_440,
      ),
      continuationCheckpointMaxConcurrent: integer(
        defaults.continuationCheckpointMaxConcurrent,
        field('continuationCheckpointMaxConcurrent'), 1, 10,
      ),
      continuationCheckpointModel: text(
        defaults.continuationCheckpointModel, field('continuationCheckpointModel'),
      ),
      continuationCheckpointRuntimeProvider: text(
        defaults.continuationCheckpointRuntimeProvider,
        field('continuationCheckpointRuntimeProvider'),
      ),
      continuationCheckpointThinking: enumText(
        defaults.continuationCheckpointThinking, NODE_CONFIGURATION_THINKING_LEVELS,
        field('continuationCheckpointThinking'),
      ),
      continuationRawRetentionTokens: integer(
        defaults.continuationRawRetentionTokens,
        field('continuationRawRetentionTokens'), 8_000, 128_000,
      ),
      enableAgentDeckMcp: boolean(defaults.enableAgentDeckMcp, field('enableAgentDeckMcp')),
      grokCliPath: cliPath('grokCliPath'),
      grokSandbox: text(defaults.grokSandbox, field('grokSandbox')),
      injectAgentDeckClaudeAgents: boolean(
        defaults.injectAgentDeckClaudeAgents, field('injectAgentDeckClaudeAgents'),
      ),
      injectAgentDeckClaudeMd: boolean(
        defaults.injectAgentDeckClaudeMd, field('injectAgentDeckClaudeMd'),
      ),
      injectAgentDeckClaudeSkills: boolean(
        defaults.injectAgentDeckClaudeSkills, field('injectAgentDeckClaudeSkills'),
      ),
      injectAgentDeckCodexAgents: boolean(
        defaults.injectAgentDeckCodexAgents, field('injectAgentDeckCodexAgents'),
      ),
      injectAgentDeckCodexAgentsMd: boolean(
        defaults.injectAgentDeckCodexAgentsMd, field('injectAgentDeckCodexAgentsMd'),
      ),
      injectAgentDeckCodexSkills: boolean(
        defaults.injectAgentDeckCodexSkills, field('injectAgentDeckCodexSkills'),
      ),
      injectAgentDeckGrokAgents: boolean(
        defaults.injectAgentDeckGrokAgents, field('injectAgentDeckGrokAgents'),
      ),
      injectAgentDeckGrokAgentsMd: boolean(
        defaults.injectAgentDeckGrokAgentsMd, field('injectAgentDeckGrokAgentsMd'),
      ),
      injectAgentDeckGrokSkills: boolean(
        defaults.injectAgentDeckGrokSkills, field('injectAgentDeckGrokSkills'),
      ),
      mcpHttpEnabled: boolean(defaults.mcpHttpEnabled, field('mcpHttpEnabled')),
      mcpMaxFanOutPerParent: integer(
        defaults.mcpMaxFanOutPerParent, field('mcpMaxFanOutPerParent'), 1, 20,
      ),
      mcpMaxSpawnDepth: integer(
        defaults.mcpMaxSpawnDepth, field('mcpMaxSpawnDepth'), 1, 10,
      ),
      mcpSpawnRatePerMinute: integer(
        defaults.mcpSpawnRatePerMinute, field('mcpSpawnRatePerMinute'), 1, 60,
      ),
      permissionTimeoutMs: integer(
        defaults.permissionTimeoutMs, field('permissionTimeoutMs'), 0, 86_400_000,
      ),
      summaryAdapter: parseNodeConfigurationAdapterId(
        defaults.summaryAdapter, field('summaryAdapter'),
      ),
      summaryEnabled: boolean(defaults.summaryEnabled, field('summaryEnabled')),
      summaryEventCount: integer(
        defaults.summaryEventCount, field('summaryEventCount'), 1, 1_000_000,
      ),
      summaryIntervalMs: integer(
        defaults.summaryIntervalMs, field('summaryIntervalMs'), 60_000, 86_400_000,
      ),
      summaryMaxConcurrent: integer(
        defaults.summaryMaxConcurrent, field('summaryMaxConcurrent'), 1, 10,
      ),
      summaryModel: text(defaults.summaryModel, field('summaryModel')),
      summaryRuntimeProvider: text(
        defaults.summaryRuntimeProvider, field('summaryRuntimeProvider'),
      ),
      summaryThinking: enumText(
        defaults.summaryThinking, NODE_CONFIGURATION_THINKING_LEVELS,
        field('summaryThinking'),
      ),
    },
    sessionLifecycle: {
      activeWindowMs,
      closeAfterMs,
      historyRetentionDays: retention('historyRetentionDays'),
      issueResolvedRetentionDays: retention('issueResolvedRetentionDays'),
      issueSoftDeletedRetentionDays: retention('issueSoftDeletedRetentionDays'),
      messageRetentionDays: retention('messageRetentionDays'),
    },
    revision: revision(value.revision, 'node.configuration.get.revision'),
  };
}
