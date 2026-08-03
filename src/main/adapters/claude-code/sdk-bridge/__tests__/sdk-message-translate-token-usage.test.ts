import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get: vi.fn(), setPermissionMode: vi.fn() },
}));
vi.mock('@main/event-bus', () => ({ eventBus: { emit: vi.fn() } }));

import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import {
  TOKEN_USAGE_ALL_METRICS,
  TOKEN_USAGE_METRIC,
  type AgentEvent,
} from '@shared/types';
import { translateSdkMessage } from '../sdk-message-translate';
import { makeInternalSession } from '../types';

const sessionGetMock = vi.mocked(sessionRepo.get);
const eventBusEmitMock = vi.mocked(eventBus.emit);

function setup() {
  const events: AgentEvent[] = [];
  const internal = makeInternalSession({ cwd: '/tmp', applicationSid: 'sid-1' });
  return {
    events,
    internal,
    emit: (event: AgentEvent): void => {
      events.push(event);
    },
  };
}

function assistantMsg(options: {
  id?: string;
  model?: string;
  usage?: Record<string, unknown>;
  content?: unknown[];
}) {
  return {
    type: 'assistant',
    message: {
      id: options.id,
      model: options.model,
      usage: options.usage,
      content: options.content ?? [],
    },
  };
}

function resultMsg(options: {
  uuid?: string;
  usage?: Record<string, unknown>;
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      contextWindow?: number;
      canonicalModel?: string;
    }
  >;
}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    uuid: options.uuid ?? 'result-1',
    usage: options.usage,
    modelUsage: options.modelUsage,
  };
}

function tokenEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.kind === 'token-usage');
}

function contextWindowEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter(
    (event) =>
      event.kind === 'context-usage' &&
      typeof (event.payload as { windowTokens?: unknown }).windowTokens === 'number',
  );
}

describe('translateSdkMessage finalized Claude usage', () => {
  beforeEach(() => {
    sessionGetMock.mockReset();
    sessionGetMock.mockReturnValue({ model: 'claude-opus-4-8' } as never);
    eventBusEmitMock.mockClear();
  });

  it('keeps assistant usage provisional and still emits assistant content', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({
        id: 'assistant-1',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
        content: [{ type: 'text', text: 'done' }],
      }),
      internal,
    );

    expect(tokenEvents(events)).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'context-usage',
        payload: { usedTokens: 150 },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'message',
        payload: { text: 'done', role: 'assistant' },
      }),
    );
  });

  it('selects the primary model context window from finalized model usage', () => {
    const { events, emit, internal } = setup();
    internal.runtimeModel = 'claude-opus-4-8';
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        modelUsage: {
          'claude-opus-4-8': {
            outputTokens: 5,
            contextWindow: 200_000,
            canonicalModel: 'claude-opus-4-8-20260801',
          },
          'claude-haiku-4-5': { outputTokens: 2, contextWindow: 128_000 },
        },
      }),
      internal,
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'context-usage',
        payload: {
          windowTokens: 200_000,
          capacitySource: 'runtime-usage',
          runtimeIdentity: {
            runtimeProvider: 'native',
            model: 'claude-opus-4-8',
          },
        },
      }),
    );
  });

  it('does not use pricing canonical metadata to claim another model window', () => {
    const { events, emit, internal } = setup();
    internal.runtimeModel = 'claude-opus-4-8';
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        modelUsage: {
          'provider-secondary': {
            outputTokens: 5,
            contextWindow: 999_999,
            canonicalModel: 'claude-opus-4-8',
          },
        },
      }),
      internal,
    );

    expect(contextWindowEvents(events)).toEqual([]);
  });

  it('does not bucket-match a secondary model or collapse equal ambiguous windows', () => {
    const { events, emit, internal } = setup();
    internal.runtimeModel = 'claude-opus-4-8';
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        modelUsage: {
          'claude-opus-4-7': { outputTokens: 5, contextWindow: 200_000 },
          'claude-haiku-4-5': { outputTokens: 2, contextWindow: 200_000 },
        },
      }),
      internal,
    );

    expect(contextWindowEvents(events)).toEqual([]);
  });

  it('rejects an alias-only primary model without authoritative mapping', () => {
    const { events, emit, internal } = setup();
    internal.runtimeModel = 'sonnet';
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      internal,
    );
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        modelUsage: {
          sonnet: { outputTokens: 5, contextWindow: 200_000 },
        },
      }),
      internal,
    );

    expect(contextWindowEvents(events)).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'context-usage',
        payload: { usedTokens: 15 },
      }),
    );
  });

  it('keeps Gateway runtime identity ahead of SDK pricing canonical metadata', () => {
    const { events, emit, internal } = setup();
    internal.runtimeProvider = 'deepseek';
    internal.gatewayModelAliases = {
      sonnet: 'deepseek-v4-pro[1m]',
    };
    internal.runtimeModel = 'deepseek-v4-pro[1m]';
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        modelUsage: {
          'claude-sonnet-4-5': {
            outputTokens: 5,
            contextWindow: 1_000_000,
            canonicalModel: 'claude-sonnet-4-5-20250929',
          },
          'claude-haiku-4-5': { outputTokens: 2, contextWindow: 128_000 },
        },
      }),
      internal,
    );

    expect(contextWindowEvents(events)).toEqual([
      expect.objectContaining({
        payload: {
          windowTokens: 1_000_000,
          capacitySource: 'runtime-usage',
          runtimeIdentity: {
            runtimeProvider: 'deepseek',
            model: 'deepseek-v4-pro[1m]',
          },
        },
      }),
    ]);
  });

  it('persists one exact aggregate row when modelUsage is absent', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        uuid: 'aggregate',
        usage: {
          input_tokens: 100,
          output_tokens: 70,
          output_tokens_details: { thinking_tokens: 18 },
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 10,
        },
      }),
      internal,
    );

    expect(tokenEvents(events)).toEqual([
      expect.objectContaining({
        payload: {
          messageId: 'result:aggregate:aggregate',
          model: 'claude-opus-4-8',
          inputTokens: 100,
          outputTokens: 70,
          reasoningTokens: 18,
          cacheReadTokens: 30,
          cacheCreationTokens: 10,
          metricScope: TOKEN_USAGE_ALL_METRICS,
        },
      }),
    ]);
  });

  it('preserves omitted aggregate fields as unknown rather than zero', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        uuid: 'partial-aggregate',
        usage: { input_tokens: 9, output_tokens: 4 },
      }),
      internal,
    );

    expect(tokenEvents(events)[0]?.payload).toEqual({
      messageId: 'result:partial-aggregate:aggregate',
      model: 'claude-opus-4-8',
      inputTokens: 9,
      outputTokens: 4,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      metricScope:
        TOKEN_USAGE_METRIC.total |
        TOKEN_USAGE_METRIC.input |
        TOKEN_USAGE_METRIC.output,
    });
  });

  it('uses exact aggregate fields to complete a single modelUsage entry', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        uuid: 'single-model',
        usage: {
          input_tokens: 754,
          output_tokens: 147,
          output_tokens_details: { thinking_tokens: 25 },
          cache_read_input_tokens: 80_242,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {
          'MiniMax-M3': { outputTokens: 147 },
        },
      }),
      internal,
    );

    expect(tokenEvents(events)).toEqual([
      expect.objectContaining({
        payload: {
          messageId: 'result:single-model:model:MiniMax-M3',
          model: 'MiniMax-M3',
          inputTokens: 754,
          outputTokens: 147,
          reasoningTokens: 25,
          cacheReadTokens: 80_242,
          cacheCreationTokens: 0,
          metricScope: TOKEN_USAGE_ALL_METRICS,
        },
      }),
    ]);
  });

  it('keeps multi-model metrics provider-attributed and stores positive aggregate reasoning separately', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        uuid: 'multi-model',
        usage: {
          input_tokens: 30,
          output_tokens: 12,
          output_tokens_details: { thinking_tokens: 7 },
          cache_read_input_tokens: 5,
        },
        modelUsage: {
          'claude-opus-4-8': {
            inputTokens: 20,
            outputTokens: 8,
            cacheReadInputTokens: 5,
          },
          'claude-haiku-4-5': {
            inputTokens: 10,
            outputTokens: 4,
          },
        },
      }),
      internal,
    );

    const usage = tokenEvents(events);
    expect(usage).toHaveLength(3);
    expect(usage[0]?.payload).toMatchObject({
      model: 'claude-opus-4-8',
      inputTokens: 20,
      outputTokens: 8,
      reasoningTokens: null,
      cacheReadTokens: 5,
      cacheCreationTokens: null,
      metricScope:
        TOKEN_USAGE_METRIC.total |
        TOKEN_USAGE_METRIC.input |
        TOKEN_USAGE_METRIC.output |
        TOKEN_USAGE_METRIC.cacheRead,
    });
    expect(usage[1]?.payload).toMatchObject({
      model: 'claude-haiku-4-5',
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      metricScope:
        TOKEN_USAGE_METRIC.total |
        TOKEN_USAGE_METRIC.input |
        TOKEN_USAGE_METRIC.output,
    });
    expect(usage[2]?.payload).toEqual({
      messageId: 'result:multi-model:reasoning:unattributed',
      model: 'claude-unattributed-reasoning',
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: 7,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      metricScope: TOKEN_USAGE_METRIC.reasoning,
    });
  });

  it('can safely attribute an exact aggregate reasoning zero to every model', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        uuid: 'multi-zero',
        usage: { output_tokens_details: { thinking_tokens: 0 } },
        modelUsage: {
          'claude-opus-4-8': { outputTokens: 8 },
          'claude-haiku-4-5': { outputTokens: 4 },
        },
      }),
      internal,
    );

    expect(
      tokenEvents(events).map((event) => (
        event.payload as { reasoningTokens: number | null }
      ).reasoningTokens),
    ).toEqual([0, 0]);
  });

  it('uses stable final ids so result replay is max-upsertable', () => {
    const { events, emit, internal } = setup();
    const result = resultMsg({
      uuid: 'replay',
      modelUsage: {
        'claude-opus-4-8': {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
    translateSdkMessage(emit, 'sid-1', result, internal);
    translateSdkMessage(emit, 'sid-1', result, internal);

    expect(
      tokenEvents(events).map(
        (event) => (event.payload as { messageId: string }).messageId,
      ),
    ).toEqual([
      'result:replay:model:claude-opus-4-8',
      'result:replay:model:claude-opus-4-8',
    ]);
  });

  it('does not persist usage or finished state during an expected close', () => {
    const { events, emit, internal } = setup();
    internal.expectedClose = true;
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      internal,
    );

    expect(tokenEvents(events)).toEqual([]);
    expect(events.some((event) => event.kind === 'finished')).toBe(false);
  });

  it('propagates only the structured prompt-too-long terminal reason', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      {
        ...resultMsg({}),
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'prompt_too_long',
      },
      internal,
    );

    expect(events.find((event) => event.kind === 'finished')?.payload).toEqual({
      ok: false,
      subtype: 'error_during_execution',
      failureReason: 'context-window-exceeded',
    });
  });

  it('calibrates transient tok/s with the exact single model id', () => {
    const { emit, internal } = setup();
    internal.liveTokenEstimate = {
      bucketKey: 'opus',
      estTokensSinceFlush: 0,
      lastFlushTs: Date.now() - 1_000,
      hasFlushAnchor: true,
      decodeElapsedMs: 1_000,
    };

    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        modelUsage: {
          'claude-opus-4-8': { outputTokens: 100 },
        },
      }),
      internal,
    );

    expect(eventBusEmitMock).toHaveBeenCalledWith(
      'token-rate-tick',
      expect.objectContaining({
        sessionId: 'sid-1',
        bucketKey: 'opus-4.8',
        tps: 100,
      }),
    );
  });
});
