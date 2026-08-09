import { describe, expect, it, vi } from 'vitest';
import {
  resolveClaudeEffortCore,
  resolveClaudeModelCore,
  resolveClaudeSandboxModeCore,
  withResolvedClaudeGatewayCore,
  type ClaudeSessionDefaultsHost,
} from './session-defaults-core';

function makeHost(): ClaudeSessionDefaultsHost {
  return {
    readPersistedSession: vi.fn(() => ({
      model: 'stored-model',
      claudeCodeSandbox: 'strict' as const,
      thinking: 'high',
      runtimeProvider: 'deepseek',
    })),
    readSandboxDefault: vi.fn(() => 'workspace-write' as const),
    resolveGatewayProfile: vi.fn(() => ({
      id: 'deepseek',
      settingsPath: '/profiles/deepseek.json',
      defaultModel: 'deepseek-v4-pro[1m]',
      modelAliases: { opus: 'deepseek-v4-pro[1m]' },
    })),
  };
}

describe('Claude session defaults Core', () => {
  it('preserves explicit, persisted, profile, and lazy global precedence', () => {
    const host = makeHost();
    expect(resolveClaudeModelCore({
      resume: 'session', model: 'explicit', profileDefaultModel: 'profile',
    }, host)).toBe('explicit');
    expect(resolveClaudeSandboxModeCore({ resume: 'session' }, host)).toBe('strict');
    expect(resolveClaudeEffortCore({ resume: 'session' }, host)).toBe('high');
    expect(host.readSandboxDefault).not.toHaveBeenCalled();

    vi.mocked(host.readPersistedSession).mockReturnValue(null);
    expect(resolveClaudeModelCore({ profileDefaultModel: 'profile' }, host)).toBe('profile');
    expect(resolveClaudeSandboxModeCore({}, host)).toBe('workspace-write');
  });

  it('resolves a persisted Gateway into one session-local option set', () => {
    const host = makeHost();
    const input = { resume: 'session', cwd: '/repo' };
    const result = withResolvedClaudeGatewayCore(input, host);
    expect(result).toEqual({
      resume: 'session',
      cwd: '/repo',
      gateway: 'deepseek',
      settingsPath: '/profiles/deepseek.json',
      profileDefaultModel: 'deepseek-v4-pro[1m]',
      gatewayModelAliases: { opus: 'deepseek-v4-pro[1m]' },
    });
  });
});
