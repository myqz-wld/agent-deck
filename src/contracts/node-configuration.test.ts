import { describe, expect, it } from 'vitest';

import {
  parseNodeConfigurationGetResult,
  parseNodeHookParams,
  parseNodeHookProjectionResult,
  parseNodeHookStatus,
} from './node-configuration';

describe('node configuration contract', () => {
  it('strictly parses the bounded provider snapshot', () => {
    expect(parseNodeConfigurationGetResult({
      providerDefaults: {
        claudeCodeSandbox: 'workspace-write',
        codexSandbox: 'read-only',
        enableAgentDeckMcp: true,
        grokSandbox: 'strict',
        permissionTimeoutMs: 30_000,
        summaryModel: 'summary-model',
        summaryThinking: 'low',
        summaryTimeoutMs: 60_000,
      },
      revision: 7,
    })).toMatchObject({ revision: 7, providerDefaults: { enableAgentDeckMcp: true } });
    expect(() => parseNodeConfigurationGetResult({
      providerDefaults: {},
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
