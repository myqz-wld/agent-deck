import { describe, expect, it, vi } from 'vitest';
import {
  resolveSessionCreationDefaultsCore,
  type SessionCreationDefaultsHost,
} from './session-creation-defaults-core';

function host(): SessionCreationDefaultsHost & {
  resolveCodexGatewayProfile: ReturnType<typeof vi.fn>;
  claudeGatewaySettingsPath: ReturnType<typeof vi.fn>;
} {
  return {
    userHome: () => '/core-home',
    anthropicModel: () => 'environment-model',
    codexConfigPath: () => '/core-home/.codex/config.toml',
    resolveCodexGatewayProfile: vi.fn((provider: string) => ({
      id: provider,
      configOverrides: {
        model: 'gateway/model',
        model_provider: 'internal-provider',
        model_reasoning_effort: 'xhigh',
      },
      defaultModel: 'gateway/model',
      defaultThinking: 'xhigh' as const,
    })),
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
  it('uses the selected Codex Gateway as the complete defaults source', async () => {
    const ports = host();

    const result = await resolveSessionCreationDefaultsCore('codex-cli', {
      cwd: '/workspace',
      provider: 'xaminim',
    }, {
      settings,
      readCodexConfig: async () => ({
        model_provider: 'ignored-config-provider',
        model: 'ignored/config-model',
      }),
      readConfigFile: async () => '',
    }, ports);

    expect(result).toMatchObject({
      provider: 'xaminim',
      model: 'gateway/model',
      thinking: 'xhigh',
    });
    expect(ports.resolveCodexGatewayProfile).toHaveBeenCalledWith('xaminim');
  });

  it('does not expose config.toml model_provider as a Gateway when none is selected', async () => {
    const ports = host();
    const result = await resolveSessionCreationDefaultsCore('codex-cli', {
      cwd: '/workspace',
    }, {
      settings,
      readCodexConfig: async () => ({
        model_provider: 'native-provider',
        model: 'native/model',
      }),
      readConfigFile: async () => '',
    }, ports);

    expect(result).toMatchObject({ provider: '', model: 'native/model' });
    expect(ports.resolveCodexGatewayProfile).not.toHaveBeenCalled();
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
