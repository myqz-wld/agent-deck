import { describe, expect, it } from 'vitest';
import {
  TOKEN_USAGE_ALL_METRICS,
  type AgentEventKind,
} from '@shared/types';
import type { CodexAppServerNotification } from './protocol';
import {
  createCodexAppServerTranslateState,
  translateCodexAppServerNotification,
} from './translate';

function collect() {
  const events: { kind: AgentEventKind; payload: unknown }[] = [];
  return {
    emit: (kind: AgentEventKind, payload: unknown) => events.push({ kind, payload }),
    events,
  };
}

const exactUsage = {
  totalTokens: 28,
  inputTokens: 11,
  outputTokens: 17,
  reasoningOutputTokens: 5,
  cachedInputTokens: 7,
  cacheWriteInputTokens: 3,
};

describe('Codex raw response usage translation', () => {
  it('emits exact cache-write usage with a response-scoped idempotency key', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();

    translateCodexAppServerNotification(rawUsage('resp_123', exactUsage), emit, {
      model: 'gpt-5.6-sol',
      state,
    });

    expect(events).toEqual([{
      kind: 'token-usage',
      payload: {
        messageId: 'codex-response-usage-v1:resp_123',
        model: 'gpt-5.6-sol',
        totalTokens: 28,
        inputTokens: 11,
        outputTokens: 17,
        reasoningTokens: 5,
        cacheReadTokens: 7,
        cacheCreationTokens: 3,
        metricScope: TOKEN_USAGE_ALL_METRICS,
      },
    }]);
  });

  it('keeps aggregate context and watermark updates without double-counting exact usage', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();

    translateCodexAppServerNotification(rawUsage('resp_123', exactUsage), emit, {
      model: 'gpt-5.6-sol',
      state,
    });
    translateCodexAppServerNotification(aggregateUsage(exactUsage, exactUsage), emit, {
      model: 'gpt-5.6-sol',
      state,
      usageMessageNamespace: 'thread-1',
    });

    expect(events.filter((event) => event.kind === 'token-usage')).toHaveLength(1);
    expect(events).toContainEqual({
      kind: 'context-usage',
      payload: { usedTokens: 28, windowTokens: 272_000 },
    });
    expect(state.tokenUsageWatermark).toEqual(exactUsage);
  });

  it('uses aggregate usage as the fallback when no raw completion is available', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();

    translateCodexAppServerNotification(aggregateUsage(exactUsage, exactUsage), emit, {
      model: 'gpt-5.6-sol',
      state,
      usageMessageNamespace: 'resumed-thread',
    });

    expect(events).toContainEqual({
      kind: 'token-usage',
      payload: expect.objectContaining({
        messageId: 'codex-usage-v2:resumed-thread:28-11-17-5-7-3',
        cacheCreationTokens: 3,
      }),
    });
  });

  it('keeps the aggregate fallback when it does not match the pending exact usage', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();

    translateCodexAppServerNotification(rawUsage('resp_mismatch', exactUsage), emit, {
      state,
    });
    translateCodexAppServerNotification(aggregateUsage({
      ...exactUsage,
      cacheWriteInputTokens: 4,
    }, {
      ...exactUsage,
      cacheWriteInputTokens: 4,
    }), emit, {
      state,
      usageMessageNamespace: 'thread-1',
    });

    const usageEvents = events.filter((event) => event.kind === 'token-usage');
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[1]?.payload).toEqual(expect.objectContaining({
      messageId: 'codex-usage-v2:thread-1:28-11-17-5-7-4',
      cacheCreationTokens: 4,
    }));
  });

  it('deduplicates replayed raw response ids without suppressing a later fallback twice', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      translateCodexAppServerNotification(rawUsage('resp_replayed', exactUsage), emit, {
        model: 'gpt-5.6-sol',
        state,
      });
    }
    translateCodexAppServerNotification(aggregateUsage(exactUsage, exactUsage), emit, {
      state,
      usageMessageNamespace: 'thread-1',
    });

    const next = {
      totalTokens: 12,
      inputTokens: 5,
      outputTokens: 7,
      reasoningOutputTokens: 3,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 1,
    };
    const cumulative = Object.fromEntries(
      Object.entries(exactUsage).map(([key, value]) => [key, value + next[key as keyof typeof next]]),
    );
    translateCodexAppServerNotification(aggregateUsage(cumulative, next), emit, {
      state,
      usageMessageNamespace: 'thread-1',
    });

    const usageEvents = events.filter((event) => event.kind === 'token-usage');
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[1]?.payload).toEqual(expect.objectContaining({
      totalTokens: 12,
      cacheCreationTokens: 1,
    }));
  });

  it('rejects incomplete raw usage and leaves aggregate fallback enabled', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();

    translateCodexAppServerNotification(rawUsage('resp_partial', {
      ...exactUsage,
      cacheWriteInputTokens: undefined,
    }), emit, { state });
    translateCodexAppServerNotification(aggregateUsage(exactUsage, exactUsage), emit, {
      state,
      usageMessageNamespace: 'thread-1',
    });

    expect(events.filter((event) => event.kind === 'token-usage')).toHaveLength(1);
    expect(events).toContainEqual({
      kind: 'token-usage',
      payload: expect.objectContaining({
        messageId: 'codex-usage-v2:thread-1:28-11-17-5-7-3',
        cacheCreationTokens: 3,
      }),
    });
  });
});

function rawUsage(responseId: string, usage: Record<string, unknown>): CodexAppServerNotification {
  return {
    method: 'rawResponse/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      responseId,
      usage,
    },
  };
}

function aggregateUsage(
  total: Record<string, unknown>,
  last: Record<string, unknown>,
): CodexAppServerNotification {
  return {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: { total, last, modelContextWindow: 272_000 },
    },
  };
}
