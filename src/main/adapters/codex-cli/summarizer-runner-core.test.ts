import { describe, expect, it, vi } from 'vitest';
import type { StoredAgentEvent } from '@shared/types';
import {
  summariseCodexSessionWithHost,
  type CodexSummaryRunnerHost,
} from './summarizer-runner-core';

const events: StoredAgentEvent[] = [{
  id: 1,
  sessionId: 'session-a',
  agentId: 'codex-cli',
  kind: 'message',
  payload: { role: 'assistant', text: 'completed the task' },
  ts: 1,
  source: 'sdk',
}];

function host(): CodexSummaryRunnerHost {
  return {
    readSummaryModel: vi.fn(() => ' configured-model '),
    readSummaryReasoning: vi.fn(() => 'high'),
    readSummaryTimeoutMs: vi.fn(() => 12_000),
    runOneshot: vi.fn(async () => 'Core summary'),
  };
}

describe('Codex summary runner Core', () => {
  it('does not discover host settings or execution for an empty summary', async () => {
    const dependencies = host();

    await expect(summariseCodexSessionWithHost(
      dependencies,
      '/repo',
      [],
      () => '',
    )).resolves.toBeNull();

    for (const dependency of Object.values(dependencies)) {
      expect(dependency).not.toHaveBeenCalled();
    }
  });

  it('keeps runtime identity ahead of desktop defaults', async () => {
    const dependencies = host();

    await expect(summariseCodexSessionWithHost(
      dependencies,
      '/repo',
      events,
      () => 'activity',
      undefined,
      { provider: ' provider-a ', model: ' runtime-model ', thinking: 'max' },
    )).resolves.toBe('Core summary');

    expect(dependencies.readSummaryModel).not.toHaveBeenCalled();
    expect(dependencies.readSummaryReasoning).not.toHaveBeenCalled();
    expect(dependencies.runOneshot).toHaveBeenCalledWith(expect.objectContaining({
      model: 'runtime-model',
      modelReasoningEffort: 'max',
      provider: 'provider-a',
      timeoutErrorMessage: '__codex_summarizer_timeout__',
      timeoutMs: 12_000,
    }));
  });
});
