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
  PROVIDER_USAGE_READ_TIMEOUT_MS,
  _resetProviderUsageCacheForTesting,
  prefetchProviderUsageSnapshots,
  providerUsageSnapshotHandler,
} from '../provider-usage';

function snapshot(
  provider: ProviderUsageSnapshot['provider'],
  updatedAt = Date.now(),
): ProviderUsageSnapshot {
  return {
    provider,
    label:
      provider === 'claude-code'
        ? 'Claude'
        : provider === 'codex-cli'
          ? 'Codex'
          : 'Grok',
    status: 'ok',
    windows: [],
    updatedAt,
  };
}

function setupAdapters(): Record<ProviderUsageSnapshot['provider'], ReturnType<typeof vi.fn>> {
  const calls = {
    'claude-code': vi.fn().mockResolvedValue(snapshot('claude-code')),
    'codex-cli': vi.fn().mockResolvedValue(snapshot('codex-cli')),
    'grok-build': vi.fn().mockResolvedValue(snapshot('grok-build')),
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
  it('keeps the provider usage cache TTL just below the ten-minute refresh cadence', () => {
    expect(PROVIDER_USAGE_CACHE_TTL_MS).toBe(10 * 60_000 - 5_000);
  });

  it('returns cached snapshots within TTL', async () => {
    const calls = setupAdapters();

    const first = await providerUsageSnapshotHandler();
    vi.setSystemTime(Date.now() + PROVIDER_USAGE_CACHE_TTL_MS - 1);
    const second = await providerUsageSnapshotHandler();

    expect(second).toBe(first);
    expect(calls['claude-code']).toHaveBeenCalledTimes(1);
    expect(calls['codex-cli']).toHaveBeenCalledTimes(1);
    expect(calls['grok-build']).toHaveBeenCalledTimes(1);
  });

  it('refreshes snapshots after TTL expires', async () => {
    const calls = setupAdapters();

    await providerUsageSnapshotHandler();
    vi.setSystemTime(Date.now() + PROVIDER_USAGE_CACHE_TTL_MS + 1);
    await providerUsageSnapshotHandler();

    expect(calls['claude-code']).toHaveBeenCalledTimes(2);
    expect(calls['codex-cli']).toHaveBeenCalledTimes(2);
    expect(calls['grok-build']).toHaveBeenCalledTimes(2);
  });

  it('force refresh bypasses fresh cache', async () => {
    const calls = setupAdapters();

    await providerUsageSnapshotHandler();
    vi.setSystemTime(Date.now() + PROVIDER_USAGE_CACHE_TTL_MS - 1);
    await providerUsageSnapshotHandler({ force: true });

    expect(calls['claude-code']).toHaveBeenCalledTimes(2);
    expect(calls['codex-cli']).toHaveBeenCalledTimes(2);
    expect(calls['grok-build']).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent refreshes behind one provider read', async () => {
    let resolveClaude!: (value: ProviderUsageSnapshot) => void;
    const claudePromise = new Promise<ProviderUsageSnapshot>((resolve) => {
      resolveClaude = resolve;
    });
    const calls = {
      'claude-code': vi.fn().mockReturnValue(claudePromise),
      'codex-cli': vi.fn().mockResolvedValue(snapshot('codex-cli')),
      'grok-build': vi.fn().mockResolvedValue(snapshot('grok-build')),
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
    expect(calls['grok-build']).toHaveBeenCalledTimes(1);
  });

  it('force refresh bypasses an older normal in-flight read and keeps the newer cache', async () => {
    let resolveOldClaude!: (value: ProviderUsageSnapshot) => void;
    let resolveFreshClaude!: (value: ProviderUsageSnapshot) => void;
    const oldClaude = new Promise<ProviderUsageSnapshot>((resolve) => {
      resolveOldClaude = resolve;
    });
    const freshClaude = new Promise<ProviderUsageSnapshot>((resolve) => {
      resolveFreshClaude = resolve;
    });
    const calls = {
      'claude-code': vi
        .fn()
        .mockReturnValueOnce(oldClaude)
        .mockReturnValueOnce(freshClaude)
        .mockReturnValueOnce(new Promise<ProviderUsageSnapshot>(() => {})),
      'codex-cli': vi.fn().mockResolvedValue(snapshot('codex-cli')),
      'grok-build': vi.fn().mockResolvedValue(snapshot('grok-build')),
    };
    mocks.adapterRegistry.get.mockImplementation((id: ProviderUsageSnapshot['provider']) => ({
      id,
      getUsageSnapshot: calls[id],
    }));

    const oldRead = providerUsageSnapshotHandler();
    const freshRead = providerUsageSnapshotHandler({ force: true });

    expect(calls['claude-code']).toHaveBeenCalledTimes(2);

    resolveFreshClaude(snapshot('claude-code', 2_000));
    const freshResult = await freshRead;
    expect(freshResult.snapshots[0].updatedAt).toBe(2_000);

    resolveOldClaude(snapshot('claude-code', 1_000));
    const oldResult = await oldRead;
    expect(oldResult.snapshots[0].updatedAt).toBe(1_000);

    const cached = await providerUsageSnapshotHandler();
    expect(cached).toBe(freshResult);
    expect(cached.snapshots[0].updatedAt).toBe(2_000);

    const timedOutRead = providerUsageSnapshotHandler({ force: true });
    await vi.advanceTimersByTimeAsync(PROVIDER_USAGE_READ_TIMEOUT_MS);
    const timedOutResult = await timedOutRead;
    expect(timedOutResult.snapshots[0].updatedAt).toBe(2_000);
  });

  it('non-force reads join a newer forced in-flight read before using fresh cache', async () => {
    let resolveFreshClaude!: (value: ProviderUsageSnapshot) => void;
    const freshClaude = new Promise<ProviderUsageSnapshot>((resolve) => {
      resolveFreshClaude = resolve;
    });
    const calls = {
      'claude-code': vi
        .fn()
        .mockResolvedValueOnce(snapshot('claude-code', 1_000))
        .mockReturnValueOnce(freshClaude),
      'codex-cli': vi.fn().mockResolvedValue(snapshot('codex-cli')),
      'grok-build': vi.fn().mockResolvedValue(snapshot('grok-build')),
    };
    mocks.adapterRegistry.get.mockImplementation((id: ProviderUsageSnapshot['provider']) => ({
      id,
      getUsageSnapshot: calls[id],
    }));

    await providerUsageSnapshotHandler();
    const forced = providerUsageSnapshotHandler({ force: true });
    const normalDuringForce = providerUsageSnapshotHandler();

    expect(calls['claude-code']).toHaveBeenCalledTimes(2);

    resolveFreshClaude(snapshot('claude-code', 2_000));
    const [forcedResult, normalResult] = await Promise.all([forced, normalDuringForce]);

    expect(forcedResult).toBe(normalResult);
    expect(normalResult.snapshots[0].updatedAt).toBe(2_000);
  });

  it('startup prefetch warms the cache used by later IPC reads', async () => {
    const calls = setupAdapters();

    await prefetchProviderUsageSnapshots();
    const result = await providerUsageSnapshotHandler();

    expect(result.snapshots).toHaveLength(3);
    expect(calls['claude-code']).toHaveBeenCalledTimes(1);
    expect(calls['codex-cli']).toHaveBeenCalledTimes(1);
    expect(calls['grok-build']).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung provider without delaying snapshots from the other providers', async () => {
    let resolveClaude!: (value: ProviderUsageSnapshot) => void;
    const claudeRead = new Promise<ProviderUsageSnapshot>((resolve) => {
      resolveClaude = resolve;
    });
    const calls = {
      'claude-code': vi.fn().mockReturnValue(claudeRead),
      'codex-cli': vi.fn().mockResolvedValue(snapshot('codex-cli', 2_000)),
      'grok-build': vi.fn().mockResolvedValue(snapshot('grok-build', 3_000)),
    };
    mocks.adapterRegistry.get.mockImplementation((id: ProviderUsageSnapshot['provider']) => ({
      id,
      getUsageSnapshot: calls[id],
    }));

    const refresh = providerUsageSnapshotHandler();
    await vi.advanceTimersByTimeAsync(PROVIDER_USAGE_READ_TIMEOUT_MS);
    const result = await refresh;

    expect(result.snapshots).toEqual([
      expect.objectContaining({
        provider: 'claude-code',
        status: 'unavailable',
        message: 'Claude 额度读取超时，已跳过本次刷新',
      }),
      expect.objectContaining({ provider: 'codex-cli', updatedAt: 2_000 }),
      expect.objectContaining({ provider: 'grok-build', updatedAt: 3_000 }),
    ]);

    resolveClaude(snapshot('claude-code', 4_000));
    await claudeRead;
    const cached = await providerUsageSnapshotHandler();
    expect(cached.snapshots[0]).toEqual(snapshot('claude-code', 4_000));
    expect(calls['claude-code']).toHaveBeenCalledTimes(1);
  });

  it('keeps the last successful provider snapshot when a forced refresh times out', async () => {
    const calls = {
      'claude-code': vi
        .fn()
        .mockResolvedValueOnce(snapshot('claude-code', 1_000))
        .mockReturnValueOnce(new Promise<ProviderUsageSnapshot>(() => {})),
      'codex-cli': vi
        .fn()
        .mockResolvedValueOnce(snapshot('codex-cli', 1_000))
        .mockResolvedValueOnce(snapshot('codex-cli', 2_000)),
      'grok-build': vi
        .fn()
        .mockResolvedValueOnce(snapshot('grok-build', 1_000))
        .mockResolvedValueOnce(snapshot('grok-build', 2_000)),
    };
    mocks.adapterRegistry.get.mockImplementation((id: ProviderUsageSnapshot['provider']) => ({
      id,
      getUsageSnapshot: calls[id],
    }));

    await providerUsageSnapshotHandler();
    const refresh = providerUsageSnapshotHandler({ force: true });
    await vi.advanceTimersByTimeAsync(PROVIDER_USAGE_READ_TIMEOUT_MS);
    const result = await refresh;

    expect(result.snapshots[0]).toEqual(snapshot('claude-code', 1_000));
    expect(result.snapshots[1].updatedAt).toBe(2_000);
    expect(result.snapshots[2].updatedAt).toBe(2_000);
  });
});
