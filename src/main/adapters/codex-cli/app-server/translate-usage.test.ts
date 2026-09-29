import { describe, expect, it } from 'vitest';
import type { CodexAppServerNotification } from './client';

import { TOKEN_USAGE_ALL_METRICS, TOKEN_USAGE_METRIC } from '@shared/types';
import { createCodexAppServerTranslateState, translateCodexAppServerNotification } from './translate';

function collect() {
  const events: { kind: string; payload: unknown }[] = [];
  return {
    emit: (kind: string, payload: unknown) => events.push({ kind, payload }),
    events,
  };
}

describe('translateCodexAppServerNotification', () => {
  it('emits token usage from app-server tokenUsage.last deltas', () => {
    const { emit, events } = collect();

    translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            last: {
              totalTokens: 28,
              inputTokens: 11,
              outputTokens: 17,
              reasoningOutputTokens: 5,
              cachedInputTokens: 7,
              cacheWriteInputTokens: 3,
            },
          },
        },
      } as CodexAppServerNotification,
      emit,
      { model: 'gpt-5.5-codex' },
    );

    expect(events).toEqual([
      {
        kind: 'context-usage',
        payload: { usedTokens: 28 },
      },
      {
        kind: 'token-usage',
        payload: {
          messageId: null,
          model: 'gpt-5.5-codex',
          totalTokens: 28,
          inputTokens: 11,
          outputTokens: 17,
          reasoningTokens: 5,
          cacheReadTokens: 7,
          cacheCreationTokens: 3,
          metricScope: TOKEN_USAGE_ALL_METRICS,
        },
      },
    ]);
  });

  it('scopes partial token deltas to reported metrics and keeps provider total strict', () => {
    const { emit, events } = collect();

    translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            last: {
              inputTokens: 11,
              cachedInputTokens: 7,
            },
          },
        },
      } as CodexAppServerNotification,
      emit,
      { model: 'gpt-5.6-sol' },
    );

    expect(events).toEqual([
      {
        kind: 'token-usage',
        payload: {
          messageId: null,
          model: 'gpt-5.6-sol',
          totalTokens: null,
          inputTokens: 11,
          outputTokens: null,
          reasoningTokens: null,
          cacheReadTokens: 7,
          cacheCreationTokens: null,
          metricScope:
            TOKEN_USAGE_METRIC.total |
            TOKEN_USAGE_METRIC.input |
            TOKEN_USAGE_METRIC.cacheRead,
        },
      },
    ]);
  });

  it('uses cumulative total as a watermark and suppresses repeated last snapshots', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();
    const first = {
      totalTokens: 28,
      inputTokens: 11,
      outputTokens: 17,
      reasoningOutputTokens: 5,
      cachedInputTokens: 7,
      cacheWriteInputTokens: 3,
    };
    const secondTotal = {
      totalTokens: 40,
      inputTokens: 16,
      outputTokens: 24,
      reasoningOutputTokens: 8,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 4,
    };
    const secondLast = {
      totalTokens: 12,
      inputTokens: 5,
      outputTokens: 7,
      reasoningOutputTokens: 3,
      cachedInputTokens: 3,
      cacheWriteInputTokens: 1,
    };
    for (const tokenUsage of [
      { total: first, last: first },
      { total: secondTotal, last: secondLast },
      // Provider replay: positive `last`, but cumulative `total` did not advance.
      { total: secondTotal, last: secondLast },
    ]) {
      translateCodexAppServerNotification(
        { method: 'thread/tokenUsage/updated', params: { tokenUsage } } as CodexAppServerNotification,
        emit,
        { model: 'gpt-5.6-sol', state, usageMessageNamespace: 'thread-1' },
      );
    }

    const usageEvents = events.filter((event) => event.kind === 'token-usage');
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        messageId: 'codex-usage-v2:thread-1:28-11-17-5-7-3',
        totalTokens: 28,
        inputTokens: 11,
        outputTokens: 17,
      }),
      expect.objectContaining({
        messageId: 'codex-usage-v2:thread-1:40-16-24-8-10-4',
        totalTokens: 12,
        inputTokens: 5,
        outputTokens: 7,
      }),
    ]);
  });

  it('keeps a context-only compaction snapshot out of durable token totals', () => {
    const { emit, events } = collect();
    const state = createCodexAppServerTranslateState();
    const total = {
      totalTokens: 40,
      inputTokens: 16,
      outputTokens: 24,
      reasoningOutputTokens: 8,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 4,
    };
    translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: { tokenUsage: { total, last: total } },
      } as CodexAppServerNotification,
      emit,
      { state },
    );
    events.length = 0;
    translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            total,
            last: {
              totalTokens: 250_000,
              inputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
            },
            modelContextWindow: 272_000,
          },
        },
      } as CodexAppServerNotification,
      emit,
      { state },
    );

    expect(events).toEqual([
      {
        kind: 'context-usage',
        payload: { usedTokens: 250_000, windowTokens: 272_000 },
      },
    ]);
  });

  it('uses last on the first resumed observation and gives its cumulative snapshot a stable id', () => {
    const notification = {
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          total: {
            totalTokens: 1_000,
            inputTokens: 900,
            outputTokens: 100,
            reasoningOutputTokens: 40,
            cachedInputTokens: 700,
            cacheWriteInputTokens: 0,
          },
          last: {
            totalTokens: 30,
            inputTokens: 20,
            outputTokens: 10,
            reasoningOutputTokens: 4,
            cachedInputTokens: 15,
            cacheWriteInputTokens: 0,
          },
        },
      },
    } as CodexAppServerNotification;
    const payloads = [createCodexAppServerTranslateState(), createCodexAppServerTranslateState()]
      .map((state) => {
        const collected = collect();
        translateCodexAppServerNotification(notification, collected.emit, {
          state,
          usageMessageNamespace: 'resumed-thread',
        });
        return collected.events.find((event) => event.kind === 'token-usage')?.payload;
      });

    expect(payloads).toEqual([
      expect.objectContaining({
        messageId: 'codex-usage-v2:resumed-thread:1000-900-100-40-700-0',
        totalTokens: 30,
        inputTokens: 20,
        outputTokens: 10,
      }),
      expect.objectContaining({
        messageId: 'codex-usage-v2:resumed-thread:1000-900-100-40-700-0',
        totalTokens: 30,
        inputTokens: 20,
        outputTokens: 10,
      }),
    ]);
  });

  it('ignores empty app-server token deltas', () => {
    const { emit, events } = collect();

    translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: { tokenUsage: { last: {} } },
      } as CodexAppServerNotification,
      emit,
      { model: 'gpt-5.6-sol' },
    );

    expect(events).toEqual([]);
  });

  it('reports the current Codex context window separately from cumulative usage', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            last: { totalTokens: 34_567 },
            modelContextWindow: 272_000,
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events[0]).toEqual({
      kind: 'context-usage',
      payload: { usedTokens: 34_567, windowTokens: 272_000 },
    });
  });

  it('pairs native context capacity with the exact effective provider and model', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            last: { totalTokens: 34_567 },
            modelContextWindow: 272_000,
          },
        },
      } as CodexAppServerNotification,
      emit,
      {
        runtimeIdentity: {
          runtimeProvider: 'openrouter',
          model: 'gpt-5.6-sol',
        },
      },
    );

    expect(events[0]).toEqual({
      kind: 'context-usage',
      payload: {
        usedTokens: 34_567,
        windowTokens: 272_000,
        runtimeIdentity: {
          runtimeProvider: 'openrouter',
          model: 'gpt-5.6-sol',
        },
        capacitySource: 'runtime-usage',
      },
    });
  });
});
