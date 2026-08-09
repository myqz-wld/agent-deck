import { describe, expect, it, vi } from 'vitest';
import {
  resolveSessionCreationDefaultsCore,
  type SessionCreationDefaultsHost,
} from './session-creation-defaults-core';

function host(): SessionCreationDefaultsHost & {
  resolveCodexModelProvider: ReturnType<typeof vi.fn>;
  claudeGatewaySettingsPath: ReturnType<typeof vi.fn>;
} {
  return {
    userHome: () => '/core-home',
    anthropicModel: () => 'environment-model',
    codexConfigPath: () => '/core-home/.codex/config.toml',
    resolveCodexModelProvider: vi.fn((provider: string) => ({ id: provider })),
    claudeGatewaySettingsPath: vi.fn(
      (provider: string, gatewaysDir: string) => `${gatewaysDir}/${provider}.json`,
    ),
  };
}

const settings = {
  claudeCodeSandbox: 'workspace-write' as const,
  codexSandbox: 'workspace-write' as const,
  grokSandbox: 'workspace' as const,
};

describe('Session creation defaults Core host boundary', () => {
  it('resolves Codex provider identity only through the injected config host', async () => {
    const ports = host();

    const result = await resolveSessionCreationDefaultsCore('codex-cli', {
      cwd: '/workspace',
    }, {
      settings,
      readCodexConfig: async () => ({
        model_provider: 'team-provider',
        model: 'provider/model',
      }),
      readConfigFile: async () => '',
    }, ports);

    expect(result).toMatchObject({
      provider: 'team-provider',
      model: 'provider/model',
    });
    expect(ports.resolveCodexModelProvider).toHaveBeenCalledWith(
      'team-provider',
      '/core-home/.codex/config.toml',
    );
  });

  it('uses injected home, Gateway path, and environment model without desktop globals', async () => {
    const ports = host();

    const result = await resolveSessionCreationDefaultsCore('claude-code', {
      cwd: '/workspace',
      provider: 'deepseek',
    }, {
      settings,
      readCodexConfig: async () => ({}),
      readConfigFile: async () => '{}',
    }, ports);

    expect(result).toMatchObject({
      provider: 'deepseek',
      model: 'environment-model',
    });
    expect(ports.claudeGatewaySettingsPath).toHaveBeenCalledWith(
      'deepseek',
      '/core-home/.claude/gateways',
    );
  });
});
