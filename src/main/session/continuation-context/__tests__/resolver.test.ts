import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
}));
const settingsGet = vi.hoisted(() =>
  vi.fn((key: string) => state.settings[key]),
);
const deepseekModel = vi.hoisted(() => vi.fn(() => 'deepseek-sonnet-test'));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: settingsGet },
}));
vi.mock('@main/adapters/deepseek-claude-code/config', () => ({
  getDeepseekModelForClaudeAlias: deepseekModel,
}));

import { resolveContinuationGeneratorSnapshot } from '../resolver';

beforeEach(() => {
  state.settings = {
    continuationCheckpointProvider: 'claude',
    continuationCheckpointModel: '',
    continuationCheckpointThinking: 'high',
  };
  settingsGet.mockClear();
  deepseekModel.mockClear();
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
      continuationCheckpointProvider: 'codex',
      continuationCheckpointModel: '   ',
      continuationCheckpointThinking: '',
    };

    expect(resolveContinuationGeneratorSnapshot()).toMatchObject({
      adapter: 'codex-cli',
      model: null,
      thinking: 'medium',
    });
  });

  it('keeps the Deepseek Sonnet default and a provider-valid explicit effort', () => {
    state.settings = {
      continuationCheckpointProvider: 'deepseek',
      continuationCheckpointModel: '',
      continuationCheckpointThinking: 'medium',
    };

    expect(resolveContinuationGeneratorSnapshot()).toMatchObject({
      adapter: 'deepseek-claude-code',
      model: 'deepseek-sonnet-test',
      thinking: 'medium',
    });
    expect(deepseekModel).toHaveBeenCalledWith('sonnet');
  });
});
