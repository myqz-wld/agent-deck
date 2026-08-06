import { describe, expect, it, vi } from 'vitest';
import {
  completeClaudeLiveTokenEstimateCore,
  handleClaudeStreamEventForLiveRateCore,
  type ClaudeLiveRateHost,
} from './live-token-rate-core';

function streamEvent(event: unknown) {
  return { type: 'stream_event', event };
}

describe('Claude live token-rate Core', () => {
  it('accumulates decode segments while excluding the tool wait between them', () => {
    const host: ClaudeLiveRateHost = {
      resolveModel: () => 'claude-opus-4-8',
      emitTokenRateTick: vi.fn(),
    };
    const owner = { applicationSid: 'app' };
    handleClaudeStreamEventForLiveRateCore(
      owner, 'app', streamEvent({ type: 'message_start' }), 1_000, host,
    );
    handleClaudeStreamEventForLiveRateCore(owner, 'app', streamEvent({
      type: 'content_block_delta', delta: { text: 'abcd' },
    }), 1_100, host);
    handleClaudeStreamEventForLiveRateCore(owner, 'app', streamEvent({
      type: 'content_block_delta', delta: { text: 'abcd' },
    }), 1_300, host);
    handleClaudeStreamEventForLiveRateCore(
      owner, 'app', streamEvent({ type: 'message_start' }), 5_000, host,
    );
    handleClaudeStreamEventForLiveRateCore(owner, 'app', streamEvent({
      type: 'content_block_delta', delta: { type: 'input_json_delta' },
    }), 5_200, host);
    handleClaudeStreamEventForLiveRateCore(owner, 'app', streamEvent({
      type: 'content_block_delta', delta: { type: 'input_json_delta' },
    }), 5_700, host);

    expect(completeClaudeLiveTokenEstimateCore(
      owner, 'app', 70, 5_800, undefined, host,
    )).toBe(true);
    expect(host.emitTokenRateTick).toHaveBeenLastCalledWith(
      expect.objectContaining({ bucketKey: 'opus-4.8', tps: 100 }),
    );
  });

  it('uses an explicit result model without consulting the desktop model host', () => {
    const resolveModel = vi.fn(() => 'opus');
    const host: ClaudeLiveRateHost = { resolveModel, emitTokenRateTick: vi.fn() };
    const owner = {
      applicationSid: 'app',
      liveTokenEstimate: {
        bucketKey: 'claude-default',
        estTokensSinceFlush: 0,
        lastFlushTs: 0,
        hasFlushAnchor: false,
        decodeElapsedMs: 1_000,
      },
    };
    completeClaudeLiveTokenEstimateCore(
      owner, 'app', 100, 2_000, 'claude-opus-4-8', host,
    );
    expect(resolveModel).not.toHaveBeenCalled();
    expect(host.emitTokenRateTick).toHaveBeenCalledWith(
      expect.objectContaining({ bucketKey: 'opus-4.8', tps: 100 }),
    );
  });
});
