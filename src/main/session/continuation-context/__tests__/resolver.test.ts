import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
}));
const settingsGet = vi.hoisted(() =>
  vi.fn((key: string) => state.settings[key]),
);
const resolveGateway = vi.hoisted(() =>
  vi.fn((provider: string | null | undefined) =>
    provider === 'deepseek'
      ? {
          id: 'deepseek',
          settingsPath: '/home/test/.claude/gateways/deepseek.json',
          modelAliases: { sonnet: 'deepseek-sonnet-test' },
          defaultModel: 'deepseek-default',
        }
      : null,
  ),
);

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: settingsGet },
}));
vi.mock('@main/adapters/claude-code/gateway-profiles', () => ({
  resolveClaudeGatewayProfile: resolveGateway,
}));

import { resolveContinuationGeneratorSnapshot } from '../resolver';

beforeEach(() => {
  state.settings = {
    continuationCheckpointAdapter: 'claude-code',
    continuationCheckpointRuntimeProvider: '',
    continuationCheckpointModel: '',
    continuationCheckpointThinking: 'high',
  };
  settingsGet.mockClear();
  resolveGateway.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('continuation generator defaults', () => {
  it('uses Claude Sonnet for a blank model and ignores the generic Anthropic model', () => {
    vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', '');
    vi.stubEnv('ANTHROPIC_MODEL', 'hidden-generic-model');
    state.settings.continuationCheckpointThinking = 'invalid';

    expect(resolveContinuationGeneratorSnapshot()).toMatchObject({
      adapter: 'claude-code',
      model: 'sonnet',
      thinking: 'medium',
    });
  });

  it('honors the Claude Sonnet alias override and trims an explicit model', () => {
    vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', ' claude-sonnet-env ');
    expect(resolveContinuationGeneratorSnapshot().model).toBe('claude-sonnet-env');

    state.settings.continuationCheckpointModel = ' claude-sonnet-explicit ';
    expect(resolveContinuationGeneratorSnapshot().model).toBe('claude-sonnet-explicit');
  });

  it('leaves a blank Codex model unset despite a legacy hand-off environment override', () => {
    vi.stubEnv('CODEX_HANDOFF_MODEL', 'hidden-codex-model');
    state.settings = {
      continuationCheckpointAdapter: 'codex-cli',
      continuationCheckpointRuntimeProvider: 'openai',
      continuationCheckpointModel: '   ',
      continuationCheckpointThinking: '',
    };

    expect(resolveContinuationGeneratorSnapshot()).toMatchObject({
      adapter: 'codex-cli',
      model: null,
      thinking: 'medium',
    });
  });

  it('uses the selected Claude Gateway Sonnet alias and a provider-valid effort', () => {
    state.settings = {
      continuationCheckpointAdapter: 'claude-code',
      continuationCheckpointRuntimeProvider: 'deepseek',
      continuationCheckpointModel: '',
      continuationCheckpointThinking: 'medium',
    };

    expect(resolveContinuationGeneratorSnapshot()).toMatchObject({
      adapter: 'claude-code',
      provider: 'deepseek',
      model: 'deepseek-sonnet-test',
      thinking: 'medium',
    });
    expect(resolveGateway).toHaveBeenCalledWith('deepseek');
  });

  it('maps Grok to its adapter while leaving a blank model to config.toml', () => {
    state.settings = {
      continuationCheckpointAdapter: 'grok-build',
      continuationCheckpointRuntimeProvider: '',
      continuationCheckpointModel: '   ',
      continuationCheckpointThinking: 'xhigh',
    };

    expect(resolveContinuationGeneratorSnapshot()).toMatchObject({
      adapter: 'grok-build',
      model: null,
      thinking: 'xhigh',
    });
  });
});
