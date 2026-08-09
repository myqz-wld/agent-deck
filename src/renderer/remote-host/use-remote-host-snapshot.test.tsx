// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteHostDataChangedDto, RemoteHostSnapshotDto } from '@shared/remote-host';
import { useRemoteHostSnapshot } from './use-remote-host-snapshot';

const snapshot: RemoteHostSnapshotDto = {
  revision: 1,
  sourceMode: 'local',
  selectedRemoteProfileId: null,
  profiles: [],
  states: [],
};

describe('useRemoteHostSnapshot invalidation coalescing', () => {
  let listener: ((event: RemoteHostDataChangedDto) => void) | null;
  const getSnapshot = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    listener = null;
    getSnapshot.mockReset().mockResolvedValue(snapshot);
    window.api = {
      getRemoteHostSnapshot: getSnapshot,
      onRemoteHostChanged: (next: (event: RemoteHostDataChangedDto) => void) => {
        listener = next;
        return () => { listener = null; };
      },
    } as unknown as typeof window.api;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges an event burst into one business revision update', async () => {
    const hook = renderHook(() => useRemoteHostSnapshot());
    await act(async () => { await Promise.resolve(); });
    expect(hook.result.current.dataRevisionByProfile.size).toBe(0);

    act(() => {
      for (let revision = 2; revision <= 12; revision += 1) {
        listener?.({ revision, profileId: 'remote-a', reason: 'data' });
      }
    });
    expect(hook.result.current.dataRevisionByProfile.size).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(199); });
    expect(hook.result.current.dataRevisionByProfile.size).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(hook.result.current.dataRevisionByProfile.get('remote-a')).toBe(12);
    expect(hook.result.current.dataRevisionByProfile.has('remote-b')).toBe(false);
    expect(getSnapshot).toHaveBeenCalledTimes(3);
  });

  it('refreshes on the leading edge and at the max-wait boundary under continuous events', async () => {
    renderHook(() => useRemoteHostSnapshot());
    await act(async () => { await Promise.resolve(); });
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    act(() => listener?.({ revision: 2, profileId: 'remote-a', reason: 'state' }));
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    for (let revision = 3; revision <= 6; revision += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
        listener?.({ revision, profileId: 'remote-a', reason: 'state' });
      });
    }

    expect(getSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    expect(getSnapshot).toHaveBeenCalledTimes(3);
    act(() => listener?.({ revision: 7, profileId: 'remote-a', reason: 'state' }));
    expect(getSnapshot).toHaveBeenCalledTimes(4);
  });
});
