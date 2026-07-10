import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get: vi.fn(), setPermissionMode: vi.fn() },
}));
vi.mock('@main/event-bus', () => ({ eventBus: { emit: vi.fn() } }));

import { sessionRepo } from '@main/store/session-repo';
import type { AgentEvent } from '@shared/types';
import { translateSdkMessage } from '../sdk-message-translate';
import { makeInternalSession } from '../types';

const sessionGetMock = vi.mocked(sessionRepo.get);

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

function messageStart(model: string) {
  return {
    type: 'stream_event',
    event: { type: 'message_start', message: { model } },
  };
}

function thinkingTokensMsg(uuid: string, estimated: number, delta: number) {
  return {
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: estimated,
    estimated_tokens_delta: delta,
    uuid,
    session_id: 'sid-1',
  };
}

function assistantUsage(model: string, reasoning: number) {
  return {
    type: 'assistant',
    message: {
      id: `assistant-${model}`,
      model,
      content: [],
      usage: {
        input_tokens: 0,
        output_tokens: 100,
        output_tokens_details: { thinking_tokens: reasoning },
      },
    },
  };
}

function resultMsg(opts: {
  uuid?: string;
  subtype?: 'success' | 'error_during_execution';
  outputTokens?: number;
  reasoningTokens?: number;
  modelUsage?: Record<string, { outputTokens: number }>;
} = {}) {
  const subtype = opts.subtype ?? 'success';
  return {
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    uuid: opts.uuid ?? 'result-1',
    result: subtype === 'success' ? 'done' : undefined,
    errors: subtype === 'success' ? undefined : ['failed'],
    usage: {
      input_tokens: 0,
      output_tokens: opts.outputTokens ?? 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...(opts.reasoningTokens === undefined
        ? {}
        : { output_tokens_details: { thinking_tokens: opts.reasoningTokens } }),
    },
    modelUsage: opts.modelUsage ?? {
      'claude-sonnet-4-6': { outputTokens: opts.outputTokens ?? 100 },
    },
  };
}

function tokenEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.kind === 'token-usage');
}

function reasoningEvents(events: AgentEvent[]): AgentEvent[] {
  return tokenEvents(events).filter(
    (event) => ((event.payload as { reasoningTokens?: number }).reasoningTokens ?? 0) > 0,
  );
}

function reasoningValues(events: AgentEvent[]): number[] {
  return reasoningEvents(events).map(
    (event) => (event.payload as { reasoningTokens: number }).reasoningTokens,
  );
}

describe('translateSdkMessage system/thinking_tokens usage', () => {
  beforeEach(() => {
    sessionGetMock.mockReset();
    sessionGetMock.mockReturnValue({ model: 'claude-opus-4-8' } as never);
  });

  it('buffers incremental deltas and flushes one result-bound correction', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', messageStart('claude-sonnet-4-6'), internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('estimate-1', 40, 10), internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('estimate-2', 75, 35), internal);

    expect(tokenEvents(events)).toHaveLength(0);
    expect(internal.estimatedReasoningByBucket.get('sonnet-4.6')).toBe(45);

    translateSdkMessage(emit, 'sid-1', resultMsg(), internal);

    expect(reasoningValues(events)).toEqual([45]);
    expect(reasoningEvents(events)[0].payload).toMatchObject({
      messageId: 'result:result-1:sonnet-4.6:reasoning',
      model: 'claude-sonnet-4-6',
      outputTokens: 0,
    });
    expect(internal.estimatedReasoningByBucket.size).toBe(0);
  });

  it('deduplicates replayed SDK uuids and sums fractional deltas before truncating', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', messageStart('claude-sonnet-4-6'), internal);
    const replayed = thinkingTokensMsg('estimate-replayed', 0.6, 0.6);
    translateSdkMessage(emit, 'sid-1', replayed, internal);
    translateSdkMessage(emit, 'sid-1', replayed, internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('estimate-next', 1.2, 0.6), internal);
    translateSdkMessage(emit, 'sid-1', resultMsg(), internal);

    expect(reasoningValues(events)).toEqual([1]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'ignores a non-positive or non-finite delta: %s',
    (delta) => {
      const { events, emit, internal } = setup();
      translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('invalid', 10, delta), internal);
      translateSdkMessage(emit, 'sid-1', resultMsg(), internal);
      expect(reasoningEvents(events)).toHaveLength(0);
    },
  );

  it('attributes the estimate to the active stream model instead of the primary runtime model', () => {
    const { events, emit, internal } = setup();
    internal.runtimeModel = 'claude-opus-4-8';
    translateSdkMessage(emit, 'sid-1', messageStart('claude-sonnet-4-6'), internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('estimate-model', 8, 8), internal);
    translateSdkMessage(emit, 'sid-1', resultMsg(), internal);

    expect(reasoningEvents(events)[0].payload).toMatchObject({ model: 'claude-sonnet-4-6' });
  });

  it('adds only the estimate remainder after assistant reasoning was already persisted', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', messageStart('claude-sonnet-4-6'), internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('estimate-45', 45, 45), internal);
    translateSdkMessage(emit, 'sid-1', assistantUsage('claude-sonnet-4-6', 40), internal);
    translateSdkMessage(emit, 'sid-1', resultMsg(), internal);

    expect(reasoningValues(events)).toEqual([40, 5]);
  });

  it('prefers authoritative result details even when modelUsage is non-empty', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', messageStart('claude-sonnet-4-6'), internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('estimate-45', 45, 45), internal);
    translateSdkMessage(emit, 'sid-1', resultMsg({ reasoningTokens: 42 }), internal);

    expect(reasoningValues(events)).toEqual([42]);
  });

  it('does not duplicate matching assistant and result authoritative reasoning', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', assistantUsage('claude-sonnet-4-6', 18), internal);
    translateSdkMessage(emit, 'sid-1', resultMsg({ reasoningTokens: 18 }), internal);

    expect(reasoningValues(events)).toEqual([18]);
  });

  it('keeps independent estimates for multiple stream model buckets', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', messageStart('claude-opus-4-8'), internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('opus-estimate', 10, 10), internal);
    translateSdkMessage(emit, 'sid-1', messageStart('claude-sonnet-4-6'), internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('sonnet-estimate', 20, 20), internal);
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        modelUsage: {
          'claude-opus-4-8': { outputTokens: 50 },
          'claude-sonnet-4-6': { outputTokens: 50 },
        },
      }),
      internal,
    );

    expect(
      reasoningEvents(events).map((event) => ({
        model: (event.payload as { model: string }).model,
        reasoning: (event.payload as { reasoningTokens: number }).reasoningTokens,
      })),
    ).toEqual([
      { model: 'claude-opus-4-8', reasoning: 10 },
      { model: 'claude-sonnet-4-6', reasoning: 20 },
    ]);
  });

  it('allocates an authoritative aggregate once across multiple models', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', messageStart('claude-opus-4-8'), internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('opus-estimate', 10, 10), internal);
    translateSdkMessage(emit, 'sid-1', messageStart('claude-sonnet-4-6'), internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('sonnet-estimate', 20, 20), internal);
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        reasoningTokens: 30,
        modelUsage: {
          'claude-opus-4-8': { outputTokens: 50 },
          'claude-sonnet-4-6': { outputTokens: 50 },
        },
      }),
      internal,
    );

    expect(reasoningValues(events).reduce((sum, value) => sum + value, 0)).toBe(30);
    expect(reasoningValues(events)).toEqual([10, 20]);
  });

  it('allocates authoritative remainder to the model whose estimate is not already persisted', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', messageStart('claude-opus-4-8'), internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('opus-estimate', 10, 10), internal);
    translateSdkMessage(emit, 'sid-1', messageStart('claude-sonnet-4-6'), internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('sonnet-estimate', 40, 40), internal);
    translateSdkMessage(emit, 'sid-1', assistantUsage('claude-sonnet-4-6', 40), internal);
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        reasoningTokens: 50,
        modelUsage: {
          'claude-opus-4-8': { outputTokens: 50 },
          'claude-sonnet-4-6': { outputTokens: 50 },
        },
      }),
      internal,
    );

    expect(
      reasoningEvents(events).map((event) => ({
        model: (event.payload as { model: string }).model,
        reasoning: (event.payload as { reasoningTokens: number }).reasoningTokens,
      })),
    ).toEqual([
      { model: 'claude-sonnet-4-6', reasoning: 40 },
      { model: 'claude-opus-4-8', reasoning: 10 },
    ]);
  });

  it('clamps unmatched multi-model estimates to the aggregate output total', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', messageStart('claude-opus-4-8'), internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('opus-estimate', 40, 40), internal);
    translateSdkMessage(emit, 'sid-1', messageStart('claude-sonnet-4-6'), internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('sonnet-estimate', 40, 40), internal);
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({ outputTokens: 50, modelUsage: {} }),
      internal,
    );

    expect(reasoningValues(events).reduce((sum, value) => sum + value, 0)).toBe(50);
  });

  it('clamps an estimate to the final inclusive output total', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', messageStart('claude-sonnet-4-6'), internal);
    translateSdkMessage(emit, 'sid-1', thinkingTokensMsg('estimate-120', 120, 120), internal);
    translateSdkMessage(emit, 'sid-1', resultMsg({ outputTokens: 100 }), internal);

    expect(reasoningValues(events)).toEqual([100]);
  });

  it('flushes error results but drops and clears estimates on an expected close', () => {
    const errorCase = setup();
    translateSdkMessage(
      errorCase.emit,
      'sid-1',
      thinkingTokensMsg('error-estimate', 12, 12),
      errorCase.internal,
    );
    translateSdkMessage(
      errorCase.emit,
      'sid-1',
      resultMsg({ subtype: 'error_during_execution' }),
      errorCase.internal,
    );
    expect(reasoningValues(errorCase.events)).toEqual([12]);

    const closedCase = setup();
    translateSdkMessage(
      closedCase.emit,
      'sid-1',
      thinkingTokensMsg('closed-estimate', 12, 12),
      closedCase.internal,
    );
    closedCase.internal.expectedClose = true;
    translateSdkMessage(closedCase.emit, 'sid-1', resultMsg(), closedCase.internal);
    expect(reasoningEvents(closedCase.events)).toHaveLength(0);
    expect(closedCase.internal.estimatedReasoningByBucket.size).toBe(0);
    expect(closedCase.internal.seenThinkingTokenMessageIds.size).toBe(0);
  });
});
