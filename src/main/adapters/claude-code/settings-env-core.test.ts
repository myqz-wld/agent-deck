import { describe, expect, it, vi } from 'vitest';
import {
  applyClaudeSettingsEnvCore,
  type ClaudeSettingsEnvHost,
} from './settings-env-core';

function host(overrides: Partial<ClaudeSettingsEnvHost> = {}): ClaudeSettingsEnvHost {
  return {
    resolveSettingsPath: vi.fn(() => '/config/settings.json'),
    settingsFileExists: vi.fn(() => true),
    readSettingsText: vi.fn(() => JSON.stringify({ env: {} })),
    assignEnv: vi.fn(),
    observeState: vi.fn(),
    ...overrides,
  };
}

describe('Claude settings environment Core', () => {
  it('applies only allowlisted string values in source order and bounds diagnostics', () => {
    const injected = host({
      readSettingsText: vi.fn(() => JSON.stringify({ env: {
        RAW_FIRST: 'secret',
        ANTHROPIC_ALLOWED: 'first',
        PATH: '/private/bin',
        http_proxy: 'second',
        CLAUDE_NON_STRING: 42,
      } })),
    });

    applyClaudeSettingsEnvCore(injected);

    expect(injected.assignEnv).toHaveBeenNthCalledWith(1, 'ANTHROPIC_ALLOWED', 'first');
    expect(injected.assignEnv).toHaveBeenNthCalledWith(2, 'http_proxy', 'second');
    expect(injected.assignEnv).toHaveBeenCalledTimes(2);
    expect(injected.observeState).toHaveBeenCalledWith('rejected-keys', 2, 2);
  });

  it('keeps existence outside the read/assignment failure boundary', () => {
    const failure = new Error('exists failure');
    const injected = host({
      settingsFileExists: vi.fn(() => { throw failure; }),
    });

    expect(() => applyClaudeSettingsEnvCore(injected)).toThrow(failure);
    expect(injected.readSettingsText).not.toHaveBeenCalled();
    expect(injected.observeState).not.toHaveBeenCalled();
  });
});
