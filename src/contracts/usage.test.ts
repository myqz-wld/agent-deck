import { describe, expect, it } from 'vitest';

import {
  parseUsageProviderResult,
  parseUsageTokenParams,
  parseUsageTokenResult,
  USAGE_DAILY_MAX_ITEMS,
  USAGE_PROVIDER_MAX_WINDOWS,
} from './usage';

const daily = {
  bucketKey: 'gpt-5.6-sol',
  day: '2026-08-10',
  providerTotalTokens: 12,
  providerTotalApplicable: true,
  inputTotalTokens: 7,
  inputTotalApplicable: true,
  outputTokens: 5,
  outputApplicable: true,
  reasoningTokens: 2,
  reasoningApplicable: true,
  cacheReadTokens: null,
  cacheReadApplicable: false,
  cacheCreationTokens: null,
  cacheCreationApplicable: false,
} as const;

describe('Remote usage contracts', () => {
  it('accepts exact token ledgers with applicability metadata', () => {
    expect(parseUsageTokenParams({ includeDaily: true, dailyLimit: 100 }))
      .toEqual({ includeDaily: true, dailyLimit: 100 });
    expect(parseUsageTokenResult({
      rates: [{ bucketKey: 'gpt-5.6-sol', outputTokens: 5 }],
      topToday: [{ bucketKey: 'gpt-5.6-sol', outputTokens: 10 }],
      daily: [daily],
      dailyTruncated: false,
      today: '2026-08-10',
      revision: 3,
    }, 100)).toMatchObject({ daily: [{ day: '2026-08-10' }], revision: 3 });
  });

  it('rejects unbounded, malformed, or inexact token rows', () => {
    expect(() => parseUsageTokenParams({ includeDaily: true, dailyLimit: 0 })).toThrow();
    expect(() => parseUsageTokenParams({
      includeDaily: true, dailyLimit: USAGE_DAILY_MAX_ITEMS + 1,
    })).toThrow();
    expect(() => parseUsageTokenResult({
      rates: [], topToday: [], daily: [{ ...daily, day: '08/10/2026' }],
      dailyTruncated: false, today: '2026-08-10', revision: 3,
    }, 100)).toThrow();
    expect(() => parseUsageTokenResult({
      rates: [], topToday: [], daily: [], dailyTruncated: false,
      today: '2026-02-30', revision: 3,
    }, 100)).toThrow();
    expect(() => parseUsageTokenResult({
      rates: [{ bucketKey: 'gpt-5.6-sol', outputTokens: -1 }], topToday: [], daily: [],
      dailyTruncated: false, today: '2026-08-10', revision: 3,
    }, 100)).toThrow();
  });

  it('accepts three exact provider snapshots and rejects duplicate providers', () => {
    const snapshot = {
      provider: 'codex-cli',
      label: 'Codex',
      status: 'ok',
      windows: [{
        id: 'current', label: '5 小时', usedPercent: 24, resetsAt: '2026-08-10T12:00:00Z',
      }],
      updatedAt: 10,
    } as const;
    expect(parseUsageProviderResult({ snapshots: [snapshot], revision: 4 }))
      .toEqual({ snapshots: [snapshot], revision: 4 });
    expect(() => parseUsageProviderResult({ snapshots: [snapshot, snapshot], revision: 4 }))
      .toThrow();
    expect(() => parseUsageProviderResult({
      snapshots: [{ ...snapshot, windows: [snapshot.windows[0], snapshot.windows[0]] }],
      revision: 4,
    })).toThrow();
    expect(() => parseUsageProviderResult({
      snapshots: [{ ...snapshot, secret: 'credential' }], revision: 4,
    })).toThrow();
  });

  it('rejects duplicate rate buckets and daily bucket/day identities', () => {
    const rate = { bucketKey: 'gpt-5.6-sol', outputTokens: 5 } as const;
    expect(() => parseUsageTokenResult({
      rates: [rate, rate], topToday: [], daily: [], dailyTruncated: false,
      today: '2026-08-10', revision: 3,
    }, 100)).toThrow();
    expect(() => parseUsageTokenResult({
      rates: [], topToday: [rate, rate], daily: [], dailyTruncated: false,
      today: '2026-08-10', revision: 3,
    }, 100)).toThrow();
    expect(() => parseUsageTokenResult({
      rates: [], topToday: [], daily: [daily, daily], dailyTruncated: false,
      today: '2026-08-10', revision: 3,
    }, 100)).toThrow();
  });

  it('bounds quota windows and enforces identity within each quota', () => {
    const base = { id: 'current', label: '当前窗口', usedPercent: 10, resetsAt: null };
    const windows = Array.from({ length: USAGE_PROVIDER_MAX_WINDOWS }, (_, index) => ({
      ...base, quotaId: `quota-${index}`,
    }));
    const result = (values: unknown[]) => ({
      snapshots: [{ provider: 'codex-cli', label: 'Codex', status: 'ok', updatedAt: 1, windows: values }],
      revision: 1,
    });
    expect(parseUsageProviderResult(result(windows)).snapshots[0].windows).toHaveLength(windows.length);
    expect(() => parseUsageProviderResult(result([...windows, { ...base, quotaId: 'overflow' }]))).toThrow();
    expect(() => parseUsageProviderResult(result([windows[0], windows[0]]))).toThrow();
    for (const quotaId of [null, '', 'x'.repeat(513), 'bad\0quota']) {
      expect(() => parseUsageProviderResult(result([{ ...base, quotaId }]))).toThrow();
    }
  });

  it('rejects a token ledger that would exceed one transport frame', () => {
    const oversizedDaily = Array.from({ length: USAGE_DAILY_MAX_ITEMS }, () => ({
      ...daily,
      bucketKey: 'x'.repeat(512),
    }));
    expect(() => parseUsageTokenResult({
      rates: [],
      topToday: [],
      daily: oversizedDaily,
      dailyTruncated: false,
      today: '2026-08-10',
      revision: 3,
    }, USAGE_DAILY_MAX_ITEMS)).toThrow();
  });
});
