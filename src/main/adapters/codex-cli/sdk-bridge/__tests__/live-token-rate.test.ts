import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadEvent } from '@openai/codex-sdk';
import type { InternalSession } from '../types';

vi.mock('@main/event-bus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get: vi.fn(() => ({ model: 'codex-default' })) },
}));

import { eventBus } from '@main/event-bus';
import { handleCodexEventForLiveRate } from '../live-token-rate';

const emitMock = vi.mocked(eventBus.emit);

function makeInternalSession(over: Partial<InternalSession> = {}): InternalSession {
  return {
    applicationSid: 'sid-1',
    threadId: 'sid-1',
    cwd: '/tmp',
    thread: {} as unknown as InternalSession['thread'],
    pendingMessages: [],
    currentTurn: null,
    currentTurnId: null,
    turnLoopRunning: false,
    intentionallyClosed: false,
    ...over,
  };
}

describe('codex live-token-rate', () => {
  beforeEach(() => {
    emitMock.mockClear();
  });

  it('item.updated 累积全文按差值估算并节流 emit token-rate-tick', () => {
    const internal = makeInternalSession();

    handleCodexEventForLiveRate({ type: 'turn.started' } as ThreadEvent, internal, 'sid-1', 1000);
    handleCodexEventForLiveRate(
      {
        type: 'item.updated',
        item: { id: 'a-1', type: 'agent_message', text: 'abcd' },
      } as ThreadEvent,
      internal,
      'sid-1',
      1100,
    );
    expect(emitMock).not.toHaveBeenCalled();

    handleCodexEventForLiveRate(
      {
        type: 'item.updated',
        item: { id: 'a-1', type: 'agent_message', text: 'abcdefgh' },
      } as ThreadEvent,
      internal,
      'sid-1',
      1300,
    );

    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0][0]).toBe('token-rate-tick');
    const payload = emitMock.mock.calls[0][1] as { sessionId: string; bucketKey: string; ts: number; tps: number };
    expect(payload).toMatchObject({
      sessionId: 'sid-1',
      bucketKey: 'codex-default',
      ts: 1300,
    });
    expect(payload.tps).toBeCloseTo(2 / 0.3, 6);
  });

  it('当前 Codex SDK 只有 item.completed 时也能发文本估算 tick，并由 turn.completed usage 校准', () => {
    const internal = makeInternalSession();

    handleCodexEventForLiveRate({ type: 'turn.started' } as ThreadEvent, internal, 'sid-1', 1000);
    handleCodexEventForLiveRate(
      {
        type: 'item.completed',
        item: { id: 'a-1', type: 'agent_message', text: 'abcdefgh' },
      } as ThreadEvent,
      internal,
      'sid-1',
      1300,
    );
    handleCodexEventForLiveRate(
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 30,
          reasoning_output_tokens: 15,
        },
      } as ThreadEvent,
      internal,
      'sid-1',
      1600,
    );

    expect(emitMock).toHaveBeenCalledTimes(2);
    const textTick = emitMock.mock.calls[0][1] as { tps: number };
    const usageTick = emitMock.mock.calls[1][1] as { sessionId: string; bucketKey: string; ts: number; tps: number };
    expect(textTick.tps).toBeCloseTo(2 / 0.3, 6);
    expect(usageTick).toMatchObject({
      sessionId: 'sid-1',
      bucketKey: 'codex-default',
      ts: 1600,
    });
    expect(usageTick.tps).toBeCloseTo(45 / 0.6, 6);
    expect(usageTick).not.toHaveProperty('done');
    expect(internal.codexLiveTokenEstimate).toBeUndefined();
  });

  it('turn.completed 无文本增量时用 usage / turn 耗时发完成态 tick', () => {
    const internal = makeInternalSession();

    handleCodexEventForLiveRate({ type: 'turn.started' } as ThreadEvent, internal, 'sid-1', 1000);
    handleCodexEventForLiveRate(
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 5,
        },
      } as ThreadEvent,
      internal,
      'sid-1',
      2000,
    );

    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('token-rate-tick', {
      sessionId: 'sid-1',
      bucketKey: 'codex-default',
      tps: 15,
      ts: 2000,
    });
  });

  it('turn.failed 发 done tick 清 renderer live 展示态', () => {
    const internal = makeInternalSession();
    handleCodexEventForLiveRate({ type: 'turn.started' } as ThreadEvent, internal, 'sid-1', 1000);

    handleCodexEventForLiveRate(
      { type: 'turn.failed', error: { message: 'boom' } } as ThreadEvent,
      internal,
      'sid-1',
      1500,
    );

    expect(emitMock).toHaveBeenCalledWith('token-rate-tick', {
      sessionId: 'sid-1',
      bucketKey: 'codex-default',
      tps: 0,
      ts: 1500,
      done: true,
    });
  });
});
