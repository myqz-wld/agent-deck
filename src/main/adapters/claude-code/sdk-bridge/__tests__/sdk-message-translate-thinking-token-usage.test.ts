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

function approximateThinking(delta: number) {
  return {
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: delta,
    estimated_tokens_delta: delta,
    uuid: `estimate-${delta}`,
  };
}

function assistantUsage(reasoning: number) {
  return {
    type: 'assistant',
    message: {
      id: 'assistant-1',
      model: 'claude-sonnet-4-6',
      content: [],
      usage: {
        input_tokens: 0,
        output_tokens: 100,
        output_tokens_details: { thinking_tokens: reasoning },
      },
    },
  };
}

function resultMsg(reasoningTokens?: number) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    uuid: 'result-1',
    result: 'done',
    usage: {
      input_tokens: 0,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...(reasoningTokens === undefined
        ? {}
        : { output_tokens_details: { thinking_tokens: reasoningTokens } }),
    },
    modelUsage: {
      'claude-sonnet-4-6': { outputTokens: 100 },
    },
  };
}

function reasoningEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter(
    (event) =>
      event.kind === 'token-usage' &&
      ((event.payload as { reasoningTokens?: number }).reasoningTokens ?? 0) > 0,
  );
}

function reasoningValues(events: AgentEvent[]): number[] {
  return reasoningEvents(events).map(
    (event) => (event.payload as { reasoningTokens: number }).reasoningTokens,
  );
}

describe('translateSdkMessage Claude reasoning usage provenance', () => {
  beforeEach(() => {
    sessionGetMock.mockReset();
    sessionGetMock.mockReturnValue({ model: 'claude-opus-4-8' } as never);
  });

  it('never persists approximate system/thinking_tokens values', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', approximateThinking(45), internal);
    translateSdkMessage(emit, 'sid-1', resultMsg(), internal);

    expect(reasoningEvents(events)).toHaveLength(0);
  });

  it('persists an authoritative result detail when no assistant detail was emitted', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', resultMsg(42), internal);

    expect(reasoningValues(events)).toEqual([42]);
    expect(reasoningEvents(events)[0].payload).toMatchObject({
      messageId: 'result-delta-v2:result-1:model:claude-sonnet-4-6',
      model: 'claude-sonnet-4-6',
    });
  });

  it('does not duplicate matching authoritative assistant and result details', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', assistantUsage(18), internal);
    translateSdkMessage(emit, 'sid-1', resultMsg(18), internal);

    expect(reasoningValues(events)).toEqual([18]);
  });

  it('persists assistant detail plus only the authoritative final remainder', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', assistantUsage(18), internal);
    translateSdkMessage(emit, 'sid-1', approximateThinking(999), internal);
    translateSdkMessage(emit, 'sid-1', resultMsg(25), internal);

    expect(reasoningValues(events)).toEqual([18, 7]);
    expect(reasoningValues(events).reduce((sum, value) => sum + value, 0)).toBe(25);
  });

  it('clears turn accounting without emitting usage during an expected close', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(emit, 'sid-1', assistantUsage(18), internal);
    internal.expectedClose = true;
    translateSdkMessage(emit, 'sid-1', resultMsg(25), internal);

    // The assistant row was already an authoritative completed API call before close began.
    expect(reasoningValues(events)).toEqual([18]);
    expect(internal.turnUsageByBucket.size).toBe(0);
  });
});
