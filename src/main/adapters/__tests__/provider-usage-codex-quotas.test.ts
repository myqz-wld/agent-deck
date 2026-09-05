import { describe, expect, it } from 'vitest';
import { parseUsageProviderResult } from '@contracts/usage';
import { buildCodexUsageSnapshot } from '../provider-usage';

const current = (usedPercent: number) => ({
  usedPercent, windowDurationMins: 300, resetsAt: 1_788_588_000,
});
const weekly = (usedPercent: number) => ({
  usedPercent, windowDurationMins: 10_080, resetsAt: 1_789_020_000,
});

describe('Codex model-specific quota projection', () => {
  it('retains the default and Astra windows through the real Remote result parser', () => {
    const snapshot = buildCodexUsageSnapshot({
      rateLimits: { limitId: 'codex', primary: current(99) },
      rateLimitsByLimitId: {
        'gpt-6-astra': {
          limitId: 'gpt-6-astra', limitName: 'GPT-6 Astra',
          primary: current(75), secondary: weekly(40),
        },
        codex: { limitId: 'codex', primary: current(12), secondary: weekly(24) },
      },
    }, 100);
    const parsed = parseUsageProviderResult({ snapshots: [snapshot], revision: 1 });
    expect(parsed.snapshots[0]).toEqual(snapshot);
    expect(snapshot.status).toBe('ok');
    expect(snapshot.windows).toMatchObject([
      { id: 'current', label: '当前窗口', usedPercent: 12 },
      { id: 'weekly', label: '周用量', usedPercent: 24 },
      { id: 'current', quotaId: 'gpt-6-astra', label: 'GPT-6 Astra · 当前窗口', usedPercent: 75 },
      { id: 'weekly', quotaId: 'gpt-6-astra', label: 'GPT-6 Astra · 周用量', usedPercent: 40 },
    ]);
    expect(snapshot.windows[0]).not.toHaveProperty('quotaId');
    expect(snapshot.windows[2].resetsAt).toBe(new Date(1_788_588_000_000).toISOString());
  });

  it('shows Astra-only responses instead of treating an empty default bucket as unavailable', () => {
    const snapshot = buildCodexUsageSnapshot({
      rateLimits: {},
      rateLimitsByLimitId: {
        empty: { limitId: 'codex' },
        'gpt-6-astra': { primary: current(0), secondary: weekly(1) },
      },
    });
    expect(snapshot.status).toBe('ok');
    expect(snapshot.windows).toHaveLength(2);
    expect(snapshot.windows[0]).toMatchObject({
      quotaId: 'gpt-6-astra', label: 'gpt-6-astra · 当前窗口', usedPercent: 0,
    });
  });

  it('keeps the legacy default when the map contains only additional quotas', () => {
    const snapshot = buildCodexUsageSnapshot({
      rateLimits: { primary: current(15), secondary: weekly(30) },
      rateLimitsByLimitId: { astra: { limitId: 'gpt-6-astra', primary: current(70) } },
    });
    expect(snapshot.windows).toHaveLength(4);
    expect(snapshot.windows[0]).toMatchObject({ usedPercent: 15 });
    expect(snapshot.windows[2]).toMatchObject({ quotaId: 'gpt-6-astra', usedPercent: 70 });
  });

  it('deduplicates the default response and indexed aliases by provider quota identity', () => {
    const snapshot = buildCodexUsageSnapshot({
      rateLimits: { limitId: 'gpt-6-astra', primary: current(90) },
      rateLimitsByLimitId: {
        astra: { limitId: 'gpt-6-astra', primary: current(50) },
        alias: { limitId: 'gpt-6-astra', primary: current(20) },
      },
    });
    expect(snapshot.windows).toHaveLength(2);
    expect(snapshot.windows[0]).toMatchObject({ quotaId: 'gpt-6-astra', usedPercent: 20 });
  });

  it('keeps distinct quota ids with identical display names and arbitrary model names', () => {
    const snapshot = buildCodexUsageSnapshot({
      rateLimits: {},
      rateLimitsByLimitId: {
        'future-a': { limitName: 'Preview', primary: current(10) },
        'future-b': { limitName: 'Preview', primary: current(20) },
        absent: undefined,
      },
    });
    expect(parseUsageProviderResult({ snapshots: [snapshot], revision: 1 }).snapshots[0].windows)
      .toHaveLength(4);
    expect(snapshot.windows.filter((window) => window.id === 'current').map((window) => window.quotaId))
      .toEqual(['future-a', 'future-b']);
  });

  it('keeps unavailable semantics when no quota contains usable metrics', () => {
    const snapshot = buildCodexUsageSnapshot({
      rateLimits: {},
      rateLimitsByLimitId: { astra: { primary: { usedPercent: NaN } } },
    });
    expect(snapshot).toMatchObject({ status: 'unavailable', windows: [] });
  });
});
