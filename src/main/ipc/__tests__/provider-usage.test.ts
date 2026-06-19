import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderUsageSnapshot } from '@shared/types';

const mocks = vi.hoisted(() => ({
  adapterRegistry: {
    get: vi.fn(),
  },
}));

vi.mock('@main/adapters/registry', () => ({ adapterRegistry: mocks.adapterRegistry }));

import {
  PROVIDER_USAGE_CACHE_TTL_MS,
  _resetProviderUsageCacheForTesting,
  prefetchProviderUsageSnapshots,
  providerUsageSnapshotHandler,
} from '../provider-usage';

function snapshot(provider: ProviderUsageSnapshot['provider']): ProviderUsageSnapshot {
  return {
    provider,
    label:
      provider === 'claude-code'
        ? 'Claude'
        : provider === 'codex-cli'
          ? 'Codex'
          : 'Deepseek',
    status: 'ok',
    windows: [],
    updatedAt: Date.now(),
  };
}

function setupAdapters(): Record<ProviderUsageSnapshot['provider'], ReturnType<typeof vi.fn>> {
  const calls = {
    'claude-code': vi.fn().mockResolvedValue(snapshot('claude-code')),
    'codex-cli': vi.fn().mockResolvedValue(snapshot('codex-cli')),
    'deepseek-claude-code': vi.fn().mockResolvedValue(snapshot('deepseek-claude-code')),
  };
  mocks.adapterRegistry.get.mockImplementation((id: ProviderUsageSnapshot['provider']) => ({
    id,
    getUsageSnapshot: calls[id],
  }));
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z'));
  mocks.adapterRegistry.get.mockReset();
  _resetProviderUsageCacheForTesting();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('providerUsageSnapshotHandler cache', () => {
  it('keeps the provider usage cache TTL just below the five-minute refresh cadence', () => {
    expect(PROVIDER_USAGE_CACHE_TTL_MS).toBe(5 * 60_000 - 5_000);
  });

  it('returns cached snapshots within TTL', async () => {
    const calls = setupAdapters();

    const first = await providerUsageSnapshotHandler();
    vi.setSystemTime(Date.now() + PROVIDER_USAGE_CACHE_TTL_MS - 1);
    const second = await providerUsageSnapshotHandler();

    expect(second).toBe(first);
    expect(calls['claude-code']).toHaveBeenCalledTimes(1);
    expect(calls['codex-cli']).toHaveBeenCalledTimes(1);
    expect(calls['deepseek-claude-code']).toHaveBeenCalledTimes(1);
  });

  it('refreshes snapshots after TTL expires', async () => {
    const calls = setupAdapters();

    await providerUsageSnapshotHandler();
    vi.setSystemTime(Date.now() + PROVIDER_USAGE_CACHE_TTL_MS + 1);
    await providerUsageSnapshotHandler();

    expect(calls['claude-code']).toHaveBeenCalledTimes(2);
    expect(calls['codex-cli']).toHaveBeenCalledTimes(2);
    expect(calls['deepseek-claude-code']).toHaveBeenCalledTimes(2);
  });

  it('force refresh bypasses fresh cache', async () => {
    const calls = setupAdapters();

    await providerUsageSnapshotHandler();
    vi.setSystemTime(Date.now() + PROVIDER_USAGE_CACHE_TTL_MS - 1);
    await providerUsageSnapshotHandler({ force: true });

    expect(calls['claude-code']).toHaveBeenCalledTimes(2);
    expect(calls['codex-cli']).toHaveBeenCalledTimes(2);
    expect(calls['deepseek-claude-code']).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent refreshes behind one provider read', async () => {
    let resolveClaude!: (value: ProviderUsageSnapshot) => void;
    const claudePromise = new Promise<ProviderUsageSnapshot>((resolve) => {
      resolveClaude = resolve;
    });
    const calls = {
      'claude-code': vi.fn().mockReturnValue(claudePromise),
      'codex-cli': vi.fn().mockResolvedValue(snapshot('codex-cli')),
      'deepseek-claude-code': vi.fn().mockResolvedValue(snapshot('deepseek-claude-code')),
    };
    mocks.adapterRegistry.get.mockImplementation((id: ProviderUsageSnapshot['provider']) => ({
      id,
      getUsageSnapshot: calls[id],
    }));

    const first = providerUsageSnapshotHandler();
    const second = providerUsageSnapshotHandler();
    resolveClaude(snapshot('claude-code'));
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b);
    expect(calls['claude-code']).toHaveBeenCalledTimes(1);
    expect(calls['codex-cli']).toHaveBeenCalledTimes(1);
    expect(calls['deepseek-claude-code']).toHaveBeenCalledTimes(1);
  });

  it('startup prefetch warms the cache used by later IPC reads', async () => {
    const calls = setupAdapters();

    await prefetchProviderUsageSnapshots();
    const result = await providerUsageSnapshotHandler();

    expect(result.snapshots).toHaveLength(3);
    expect(calls['claude-code']).toHaveBeenCalledTimes(1);
    expect(calls['codex-cli']).toHaveBeenCalledTimes(1);
    expect(calls['deepseek-claude-code']).toHaveBeenCalledTimes(1);
  });
});
