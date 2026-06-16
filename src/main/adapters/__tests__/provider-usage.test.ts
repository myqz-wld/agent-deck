import { describe, expect, it } from 'vitest';
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';

import {
  buildClaudeUsageSnapshot,
  buildCodexUsageSnapshot,
  unsupportedUsageSnapshot,
} from '../provider-usage';

describe('provider usage snapshots', () => {
  it('maps Claude five-hour and seven-day windows', () => {
    const snapshot = buildClaudeUsageSnapshot(
      {
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
          five_hour: {
            utilization: 12.5,
            resets_at: '2026-06-15T08:30:00.000Z',
          },
          seven_day: {
            utilization: 68,
            resets_at: '2026-06-20T00:00:00.000Z',
          },
        },
        behaviors: null,
      } as SDKControlGetUsageResponse,
      123,
    );

    expect(snapshot).toMatchObject({
      provider: 'claude-code',
      status: 'ok',
      updatedAt: 123,
    });
    expect(snapshot.windows).toEqual([
      {
        id: 'current',
        label: '当前窗口',
        usedPercent: 12.5,
        resetsAt: '2026-06-15T08:30:00.000Z',
      },
      {
        id: 'weekly',
        label: '周用量',
        usedPercent: 68,
        resetsAt: '2026-06-20T00:00:00.000Z',
      },
    ]);
  });

  it('marks Claude not_subscribed when account has no subscription limits', () => {
    const snapshot = buildClaudeUsageSnapshot(
      {
        session: {
          total_cost_usd: 0,
          total_api_duration_ms: 0,
          total_duration_ms: 0,
          total_lines_added: 0,
          total_lines_removed: 0,
          model_usage: {},
        },
        subscription_type: null,
        rate_limits_available: false,
        rate_limits: null,
        behaviors: null,
      } as SDKControlGetUsageResponse,
      456,
    );

    expect(snapshot.status).toBe('not_subscribed');
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.updatedAt).toBe(456);
  });

  it('marks Claude unavailable when subscribed plan returns no rate limits', () => {
    const snapshot = buildClaudeUsageSnapshot(
      {
        session: {
          total_cost_usd: 0,
          total_api_duration_ms: 0,
          total_duration_ms: 0,
          total_lines_added: 0,
          total_lines_removed: 0,
          model_usage: {},
        },
        subscription_type: 'pro',
        rate_limits_available: false,
        rate_limits: null,
        behaviors: null,
      } as SDKControlGetUsageResponse,
      457,
    );

    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.updatedAt).toBe(457);
  });

  it('maps Codex primary and secondary windows and normalizes epoch seconds', () => {
    const snapshot = buildCodexUsageSnapshot(
      {
        rateLimits: {
          limitId: 'codex',
          primary: {
            usedPercent: 24.4,
            windowDurationMins: 300,
            resetsAt: 1781497190,
          },
          secondary: {
            usedPercent: 55,
            windowDurationMins: 10080,
            resetsAt: 1782101990000,
          },
        },
        rateLimitsByLimitId: null,
      },
      789,
    );

    expect(snapshot).toMatchObject({
      provider: 'codex-cli',
      status: 'ok',
      updatedAt: 789,
    });
    expect(snapshot.windows).toEqual([
      {
        id: 'current',
        label: '当前窗口',
        usedPercent: 24.4,
        resetsAt: new Date(1781497190 * 1000).toISOString(),
        windowMinutes: 300,
      },
      {
        id: 'weekly',
        label: '周用量',
        usedPercent: 55,
        resetsAt: new Date(1782101990000).toISOString(),
        windowMinutes: 10080,
      },
    ]);
  });

  it('prefers Codex multi-bucket entry over the legacy single bucket', () => {
    const snapshot = buildCodexUsageSnapshot(
      {
        rateLimits: {
          limitId: 'fallback',
          primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null },
          secondary: null,
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: null },
            secondary: null,
          },
        },
      },
      111,
    );

    expect(snapshot.status).toBe('ok');
    expect(snapshot.windows[0].usedPercent).toBe(42);
  });

  it('builds unsupported placeholders for Deepseek', () => {
    const snapshot = unsupportedUsageSnapshot(
      'deepseek-claude-code',
      'Deepseek',
      'Deepseek 暂不支持读取额度信息',
      222,
    );

    expect(snapshot).toMatchObject({
      provider: 'deepseek-claude-code',
      status: 'unsupported',
      windows: [],
      updatedAt: 222,
    });
  });
});
