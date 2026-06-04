import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/event-bus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get: vi.fn(() => ({ model: 'claude-opus-4-8' })) },
}));

import { eventBus } from '@main/event-bus';
import {
  clearLiveTokenEstimate,
  estimateTokensFromText,
  handleStreamEventForLiveRate,
} from '../live-token-rate';
import { makeInternalSession } from '../types';

const emitMock = vi.mocked(eventBus.emit);

function streamEvent(event: unknown): { type: 'stream_event'; event: unknown } {
  return { type: 'stream_event', event };
}

describe('live-token-rate', () => {
  beforeEach(() => {
    emitMock.mockClear();
  });

  it('estimateTokensFromText 按 CJK / 非空白 ASCII 粗估 token', () => {
    expect(estimateTokensFromText('abcd')).toBe(1);
    expect(estimateTokensFromText('你好吗')).toBeCloseTo(3 / 1.7, 6);
    expect(estimateTokensFromText('ab 你好')).toBeCloseTo(2 / 4 + 2 / 1.7, 6);
  });

  it('content_block_delta 节流后 emit token-rate-tick', () => {
    const internal = makeInternalSession({ cwd: '/tmp', applicationSid: 'sid-1' });

    handleStreamEventForLiveRate(internal, 'sid-1', streamEvent({ type: 'message_start' }), 1000);
    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcdefgh' } }),
      1100,
    );
    expect(emitMock).not.toHaveBeenCalled();

    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcdefgh' } }),
      1300,
    );

    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0][0]).toBe('token-rate-tick');
    const payload = emitMock.mock.calls[0][1] as { sessionId: string; bucketKey: string; ts: number; tps: number };
    expect(payload).toMatchObject({
      sessionId: 'sid-1',
      bucketKey: 'opus-4.8',
      ts: 1300,
    });
    expect(payload.tps).toBeCloseTo(4 / 0.3, 6);
  });

  it('clearLiveTokenEstimate 发 done tick 清 renderer live 展示态', () => {
    const internal = makeInternalSession({ cwd: '/tmp', applicationSid: 'sid-1' });
    handleStreamEventForLiveRate(internal, 'sid-1', streamEvent({ type: 'message_start' }), 1000);

    clearLiveTokenEstimate(internal, 'sid-1', 1500);

    expect(emitMock).toHaveBeenCalledWith('token-rate-tick', {
      sessionId: 'sid-1',
      bucketKey: 'opus-4.8',
      tps: 0,
      ts: 1500,
      done: true,
    });
  });
});
