import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PERIODIC_SUMMARY_TIMEOUT_MS,
  type StoredAgentEvent,
} from '@shared/types';

const harness = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  profiles: {} as Record<string, {
    id: string;
    settingsPath: string;
    modelAliases: {
      fable?: string;
      opus?: string;
      sonnet?: string;
      haiku?: string;
    };
  }>,
  runClaudeOneshot: vi.fn(async () => 'periodic summary'),
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    get: vi.fn((key: string) => harness.values[key]),
  },
}));
vi.mock('@main/session/oneshot-llm', () => ({
  buildSummarizePrompt: vi.fn(() => 'prompt'),
  buildSummarizeSystemPrompt: vi.fn(() => 'system'),
  cleanCompactResult: vi.fn((value: string | null) => value),
  runClaudeOneshot: harness.runClaudeOneshot,
}));
vi.mock('@main/adapters/claude-code/gateway-profiles', () => ({
  resolveClaudeGatewayProfile: vi.fn((provider?: string) =>
    provider ? harness.profiles[provider] ?? null : null,
  ),
}));

import { summariseViaLlm } from '../llm-runners';

const events = [
  {
    id: 1,
    sessionId: 'summary-defaults',
    agentId: 'claude-code',
    ts: 1,
    kind: 'message',
    payload: { role: 'assistant', text: '正在处理测试任务' },
  },
] satisfies StoredAgentEvent[];

describe('periodic summary blank-model defaults', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_DEFAULT_HAIKU_MODEL', '');
    harness.values.summaryModel = '';
    harness.values.summaryThinking = 'invalid';
    harness.profiles = {};
    harness.runClaudeOneshot.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the selected Gateway Haiku alias and settings file with low effort', async () => {
    harness.profiles.deepseek = {
      id: 'deepseek',
      settingsPath: '/home/test/.claude/gateways/deepseek.json',
      modelAliases: {
        haiku: 'deepseek-v4-flash',
        sonnet: 'must-not-be-used',
      },
    };
    await summariseViaLlm('/repo', events, {
      runtimeProvider: 'deepseek',
    });

    expect(harness.runClaudeOneshot).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'deepseek-v4-flash',
        effort: 'low',
        settingsPath: '/home/test/.claude/gateways/deepseek.json',
        timeoutMs: PERIODIC_SUMMARY_TIMEOUT_MS,
      }),
    );
  });

  it('falls back to the Haiku alias when a Gateway does not define one', async () => {
    harness.profiles.openrouter = {
      id: 'openrouter',
      settingsPath: '/home/test/.claude/gateways/openrouter.json',
      modelAliases: {},
    };
    await summariseViaLlm('/repo', events, {
      runtimeProvider: 'openrouter',
    });

    expect(harness.runClaudeOneshot).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'haiku',
        effort: 'low',
        settingsPath: '/home/test/.claude/gateways/openrouter.json',
      }),
    );
  });
});
