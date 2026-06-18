import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/event-bus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get: vi.fn(() => ({ model: 'claude-opus-4-8' })) },
}));

import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import {
  clearLiveTokenEstimate,
  completeLiveTokenEstimate,
  estimateTokensFromText,
  handleStreamEventForLiveRate,
} from '../live-token-rate';
import { makeInternalSession } from '../types';

const emitMock = vi.mocked(eventBus.emit);
const sessionGetMock = vi.mocked(sessionRepo.get);

function streamEvent(event: unknown): { type: 'stream_event'; event: unknown } {
  return { type: 'stream_event', event };
}

describe('live-token-rate', () => {
  beforeEach(() => {
    emitMock.mockClear();
    sessionGetMock.mockReset();
    sessionGetMock.mockReturnValue({ model: 'claude-opus-4-8' } as ReturnType<typeof sessionRepo.get>);
  });

  it('estimateTokensFromText 按 CJK / 非空白 ASCII 粗估 token', () => {
    expect(estimateTokensFromText('abcd')).toBe(1);
    expect(estimateTokensFromText('你好吗')).toBeCloseTo(3 / 1.7, 6);
    expect(estimateTokensFromText('ab 你好')).toBeCloseTo(2 / 4 + 2 / 1.7, 6);
  });

  it('content_block_delta 从首个 delta 开始计时并节流 emit token-rate-tick', () => {
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
      1400,
    );

    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0][0]).toBe('token-rate-tick');
    const payload = emitMock.mock.calls[0][1] as { sessionId: string; bucketKey: string; ts: number; tps: number };
    expect(payload).toMatchObject({
      sessionId: 'sid-1',
      bucketKey: 'opus-4.8',
      ts: 1400,
    });
    expect(payload.tps).toBeCloseTo(4 / 0.3, 6);
  });

  it('message_start 的实际模型覆盖 session.model alias', () => {
    sessionGetMock.mockReturnValue({ model: 'opus' } as ReturnType<typeof sessionRepo.get>);
    const internal = makeInternalSession({ cwd: '/tmp', applicationSid: 'sid-1' });

    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'message_start', message: { model: 'claude-opus-4-8' } }),
      1000,
    );
    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcdefgh' } }),
      1100,
    );
    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcdefgh' } }),
      1400,
    );

    expect(emitMock).toHaveBeenCalledWith(
      'token-rate-tick',
      expect.objectContaining({ bucketKey: 'opus-4.8' }),
    );
  });

  it('turn 结束用权威 output_tokens / content delta 窗口发校准 tick', () => {
    const internal = makeInternalSession({ cwd: '/tmp', applicationSid: 'sid-1' });

    handleStreamEventForLiveRate(internal, 'sid-1', streamEvent({ type: 'message_start' }), 1000);
    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcdefgh' } }),
      1200,
    );
    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcdefgh' } }),
      1700,
    );
    emitMock.mockClear();

    const emitted = completeLiveTokenEstimate(internal, 'sid-1', 100, 1800);

    expect(emitted).toBe(true);
    expect(emitMock).toHaveBeenCalledWith('token-rate-tick', {
      sessionId: 'sid-1',
      bucketKey: 'opus-4.8',
      tps: 100 / 0.5,
      ts: 1800,
    });
    expect(internal.liveTokenEstimate).toBeUndefined();
  });

  it('turn 结束用 result.modelUsage 实际模型覆盖 session.model alias', () => {
    sessionGetMock.mockReturnValue({ model: 'opus' } as ReturnType<typeof sessionRepo.get>);
    const internal = makeInternalSession({ cwd: '/tmp', applicationSid: 'sid-1' });

    handleStreamEventForLiveRate(internal, 'sid-1', streamEvent({ type: 'message_start' }), 1000);
    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcdefgh' } }),
      1200,
    );
    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcdefgh' } }),
      1700,
    );
    emitMock.mockClear();

    completeLiveTokenEstimate(internal, 'sid-1', 100, 1800, 'claude-opus-4-8');

    expect(emitMock).toHaveBeenCalledWith(
      'token-rate-tick',
      expect.objectContaining({ bucketKey: 'opus-4.8' }),
    );
  });

  it('多段 assistant 输出累计 decode 窗口但排除工具等待空档', () => {
    const internal = makeInternalSession({ cwd: '/tmp', applicationSid: 'sid-1' });

    handleStreamEventForLiveRate(internal, 'sid-1', streamEvent({ type: 'message_start' }), 1000);
    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcd' } }),
      1100,
    );
    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcd' } }),
      1300,
    );
    handleStreamEventForLiveRate(internal, 'sid-1', streamEvent({ type: 'message_start' }), 5000);
    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'content_block_delta', delta: { type: 'input_json_delta' } }),
      5200,
    );
    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'content_block_delta', delta: { type: 'input_json_delta' } }),
      5700,
    );
    emitMock.mockClear();

    completeLiveTokenEstimate(internal, 'sid-1', 70, 5800);

    expect(emitMock).toHaveBeenCalledWith('token-rate-tick', {
      sessionId: 'sid-1',
      bucketKey: 'opus-4.8',
      tps: 70 / 0.7,
      ts: 5800,
    });
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

  it('session 未持久化 model 时归到 claude-default 而不是 unknown', () => {
    sessionGetMock.mockReturnValue({ model: null } as ReturnType<typeof sessionRepo.get>);
    const internal = makeInternalSession({ cwd: '/tmp', applicationSid: 'sid-1' });

    handleStreamEventForLiveRate(internal, 'sid-1', streamEvent({ type: 'message_start' }), 1000);
    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcdefgh' } }),
      1100,
    );
    handleStreamEventForLiveRate(
      internal,
      'sid-1',
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcdefgh' } }),
      1400,
    );

    expect(emitMock).toHaveBeenCalledWith(
      'token-rate-tick',
      expect.objectContaining({ bucketKey: 'claude-default' }),
    );
  });
});
