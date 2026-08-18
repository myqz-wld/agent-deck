import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERIODIC_SUMMARY_TIMEOUT_MS } from '@shared/types';

const state = vi.hoisted(() => ({
  settings: {
    summaryModel: ' fable ',
    summaryThinking: 'xhigh',
    grokCliPath: '/bin/grok',
  } as Record<string, unknown>,
}));
const runGrokOneshot = vi.hoisted(() =>
  vi.fn(async () => ({
    text: 'Grok summary',
    inputTokens: 10,
    outputTokens: 3,
    contextWindowTokens: 1_048_576,
    stopReason: 'EndTurn',
  })),
);

vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    get: vi.fn((key: string) => state.settings[key]),
  },
}));
vi.mock('@main/session/oneshot-llm/grok-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/session/oneshot-llm/grok-runner')>()),
  runGrokOneshot,
}));

import { summariseGrokSessionViaOneshot } from '../summarizer-runner';

beforeEach(() => {
  runGrokOneshot.mockClear();
});

describe('Grok periodic summary runner', () => {
  it('uses the configured custom model and Grok effort in an isolated oneshot', async () => {
    const result = await summariseGrokSessionViaOneshot('/repo', [
      {
        id: 1,
        sessionId: 'grok-session',
        agentId: 'grok-build',
        kind: 'message',
        payload: { role: 'assistant', text: 'implemented provider support' },
        ts: 1,
        source: 'sdk',
      },
    ]);

    expect(result).toBe('Grok summary');
    expect(runGrokOneshot).toHaveBeenCalledWith(expect.objectContaining({
      model: 'fable',
      effort: 'xhigh',
      binaryPath: '/bin/grok',
      timeoutMs: PERIODIC_SUMMARY_TIMEOUT_MS,
      timeoutErrorMessage: '__grok_summarizer_timeout__',
    }));
  });
});
