import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderUsageSnapshot } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import {
  readClaudeBridgeUsageSnapshotCore,
  type ClaudeLiveUsageSession,
} from './usage-snapshot-core';

function usageResponse(percent: number): SDKControlGetUsageResponse {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: 'pro',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: percent, resets_at: null },
      seven_day: { utilization: percent + 1, resets_at: null },
    },
    behaviors: null,
  };
}

describe('Claude usage snapshot Core', () => {
  it('uses the newest non-closing live query and the host clock', async () => {
    const oldUsage = vi.fn(async () => usageResponse(10));
    const liveUsage = vi.fn(async () => usageResponse(30));
    const sessions = new Map<string, ClaudeLiveUsageSession>([
      ['old', { query: { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: oldUsage } as never }],
      ['closing', {
        expectedClose: true,
        query: { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: oldUsage } as never,
      }],
      ['live', { query: { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: liveUsage } as never }],
    ]);
    const background = vi.fn();

    const snapshot = await readClaudeBridgeUsageSnapshotCore(
      sessions,
      { now: () => 123 },
      background,
    );

    expect(liveUsage).toHaveBeenCalledOnce();
    expect(oldUsage).not.toHaveBeenCalled();
    expect(background).not.toHaveBeenCalled();
    expect(snapshot.updatedAt).toBe(123);
    expect(snapshot.windows.map((window) => window.usedPercent)).toEqual([30, 31]);
  });

  it('falls back without a live query and redacts a live-query failure', async () => {
    const fallback: ProviderUsageSnapshot = {
      provider: 'claude-code', label: 'Claude Code', status: 'ok', windows: [], updatedAt: 1,
    };
    const background = vi.fn(async () => fallback);
    await expect(readClaudeBridgeUsageSnapshotCore(
      new Map(), { now: () => 2 }, background,
    )).resolves.toBe(fallback);

    const rawError = new Error('Bearer private-token /Users/private/repo');
    const snapshot = await readClaudeBridgeUsageSnapshotCore(
      new Map([['live', {
        query: {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => {
            throw rawError;
          }),
        } as never,
      }]]),
      { now: () => 456 },
      background,
    );
    expect(snapshot).toMatchObject({
      status: 'error', updatedAt: 456, message: '额度信息读取失败，请稍后重试',
    });
    expect(JSON.stringify(snapshot)).not.toContain('private-token');
  });
});
