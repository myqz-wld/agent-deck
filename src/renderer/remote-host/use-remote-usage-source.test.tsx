// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REMOTE_HOST_RESOURCE_KINDS } from '@shared/remote-host';
import type { RemoteHostResourceRevisions } from '@shared/remote-host';
import type { RemoteSessionSourceView } from './source-types';
import { useRemoteUsageSource } from './use-remote-usage-source';

function source(
  profileId: string,
  revision: number,
  usable = true,
  status: 'connected' | 'reconnecting' | 'offline' = usable ? 'connected' : 'offline',
  usageRevision = 0,
): RemoteSessionSourceView {
  const resourceRevisions = Object.fromEntries(REMOTE_HOST_RESOURCE_KINDS.map((kind) => [
    kind, kind === 'usage' ? usageRevision : 0,
  ])) as RemoteHostResourceRevisions;
  return {
    identity: `${profileId}:core:1`,
    dataRevision: revision,
    resourceRevisions,
    capabilities: new Set(['usage']),
    profile: { id: profileId },
    state: { status },
    usable,
  } as unknown as RemoteSessionSourceView;
}

function tokenResult(bucketKey: string, revision = 1) {
  return {
    rates: [{ bucketKey, outputTokens: 60 }],
    topToday: [{ bucketKey, outputTokens: 600 }],
    daily: [],
    dailyTruncated: false,
    today: '2026-08-10',
    revision,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  window.api = {
    getRemoteHostTokenUsage: vi.fn(async (request) => tokenResult(request.profileId)),
    getRemoteHostProviderUsage: vi.fn(async () => ({ snapshots: [], revision: 1 })),
  } as unknown as typeof window.api;
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'api');
});

describe('useRemoteUsageSource', () => {
  it('loads rates, daily rows, and provider windows only from the selected Remote profile', async () => {
    const hook = renderHook(() => useRemoteUsageSource(source('remote-a', 1), true));
    await waitFor(() => expect(hook.result.current.rates[0]?.bucketKey).toBe('remote-a'));
    await act(async () => { await hook.result.current.loadDaily(); });
    await act(async () => { await hook.result.current.loadProviders(true); });

    expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'remote-a', includeDaily: true,
    }));
    expect(window.api.getRemoteHostProviderUsage)
      .toHaveBeenCalledWith({ profileId: 'remote-a', force: true });
  });

  it('drops a late response after the Remote identity changes', async () => {
    const slow = deferred<ReturnType<typeof tokenResult>>();
    vi.mocked(window.api.getRemoteHostTokenUsage).mockImplementation((request) =>
      request.profileId === 'remote-a'
        ? slow.promise
        : Promise.resolve(tokenResult('remote-b')));
    const hook = renderHook(
      ({ current }) => useRemoteUsageSource(current, true),
      { initialProps: { current: source('remote-a', 1) } },
    );
    hook.rerender({ current: source('remote-b', 1) });
    await waitFor(() => expect(hook.result.current.rates[0]?.bucketKey).toBe('remote-b'));
    act(() => slow.resolve(tokenResult('remote-a')));
    await act(async () => { await Promise.resolve(); });
    expect(hook.result.current.rates[0]?.bucketKey).toBe('remote-b');
  });

  it('serializes a requested daily refresh behind the current rate read', async () => {
    const oldRates = deferred<ReturnType<typeof tokenResult>>();
    const newDaily = deferred<ReturnType<typeof tokenResult>>();
    vi.mocked(window.api.getRemoteHostTokenUsage).mockImplementation((request) =>
      request.includeDaily ? newDaily.promise : oldRates.promise);
    const hook = renderHook(() => useRemoteUsageSource(source('remote-a', 1), true));
    await waitFor(() => expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({ includeDaily: false }),
    ));

    let dailyPromise!: Promise<void>;
    act(() => { dailyPromise = hook.result.current.loadDaily(); });
    expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledTimes(1);
    oldRates.resolve(tokenResult('old-rate', 1));
    await waitFor(() => expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({ includeDaily: true }),
    ));
    newDaily.resolve(tokenResult('new-daily', 2));
    await act(async () => { await dailyPromise; });
    expect(hook.result.current.rates[0]?.bucketKey).toBe('new-daily');
  });

  it('does not read Remote usage while Local is selected', async () => {
    const hook = renderHook(() => useRemoteUsageSource(source('remote-a', 1), false));
    await act(async () => { await Promise.resolve(); });
    expect(hook.result.current.enabled).toBe(false);
    expect(window.api.getRemoteHostTokenUsage).not.toHaveBeenCalled();
    expect(window.api.getRemoteHostProviderUsage).not.toHaveBeenCalled();
  });

  it('stops polling when the selected Remote binding is unusable', async () => {
    const hook = renderHook(
      ({ current }) => useRemoteUsageSource(current, true),
      { initialProps: { current: source('remote-a', 1) } },
    );
    await waitFor(() => expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledTimes(1));
    hook.rerender({ current: source('remote-a', 1, false) });
    await act(async () => { await Promise.resolve(); });
    expect(hook.result.current.enabled).toBe(false);
    expect(hook.result.current.rates).toEqual([]);
  });

  it('does not use stale usage capability while the source is reconnecting', async () => {
    const hook = renderHook(() => useRemoteUsageSource(
      source('remote-a', 1, true, 'reconnecting'),
      true,
    ));
    await act(async () => { await Promise.resolve(); });
    expect(hook.result.current.enabled).toBe(false);
    expect(window.api.getRemoteHostTokenUsage).not.toHaveBeenCalled();
    expect(window.api.getRemoteHostProviderUsage).not.toHaveBeenCalled();
  });

  it('clears usage immediately and rejects stale loaders after same-identity disconnect', async () => {
    const hook = renderHook(
      ({ current }) => useRemoteUsageSource(current, true),
      { initialProps: { current: source('remote-a', 1) } },
    );
    await waitFor(() => expect(hook.result.current.rates[0]?.bucketKey).toBe('remote-a'));
    const staleLoadDaily = hook.result.current.loadDaily;
    const staleLoadProviders = hook.result.current.loadProviders;
    const tokenCalls = vi.mocked(window.api.getRemoteHostTokenUsage).mock.calls.length;
    const providerCalls = vi.mocked(window.api.getRemoteHostProviderUsage).mock.calls.length;

    hook.rerender({ current: source('remote-a', 1, false, 'reconnecting') });
    expect(hook.result.current.rates).toEqual([]);
    expect(hook.result.current.topToday).toEqual([]);
    expect(hook.result.current.today).toBeNull();
    expect(hook.result.current.providerSnapshots).toEqual([]);

    await act(async () => {
      await staleLoadDaily();
      await staleLoadProviders(true);
    });
    expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledTimes(tokenCalls);
    expect(window.api.getRemoteHostProviderUsage).toHaveBeenCalledTimes(providerCalls);
  });

  it('polls once per documented interval and stops immediately on disconnect', async () => {
    vi.useFakeTimers();
    const hook = renderHook(
      ({ current }) => useRemoteUsageSource(current, true),
      { initialProps: { current: source('remote-a', 1) } },
    );
    await act(async () => { await Promise.resolve(); });
    expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(7_500); });
    expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledTimes(4);

    hook.rerender({ current: source('remote-a', 1, false, 'reconnecting') });
    const stoppedAt = vi.mocked(window.api.getRemoteHostTokenUsage).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledTimes(stoppedAt);
  });

  it('keeps at most one token read in flight while interval ticks accumulate', async () => {
    vi.useFakeTimers();
    const slow = deferred<ReturnType<typeof tokenResult>>();
    vi.mocked(window.api.getRemoteHostTokenUsage).mockReturnValue(slow.promise);
    renderHook(() => useRemoteUsageSource(source('remote-a', 1), true));
    await act(async () => { await Promise.resolve(); });
    expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledOnce();

    slow.resolve(tokenResult('remote-a'));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledTimes(2);
  });

  it('serializes a forced provider refresh behind an ordinary provider read', async () => {
    const first = deferred<{ snapshots: []; revision: number }>();
    vi.mocked(window.api.getRemoteHostProviderUsage)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ snapshots: [], revision: 2 });
    const hook = renderHook(() => useRemoteUsageSource(source('remote-a', 1), true));

    let ordinary!: Promise<void>;
    let forced!: Promise<void>;
    act(() => {
      ordinary = hook.result.current.loadProviders(false);
      forced = hook.result.current.loadProviders(true);
    });
    expect(window.api.getRemoteHostProviderUsage).toHaveBeenCalledOnce();
    first.resolve({ snapshots: [], revision: 1 });
    await waitFor(() => expect(window.api.getRemoteHostProviderUsage).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.all([ordinary, forced]); });
    expect(window.api.getRemoteHostProviderUsage).toHaveBeenLastCalledWith({
      profileId: 'remote-a', force: true,
    });
  });

  it('does not turn unrelated Core revisions into extra usage reads', async () => {
    const hook = renderHook(
      ({ current }) => useRemoteUsageSource(current, true, true),
      { initialProps: { current: source('remote-a', 1) } },
    );
    await waitFor(() => expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledOnce());
    hook.rerender({ current: source('remote-a', 200) });
    await act(async () => { await Promise.resolve(); });
    expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledOnce();
  });

  it('coalesces a usage resource revision into one follow-up read', async () => {
    const first = deferred<ReturnType<typeof tokenResult>>();
    vi.mocked(window.api.getRemoteHostTokenUsage)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(tokenResult('fresh'));
    const hook = renderHook(
      ({ current }) => useRemoteUsageSource(current, true),
      { initialProps: { current: source('remote-a', 1) } },
    );
    await waitFor(() => expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledOnce());
    hook.rerender({ current: source('remote-a', 2, true, 'connected', 2) });
    hook.rerender({ current: source('remote-a', 3, true, 'connected', 3) });
    expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledOnce();
    first.resolve(tokenResult('old'));
    await waitFor(() => expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.rates[0]?.bucketKey).toBe('fresh'));
  });
});
