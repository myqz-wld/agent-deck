import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';

const mocks = vi.hoisted(() => {
  const env = {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'test-token',
    ANTHROPIC_MODEL: 'deepseek-v4-pro[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
  };
  return {
    env,
    loadDeepseekClaudeEnv: vi.fn(() => env),
    summariseViaLlm: vi.fn(async () => 'summary from deepseek'),
    summariseSessionForHandOff: vi.fn(async () => 'handoff from deepseek'),
  };
});

vi.mock('@main/adapters/deepseek-claude-code/config', () => ({
  getDeepseekDefaultModel: vi.fn(() => 'deepseek-v4-pro[1m]'),
  getDeepseekSettingsPath: vi.fn(() => '/tmp/deepseek-settings.json'),
  loadDeepseekClaudeEnv: mocks.loadDeepseekClaudeEnv,
}));

vi.mock('@main/session/summarizer/llm-runners', () => ({
  summariseViaLlm: mocks.summariseViaLlm,
  summariseSessionForHandOff: mocks.summariseSessionForHandOff,
}));

import { deepseekClaudeCodeAdapter } from '@main/adapters/deepseek-claude-code';

const events = [
  {
    sessionId: 's1',
    ts: 1,
    kind: 'message',
    payload: { role: 'assistant', text: 'working' },
  } as unknown as AgentEvent,
];

describe('deepseekClaudeCodeAdapter.summariseEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes periodic summaries through the Claude-family runner with Deepseek env overlay', async () => {
    const out = await deepseekClaudeCodeAdapter.summariseEvents('/tmp/work', events, 'summary');

    expect(out).toBe('summary from deepseek');
    expect(mocks.loadDeepseekClaudeEnv).toHaveBeenCalledTimes(1);
    expect(mocks.summariseViaLlm).toHaveBeenCalledWith('/tmp/work', events, {
      agentName: 'Deepseek',
      envOverride: mocks.env,
    });
    expect(mocks.summariseSessionForHandOff).not.toHaveBeenCalled();
  });

  it('routes hand-off briefs through the Claude-family runner with Deepseek env overlay', async () => {
    const out = await deepseekClaudeCodeAdapter.summariseEvents('/tmp/work', events, 'handoff');

    expect(out).toBe('handoff from deepseek');
    expect(mocks.loadDeepseekClaudeEnv).toHaveBeenCalledTimes(1);
    expect(mocks.summariseSessionForHandOff).toHaveBeenCalledWith('/tmp/work', events, 'Deepseek', {
      envOverride: mocks.env,
    });
    expect(mocks.summariseViaLlm).not.toHaveBeenCalled();
  });
});
