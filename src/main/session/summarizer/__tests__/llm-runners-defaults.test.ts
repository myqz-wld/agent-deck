import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';

const harness = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
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

import { summariseViaLlm } from '../llm-runners';

const events = [
  {
    sessionId: 'summary-defaults',
    ts: 1,
    kind: 'message',
    payload: { role: 'assistant', text: '正在处理测试任务' },
  },
] as unknown as AgentEvent[];

describe('periodic summary blank-model defaults', () => {
  beforeEach(() => {
    harness.values.summaryModel = '';
    harness.values.summaryReasoning = 'invalid';
    harness.values.summaryTimeoutMs = 10_000;
    harness.runClaudeOneshot.mockClear();
  });

  it.each([
    ['Claude', 'claude-haiku-from-env'],
    ['Deepseek', 'deepseek-haiku-from-env'],
  ] as const)('uses the %s provider-specific env default with low effort', async (agentName, model) => {
    await summariseViaLlm('/repo', events, {
      agentName,
      envOverride: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL:
          agentName === 'Deepseek' ? 'deepseek-haiku-from-env' : 'claude-haiku-from-env',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'must-not-be-used',
      },
    });

    expect(harness.runClaudeOneshot).toHaveBeenCalledWith(
      expect.objectContaining({ model, effort: 'low' }),
    );
  });

  it('falls back to the Haiku alias for a blank Deepseek model', async () => {
    await summariseViaLlm('/repo', events, {
      agentName: 'Deepseek',
      envOverride: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'must-not-be-used',
      },
    });

    expect(harness.runClaudeOneshot).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'haiku', effort: 'low' }),
    );
  });
});
