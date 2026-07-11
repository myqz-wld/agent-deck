import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { makeBareSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';

vi.mock('@main/adapters/claude-code/sdk-loader', () => makeBareSdkLoaderMock());
vi.mock('@main/adapters/claude-code/sdk-runtime', () => ({
  getSdkRuntimeOptions: () => ({ executable: 'node', env: {} }),
  getPathToClaudeCodeExecutable: () => '/fake/cli',
}));

import { summariseViaLlm } from '@main/session/summarizer/llm-runners';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';

const loadSdkMock = vi.mocked(loadSdk);
const calls: Array<{ options: { effort?: string } }> = [];
const events = [{
  sessionId: 's1',
  ts: 1,
  kind: 'message',
  payload: { role: 'assistant', text: '正在处理测试任务' },
}] as unknown as AgentEvent[];

function installSdk(): void {
  loadSdkMock.mockResolvedValue({
    query: vi.fn((args: { options: { effort?: string } }) => {
      calls.push(args);
      const iterable = (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '正在处理测试任务' }] },
        };
        yield { type: 'result' };
      })();
      return {
        [Symbol.asyncIterator]: () => iterable,
        interrupt: vi.fn(async () => undefined),
      };
    }),
  } as unknown as Awaited<ReturnType<typeof loadSdk>>);
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  installSdk();
});

afterEach(() => vi.restoreAllMocks());

describe('summariseViaLlm periodic reasoning effort', () => {
  it('passes a valid Claude-family summary effort', async () => {
    const { settingsStore } = await import('@main/store/settings-store');
    const previous = settingsStore.get('summaryReasoning');
    settingsStore.set('summaryReasoning', 'high');
    try {
      await summariseViaLlm('/tmp/cwd', events, {
        agentName: 'Deepseek',
        envOverride: { ANTHROPIC_MODEL: 'deepseek-v4-pro' },
      });
      expect(calls[0].options.effort).toBe('high');
    } finally {
      settingsStore.set('summaryReasoning', previous);
    }
  });

  it('coerces a retained Codex-only summary effort for Claude', async () => {
    const { settingsStore } = await import('@main/store/settings-store');
    const previous = settingsStore.get('summaryReasoning');
    settingsStore.set('summaryReasoning', 'ultra');
    try {
      await summariseViaLlm('/tmp/cwd', events);
      expect(calls[0].options.effort).toBe('max');
    } finally {
      settingsStore.set('summaryReasoning', previous);
    }
  });
});
