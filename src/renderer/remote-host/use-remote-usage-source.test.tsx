// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteSessionSourceView } from './source-types';
import { useRemoteUsageSource } from './use-remote-usage-source';

function source(profileId: string, revision: number): RemoteSessionSourceView {
  return {
    identity: `${profileId}:core:1`,
    dataRevision: revision,
    capabilities: new Set(['usage']),
    profile: { id: profileId },
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

afterEach(() => Reflect.deleteProperty(window, 'api'));

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

  it('does not let an older rate request overwrite a newer daily response', async () => {
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
    await waitFor(() => expect(window.api.getRemoteHostTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({ includeDaily: true }),
    ));
    newDaily.resolve(tokenResult('new-daily', 2));
    await act(async () => { await dailyPromise; });
    expect(hook.result.current.rates[0]?.bucketKey).toBe('new-daily');

    oldRates.resolve(tokenResult('old-rate', 1));
    await act(async () => { await Promise.resolve(); });
    expect(hook.result.current.rates[0]?.bucketKey).toBe('new-daily');
  });

  it('does not read Remote usage while Local is selected', async () => {
    const hook = renderHook(() => useRemoteUsageSource(source('remote-a', 1), false));
    await act(async () => { await Promise.resolve(); });
    expect(hook.result.current.enabled).toBe(false);
    expect(window.api.getRemoteHostTokenUsage).not.toHaveBeenCalled();
    expect(window.api.getRemoteHostProviderUsage).not.toHaveBeenCalled();
  });
});
