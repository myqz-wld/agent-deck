import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredAgentEvent } from '@shared/types';
import type { GrokSummaryRunnerHost } from './summarizer-runner-core';

const runGrokOneshot = vi.hoisted(() => vi.fn(async () => ({
  text: 'Core summary',
  inputTokens: 1,
  outputTokens: 1,
  contextWindowTokens: 1_048_576,
  stopReason: 'EndTurn',
})));

vi.mock('@main/session/oneshot-llm/grok-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/session/oneshot-llm/grok-runner')>()),
  runGrokOneshot,
}));

import { summariseGrokSessionWithHost } from './summarizer-runner-core';

const events: StoredAgentEvent[] = [{
  id: 1,
  sessionId: 'session-a',
  agentId: 'grok-build',
  kind: 'message',
  payload: { role: 'assistant', text: 'completed the task' },
  ts: 1,
  source: 'sdk',
}];

function host(): GrokSummaryRunnerHost {
  return {
    readBinaryPath: vi.fn(() => '/bin/grok'),
    readSummaryModel: vi.fn(() => ' fable '),
    readSummaryReasoning: vi.fn(() => 'high'),
    readSummaryTimeoutMs: vi.fn(() => 12_000),
  };
}

describe('Grok summary runner Core', () => {
  beforeEach(() => runGrokOneshot.mockClear());

  it('does not discover host settings for an empty summary', async () => {
    const dependencies = host();

    await expect(summariseGrokSessionWithHost(
      dependencies,
      '/repo',
      [],
    )).resolves.toBeNull();

    expect(runGrokOneshot).not.toHaveBeenCalled();
    for (const read of Object.values(dependencies)) expect(read).not.toHaveBeenCalled();
  });

  it('keeps runtime model/reasoning ahead of desktop defaults', async () => {
    const dependencies = host();

    await expect(summariseGrokSessionWithHost(
      dependencies,
      '/repo',
      events,
      undefined,
      { provider: 'custom', model: ' runtime-model ', thinking: 'xhigh' },
    )).resolves.toBe('Core summary');

    expect(dependencies.readSummaryModel).not.toHaveBeenCalled();
    expect(dependencies.readSummaryReasoning).not.toHaveBeenCalled();
    expect(runGrokOneshot).toHaveBeenCalledWith(expect.objectContaining({
      binaryPath: '/bin/grok',
      effort: 'xhigh',
      maxOutputBytes: 8_000,
      model: 'runtime-model',
      timeoutMs: 12_000,
    }));
  });
});
