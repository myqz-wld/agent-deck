import { describe, expect, it } from 'vitest';

import {
  parseNodeConfigurationGetResult,
  parseNodeHookParams,
  parseNodeHookStatusResult,
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

  it('accepts only known adapters and an exact hook status shape', () => {
    expect(parseNodeHookParams({ adapterId: 'claude-code' })).toEqual({
      adapterId: 'claude-code',
    });
    expect(parseNodeHookStatusResult({
      adapterId: 'codex-cli',
      revision: 9,
      status: {
        installed: true,
        installedHooks: ['SessionStart'],
        scope: 'user',
        settingsPath: '/provider-home/.codex/hooks.json',
      },
    })).toMatchObject({ adapterId: 'codex-cli', revision: 9 });
    expect(() => parseNodeHookParams({ adapterId: 'unknown' })).toThrow();
    expect(() => parseNodeHookStatusResult({
      adapterId: 'codex-cli',
      revision: 9,
      status: {
        installed: true,
        installedHooks: [],
        scope: 'user',
        settingsPath: '/tmp/hooks.json',
        extra: true,
      },
    })).toThrow();
  });
});
