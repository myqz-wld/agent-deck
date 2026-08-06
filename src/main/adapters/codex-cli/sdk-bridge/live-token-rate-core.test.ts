import { describe, expect, it, vi } from 'vitest';
import {
  clearCodexLiveTokenEstimateCore,
  handleCodexNotificationForLiveRateCore,
  observeCodexNotificationUsageCore,
  type CodexLiveRateHost,
} from './live-token-rate-core';

function usage(outputTokens: number) {
  return {
    method: 'thread/tokenUsage/updated',
    params: { tokenUsage: { last: { outputTokens } } },
  };
}

describe('Codex live token-rate Core', () => {
  it('rates authoritative usage deltas and preserves native-thread fingerprints', () => {
    const host: CodexLiveRateHost = {
      resolveModel: () => 'codex-default',
      emitTokenRateTick: vi.fn(),
    };
    const owner = { applicationSid: 'app', threadId: 'native' };
    handleCodexNotificationForLiveRateCore(
      { method: 'turn/started' }, owner, 'app', 1_000, host,
    );
    handleCodexNotificationForLiveRateCore(usage(30), owner, 'app', 1_300, host);

    expect(host.emitTokenRateTick).toHaveBeenCalledWith({
      sessionId: 'app', bucketKey: 'codex-default', tps: 100, ts: 1_300,
    });
    const observation = observeCodexNotificationUsageCore({
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          total: { totalTokens: 20, outputTokens: 20 },
          last: { totalTokens: 20, outputTokens: 20 },
        },
      },
    }, owner);
    expect(observation?.messageId).toBe('codex-usage-v2:native:20-x-20-x-x-x');
  });

  it('clears display state through the observer without leaking host failures', () => {
    const emitTokenRateTick = vi.fn();
    const host: CodexLiveRateHost = {
      resolveModel: () => 'codex-default',
      emitTokenRateTick,
    };
    const owner = { applicationSid: 'app', threadId: null };
    clearCodexLiveTokenEstimateCore(owner, 'app', 2_000, host);
    expect(emitTokenRateTick).toHaveBeenCalledWith(
      expect.objectContaining({ done: true, tps: 0 }),
    );

    expect(() => clearCodexLiveTokenEstimateCore(owner, 'app', 2_100, {
      resolveModel: () => { throw new Error('host failed'); },
      emitTokenRateTick: () => { throw new Error('host failed'); },
    })).not.toThrow();
  });
});
