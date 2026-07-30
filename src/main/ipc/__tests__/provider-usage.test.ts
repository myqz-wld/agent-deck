import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderUsageSnapshot } from '@shared/types';

const mocks = vi.hoisted(() => ({
  adapterRegistry: {
    get: vi.fn(),
  },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@main/adapters/registry', () => ({ adapterRegistry: mocks.adapterRegistry }));
vi.mock('@main/utils/logger', () => ({
  default: {
    ...mocks.logger,
    scope: () => mocks.logger,
  },
}));

import {
  PROVIDER_USAGE_CACHE_TTL_MS,
  PROVIDER_USAGE_LOG_SUMMARY_INTERVAL_MS,
  PROVIDER_USAGE_READ_TIMEOUT_MS,
  PROVIDER_USAGE_SLOW_READ_MS,
  _resetProviderUsageCacheForTesting,
  prefetchProviderUsageSnapshots,
  providerUsageSnapshotHandler,
} from '../provider-usage';

function snapshot(
  provider: ProviderUsageSnapshot['provider'],
  updatedAt = Date.now(),
  status: ProviderUsageSnapshot['status'] = 'ok',
): ProviderUsageSnapshot {
  return {
    provider,
    label:
      provider === 'claude-code'
        ? 'Claude Code'
        : provider === 'codex-cli'
          ? 'Codex CLI'
          : 'Grok Build',
    status,
    windows: [],
    updatedAt,
  };
}

type ProviderCalls = Record<ProviderUsageSnapshot['provider'], ReturnType<typeof vi.fn>>;

function installAdapters(calls: ProviderCalls): void {
  mocks.adapterRegistry.get.mockImplementation((id: ProviderUsageSnapshot['provider']) => ({
    id,
    getUsageSnapshot: calls[id],
  }));
}

function setupAdapters(): ProviderCalls {
  const calls = {
    'claude-code': vi.fn().mockResolvedValue(snapshot('claude-code')),
    'codex-cli': vi.fn().mockResolvedValue(snapshot('codex-cli')),
    'grok-build': vi.fn().mockResolvedValue(snapshot('grok-build')),
  };
  installAdapters(calls);
  return calls;
}

function setupClaudeAdapter(claude: ReturnType<typeof vi.fn>): ProviderCalls {
  const calls = {
    'claude-code': claude,
    'codex-cli': vi.fn().mockResolvedValue(snapshot('codex-cli')),
    'grok-build': vi.fn().mockResolvedValue(snapshot('grok-build')),
  };
  installAdapters(calls);
  return calls;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z'));
  mocks.adapterRegistry.get.mockReset();
  for (const method of Object.values(mocks.logger)) method.mockReset();
  _resetProviderUsageCacheForTesting();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('providerUsageSnapshotHandler cache', () => {
  it('keeps the provider usage cache TTL just below the ten-minute refresh cadence', () => {
    expect(PROVIDER_USAGE_CACHE_TTL_MS).toBe(10 * 60_000 - 5_000);
    expect(PROVIDER_USAGE_LOG_SUMMARY_INTERVAL_MS).toBe(60 * 60_000);
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
    const claude = deferred<ProviderUsageSnapshot>();
    const calls = setupClaudeAdapter(vi.fn().mockReturnValue(claude.promise));

    const first = providerUsageSnapshotHandler();
    const second = providerUsageSnapshotHandler();
    claude.resolve(snapshot('claude-code'));
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b);
    expect(calls['claude-code']).toHaveBeenCalledTimes(1);
    expect(calls['codex-cli']).toHaveBeenCalledTimes(1);
    expect(calls['grok-build']).toHaveBeenCalledTimes(1);
  });

  it('ignores an older healthy diagnostic after a newer abnormal read', async () => {
    const oldClaude = deferred<ProviderUsageSnapshot>();
    const freshClaude = deferred<ProviderUsageSnapshot>();
    const calls = setupClaudeAdapter(
      vi
        .fn()
        .mockReturnValueOnce(oldClaude.promise)
        .mockReturnValueOnce(freshClaude.promise),
    );

    const oldRead = providerUsageSnapshotHandler();
    const freshRead = providerUsageSnapshotHandler({ force: true });

    expect(calls['claude-code']).toHaveBeenCalledTimes(2);

    freshClaude.resolve(snapshot('claude-code', 2_000, 'unavailable'));
    const freshResult = await freshRead;
    expect(freshResult.snapshots[0].status).toBe('unavailable');
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);

    oldClaude.resolve(snapshot('claude-code', 1_000));
    const oldResult = await oldRead;
    expect(oldResult.snapshots[0].status).toBe('ok');
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(mocks.logger.info).not.toHaveBeenCalled();

    const cached = await providerUsageSnapshotHandler();
    expect(cached).toBe(freshResult);
    expect(cached.snapshots[0].status).toBe('unavailable');
  });

  it('ignores an older failed diagnostic after a newer healthy read', async () => {
    const oldClaude = deferred<ProviderUsageSnapshot>();
    setupClaudeAdapter(
      vi
        .fn()
        .mockReturnValueOnce(oldClaude.promise)
        .mockResolvedValueOnce(snapshot('claude-code', 2_000)),
    );

    const oldRead = providerUsageSnapshotHandler();
    const freshResult = await providerUsageSnapshotHandler({ force: true });
    oldClaude.reject(new Error('stale provider failure'));
    expect((await oldRead).snapshots[0].status).toBe('error');

    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
    expect(await providerUsageSnapshotHandler()).toBe(freshResult);
  });

  it('ignores an older timeout diagnostic after a newer healthy read', async () => {
    setupClaudeAdapter(
      vi
        .fn()
        .mockReturnValueOnce(new Promise<ProviderUsageSnapshot>(() => {}))
        .mockResolvedValueOnce(snapshot('claude-code', 2_000)),
    );

    const oldRead = providerUsageSnapshotHandler();
    const freshResult = await providerUsageSnapshotHandler({ force: true });
    await vi.advanceTimersByTimeAsync(PROVIDER_USAGE_READ_TIMEOUT_MS);
    expect((await oldRead).snapshots[0]).toEqual(snapshot('claude-code', 2_000));

    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
    expect(await providerUsageSnapshotHandler()).toBe(freshResult);
  });

  it('non-force reads join a newer forced in-flight read before using fresh cache', async () => {
    const freshClaude = deferred<ProviderUsageSnapshot>();
    const calls = setupClaudeAdapter(
      vi
        .fn()
        .mockResolvedValueOnce(snapshot('claude-code', 1_000))
        .mockReturnValueOnce(freshClaude.promise),
    );

    await providerUsageSnapshotHandler();
    const forced = providerUsageSnapshotHandler({ force: true });
    const normalDuringForce = providerUsageSnapshotHandler();

    expect(calls['claude-code']).toHaveBeenCalledTimes(2);

    freshClaude.resolve(snapshot('claude-code', 2_000));
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
    const claudeRead = deferred<ProviderUsageSnapshot>();
    const calls = {
      'claude-code': vi.fn().mockReturnValue(claudeRead.promise),
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
        label: 'Claude Code',
        status: 'unavailable',
        message: 'Claude Code 额度读取超时，已跳过本次刷新',
      }),
      expect.objectContaining({ provider: 'codex-cli', updatedAt: 2_000 }),
      expect.objectContaining({ provider: 'grok-build', updatedAt: 3_000 }),
    ]);

    claudeRead.resolve(snapshot('claude-code', 4_000));
    await claudeRead.promise;
    const cached = await providerUsageSnapshotHandler();
    expect(cached.snapshots[0]).toEqual(snapshot('claude-code', 4_000));
    expect(mocks.logger.warn.mock.calls.map((call) => call[1]?.state)).toEqual([
      'timeout-empty',
    ]);
    expect(mocks.logger.info).not.toHaveBeenCalled();
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

  it('logs allowlisted provider diagnostics without account-state or secret material', async () => {
    const secret =
      'Bearer private-token prompt=/Users/private/repo https://example.test/?token=private';
    const claude = vi
      .fn()
      .mockRejectedValueOnce(new Error(secret))
      .mockRejectedValueOnce(new Error(secret))
      .mockResolvedValueOnce({
        ...snapshot('claude-code', 3, 'unavailable'),
        message: `provider-payload ${secret}`,
      })
      .mockResolvedValueOnce(snapshot('claude-code', 4, 'not_subscribed'))
      .mockResolvedValueOnce(snapshot('claude-code', 5, 'unsupported'))
      .mockResolvedValueOnce(snapshot('claude-code', 6, 'ok'));
    setupClaudeAdapter(claude);

    expect((await providerUsageSnapshotHandler()).snapshots[0].status).toBe('error');
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect((await providerUsageSnapshotHandler({ force: true })).snapshots[0].status).toBe(
      'error',
    );
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    for (const status of ['unavailable', 'not_subscribed', 'unsupported'] as const) {
      expect((await providerUsageSnapshotHandler({ force: true })).snapshots[0].status).toBe(
        status,
      );
    }
    expect((await providerUsageSnapshotHandler({ force: true })).snapshots[0].status).toBe('ok');

    expect(
      mocks.logger.warn.mock.calls.map(
        (call) => (call[1] as { state: string }).state,
      ),
    ).toEqual(['error', 'unavailable']);
    expect(mocks.logger.warn.mock.calls[1]?.[1]).toMatchObject({
      provider: 'claude-code',
      previousState: 'error',
      suppressedCount: 1,
    });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'provider usage state recovered',
      expect.objectContaining({
        provider: 'claude-code',
        state: 'healthy',
        previousState: 'unavailable',
      }),
    );
    const emitted = JSON.stringify({
      warn: mocks.logger.warn.mock.calls,
      info: mocks.logger.info.mock.calls,
    });
    for (const forbidden of [
      'private-token',
      'provider-payload',
      '/Users/private/repo',
      'example.test',
      'prompt=',
      'codex-cli',
      'grok-build',
      '[provider-usage]',
    ]) {
      expect(emitted).not.toContain(forbidden);
    }
  });

  it('summarizes repeated abnormal status and records its recovery', async () => {
    const claude = vi.fn().mockResolvedValue(
      snapshot('claude-code', 1, 'unavailable'),
    );
    setupClaudeAdapter(claude);

    await providerUsageSnapshotHandler();
    await providerUsageSnapshotHandler({ force: true });
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + PROVIDER_USAGE_LOG_SUMMARY_INTERVAL_MS);
    await providerUsageSnapshotHandler({ force: true });
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    expect(mocks.logger.warn.mock.calls[1]).toEqual([
      'provider usage state remains degraded',
      expect.objectContaining({
        provider: 'claude-code',
        state: 'unavailable',
        transition: 'periodic-summary',
        suppressedCount: 1,
      }),
    ]);

    claude.mockResolvedValueOnce(snapshot('claude-code', 2));
    await providerUsageSnapshotHandler({ force: true });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'provider usage state recovered',
      expect.objectContaining({
        provider: 'claude-code',
        previousState: 'unavailable',
      }),
    );
  });

  it('distinguishes slow success and cached versus empty timeouts', async () => {
    const claude = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ProviderUsageSnapshot>((resolve) => {
            setTimeout(
              () => resolve(snapshot('claude-code', 1)),
              PROVIDER_USAGE_SLOW_READ_MS,
            );
          }),
      )
      .mockResolvedValueOnce(snapshot('claude-code', 2))
      .mockReturnValueOnce(new Promise<ProviderUsageSnapshot>(() => {}));
    setupClaudeAdapter(claude);

    const slowRead = providerUsageSnapshotHandler();
    await vi.advanceTimersByTimeAsync(PROVIDER_USAGE_SLOW_READ_MS);
    await slowRead;
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'provider usage state degraded',
      expect.objectContaining({
        provider: 'claude-code',
        state: 'slow',
        maxDurationMs: PROVIDER_USAGE_SLOW_READ_MS,
      }),
    );

    await providerUsageSnapshotHandler({ force: true });
    expect(mocks.logger.info).toHaveBeenCalledTimes(1);
    const cachedTimeout = providerUsageSnapshotHandler({ force: true });
    await vi.advanceTimersByTimeAsync(PROVIDER_USAGE_READ_TIMEOUT_MS);
    expect((await cachedTimeout).snapshots[0]).toEqual(snapshot('claude-code', 2));
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'provider usage state degraded',
      expect.objectContaining({
        provider: 'claude-code',
        state: 'timeout-cached',
      }),
    );

    _resetProviderUsageCacheForTesting();
    mocks.logger.warn.mockReset();
    mocks.logger.info.mockReset();
    setupClaudeAdapter(vi.fn().mockReturnValue(new Promise<ProviderUsageSnapshot>(() => {})));
    const emptyTimeout = providerUsageSnapshotHandler();
    await vi.advanceTimersByTimeAsync(PROVIDER_USAGE_READ_TIMEOUT_MS);
    expect((await emptyTimeout).snapshots[0]).toMatchObject({
      label: 'Claude Code',
      status: 'unavailable',
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'provider usage state degraded',
      expect.objectContaining({
        provider: 'claude-code',
        state: 'timeout-empty',
      }),
    );
  });

  it('keeps provider results unchanged when the diagnostic sink throws', async () => {
    setupClaudeAdapter(
      vi.fn().mockResolvedValue(snapshot('claude-code', 1, 'unavailable')),
    );
    mocks.logger.warn.mockImplementationOnce(() => {
      throw new Error('diagnostic sink failed');
    });

    const result = await providerUsageSnapshotHandler();
    expect(result.snapshots[0]).toMatchObject({
      provider: 'claude-code',
      label: 'Claude Code',
      status: 'unavailable',
    });
  });
});
