import { describe, expect, it } from 'vitest';

import {
  parseNodeConfigurationGetResult,
  parseNodeHookParams,
  parseNodeHookProjectionResult,
  parseNodeHookStatus,
} from './node-configuration';

const providerDefaults = {
  claudeCliPath: '/opt/claude',
  claudeCodeSandbox: 'workspace-write',
  codexCliPath: '/opt/codex',
  codexSandbox: 'read-only',
  continuationCheckpointAdapter: 'claude-code',
  continuationCheckpointAutoRefreshEnabled: true,
  continuationCheckpointAutoRefreshIntervalMinutes: 30,
  continuationCheckpointMaxConcurrent: 2,
  continuationCheckpointModel: '',
  continuationCheckpointRuntimeProvider: '',
  continuationCheckpointThinking: 'medium',
  continuationRawRetentionTokens: 64_000,
  enableAgentDeckMcp: true,
  grokCliPath: '/opt/grok',
  grokSandbox: 'workspace',
  injectAgentDeckClaudeAgents: true,
  injectAgentDeckClaudeMd: true,
  injectAgentDeckClaudeSkills: true,
  injectAgentDeckCodexAgents: true,
  injectAgentDeckCodexAgentsMd: true,
  injectAgentDeckCodexSkills: true,
  injectAgentDeckGrokAgents: true,
  injectAgentDeckGrokAgentsMd: true,
  injectAgentDeckGrokSkills: true,
  mcpHttpEnabled: true,
  mcpMaxFanOutPerParent: 10,
  mcpMaxSpawnDepth: 3,
  mcpSpawnRatePerMinute: 20,
  permissionTimeoutMs: 30_000,
  summaryAdapter: 'claude-code',
  summaryEnabled: true,
  summaryEventCount: 30,
  summaryIntervalMs: 300_000,
  summaryMaxConcurrent: 2,
  summaryModel: 'summary-model',
  summaryRuntimeProvider: '',
  summaryThinking: 'low',
} as const;

describe('node configuration contract', () => {
  it('strictly parses the bounded provider snapshot', () => {
    expect(parseNodeConfigurationGetResult({
      providerDefaults: {
        ...providerDefaults,
      },
      sessionLifecycle: {
        activeWindowMs: 3_600_000,
        closeAfterMs: 86_400_000,
        historyRetentionDays: 30,
        issueResolvedRetentionDays: 30,
        issueSoftDeletedRetentionDays: 7,
        messageRetentionDays: 30,
      },
      revision: 7,
    })).toMatchObject({ revision: 7, providerDefaults: { enableAgentDeckMcp: true } });
    expect(() => parseNodeConfigurationGetResult({
      providerDefaults: { ...providerDefaults, summaryTimeoutMs: 60_000 },
      sessionLifecycle: {
        activeWindowMs: 3_600_000,
        closeAfterMs: 86_400_000,
        historyRetentionDays: 30,
        issueResolvedRetentionDays: 30,
        issueSoftDeletedRetentionDays: 7,
        messageRetentionDays: 30,
      },
      revision: 7,
    })).toThrow('Invalid node configuration contract');
    expect(() => parseNodeConfigurationGetResult({
      providerDefaults: {},
      sessionLifecycle: {},
      revision: 7,
    })).toThrow('Invalid node configuration contract');
  });

  it('accepts only known adapters and exact adapter-owned hook output', () => {
    expect(parseNodeHookParams({ adapterId: 'claude-code' })).toEqual({
      adapterId: 'claude-code',
    });
    expect(parseNodeHookStatus({
      installed: true,
      installedHooks: ['SessionStart'],
      scope: 'user',
      settingsPath: '/provider-home/.codex/hooks.json',
    })).toMatchObject({ installed: true, scope: 'user' });
    expect(() => parseNodeHookParams({ adapterId: 'unknown' })).toThrow();
    expect(() => parseNodeHookStatus({
      installed: true,
      installedHooks: [],
      scope: 'user',
      settingsPath: '/tmp/hooks.json',
      extra: true,
    })).toThrow();
  });

  it('parses only the path-free Remote Hook projection', () => {
    expect(parseNodeHookProjectionResult({
      adapterId: 'codex-cli',
      revision: 10,
      status: {
        supported: true,
        state: 'installed',
        scope: 'user',
        writeAllowed: true,
        disabledReason: null,
      },
    })).toMatchObject({ adapterId: 'codex-cli', revision: 10 });
    expect(parseNodeHookProjectionResult({
      adapterId: 'claude-code',
      revision: 10,
      status: {
        supported: true,
        state: 'unavailable',
        scope: 'user',
        writeAllowed: true,
        disabledReason: null,
      },
    })).toMatchObject({ status: { state: 'unavailable', writeAllowed: true } });
    expect(() => parseNodeHookProjectionResult({
      adapterId: 'codex-cli',
      revision: 10,
      status: {
        supported: true,
        state: 'installed',
        scope: 'user',
        writeAllowed: true,
        disabledReason: null,
        settingsPath: '/provider-home/.codex/hooks.json',
      },
    })).toThrow('Invalid node configuration contract');
    expect(() => parseNodeHookProjectionResult({
      adapterId: 'codex-cli',
      revision: 10,
      status: {
        supported: false,
        state: 'installed',
        scope: null,
        writeAllowed: false,
        disabledReason: 'status-unavailable',
      },
    })).toThrow('Invalid node configuration contract');
  });
});
