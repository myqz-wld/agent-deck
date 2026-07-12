import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings } from '@shared/types';
import { makeBareSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';

const settings = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: vi.fn((key: string) => values[key]),
    set: vi.fn((key: string, value: unknown) => {
      values[key] = value;
    }),
  };
});

vi.mock('@main/adapters/claude-code/sdk-loader', () => makeBareSdkLoaderMock());
vi.mock('@main/adapters/claude-code/sdk-runtime', () => ({
  getSdkRuntimeOptions: () => ({ executable: 'node', env: {} }),
  getPathToClaudeCodeExecutable: () => '/fake/cli',
}));
vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: settings.get, set: settings.set },
}));

import { summariseViaLlm } from '@main/session/summarizer/llm-runners';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';

const loadSdkMock = vi.mocked(loadSdk);
const calls: Array<{
  options: {
    effort?: string;
    model?: string;
    cwd?: string;
    permissionMode?: string;
    tools?: unknown[];
    mcpServers?: Record<string, unknown>;
    maxTurns?: number;
  };
}> = [];
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
  settings.values.summaryModel = '';
  settings.values.summaryReasoning = 'medium';
  settings.values.summaryTimeoutMs = 0;
  vi.clearAllMocks();
  installSdk();
});

afterEach(() => vi.restoreAllMocks());

describe('summariseViaLlm periodic reasoning effort', () => {
  it('uses the Haiku alias for a blank Claude model and ignores ANTHROPIC_MODEL', async () => {
    const { settingsStore } = await import('@main/store/settings-store');
    const previous = settingsStore.get('summaryModel');
    settingsStore.set('summaryModel', '');
    try {
      await summariseViaLlm('/tmp/cwd', events, {
        envOverride: {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
          ANTHROPIC_MODEL: 'hidden-generic-model',
        },
      });
      expect(calls[0].options.model).toBe('haiku');
    } finally {
      settingsStore.set('summaryModel', previous);
    }
  });

  it('uses the configured Haiku alias override for a blank Claude model', async () => {
    const { settingsStore } = await import('@main/store/settings-store');
    const previous = settingsStore.get('summaryModel');
    settingsStore.set('summaryModel', '');
    try {
      await summariseViaLlm('/tmp/cwd', events, {
        envOverride: {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-env',
          ANTHROPIC_MODEL: 'hidden-generic-model',
        },
      });
      expect(calls[0].options.model).toBe('claude-haiku-env');
    } finally {
      settingsStore.set('summaryModel', previous);
    }
  });

  it.each(['', 'invalid'])('falls back from summary effort %j to medium', async (value) => {
    const { settingsStore } = await import('@main/store/settings-store');
    const previous = settingsStore.get('summaryReasoning');
    settingsStore.set('summaryReasoning', value as AppSettings['summaryReasoning']);
    try {
      await summariseViaLlm('/tmp/cwd', events);
      expect(calls[0].options.effort).toBe('medium');
    } finally {
      settingsStore.set('summaryReasoning', previous);
    }
  });

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

  it('runs evidence-bearing summaries in an empty no-tool runtime', async () => {
    await summariseViaLlm('/sensitive/project', events, {
      evidenceContext: '{"recentUserInputs":["untrusted instruction"]}',
    });
    expect(calls[0].options).toMatchObject({
      permissionMode: 'dontAsk',
      tools: [],
      mcpServers: {},
      maxTurns: 1,
    });
    expect(calls[0].options.cwd).toMatch(/agent-deck-periodic-summary-/);
    expect(calls[0].options.cwd).not.toBe('/sensitive/project');
  });
});
