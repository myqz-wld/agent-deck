import { describe, expect, it, vi } from 'vitest';
import {
  beginGrokLiveTokenRateCore,
  clearGrokLiveTokenRateCore,
  completeGrokLiveTokenRateCore,
  handleGrokTextForLiveRateCore,
  type GrokLiveRateObserver,
} from './live-token-rate-core';

describe('Grok live token-rate Core', () => {
  it('emits live and authoritative completion rates through its observer', () => {
    const observer: GrokLiveRateObserver = { emitTokenRateTick: vi.fn() };
    const owner = { liveRate: null };
    beginGrokLiveTokenRateCore(owner, 'session', 'grok-4.5', 1_000);
    handleGrokTextForLiveRateCore(owner, 'first', 1_000, observer);
    handleGrokTextForLiveRateCore(owner, 'a'.repeat(120), 2_000, observer);
    expect(completeGrokLiveTokenRateCore(owner, 80, 2_100, 4_000, observer)).toBe(true);

    expect(observer.emitTokenRateTick).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session', bucketKey: 'grok-4.5' }),
    );
    expect(observer.emitTokenRateTick).toHaveBeenLastCalledWith(
      expect.objectContaining({ tps: 20 }),
    );
  });

  it('publishes an idempotent display clear only while state exists', () => {
    const observer: GrokLiveRateObserver = { emitTokenRateTick: vi.fn() };
    const owner = { liveRate: null };
    beginGrokLiveTokenRateCore(owner, 'session', null, 1_000);
    clearGrokLiveTokenRateCore(owner, 1_500, observer);
    clearGrokLiveTokenRateCore(owner, 2_000, observer);
    expect(observer.emitTokenRateTick).toHaveBeenCalledOnce();
    expect(observer.emitTokenRateTick).toHaveBeenCalledWith(
      expect.objectContaining({ done: true, tps: 0 }),
    );
  });
});
