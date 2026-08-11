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
  const connectRemoteHost = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    listener = null;
    getSnapshot.mockReset().mockResolvedValue(snapshot);
    connectRemoteHost.mockReset();
    window.api = {
      getRemoteHostSnapshot: getSnapshot,
      connectRemoteHost,
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

  it('reconnects the persisted active Remote source once on startup', async () => {
    const remote: RemoteHostSnapshotDto = {
      revision: 3,
      sourceMode: 'remote',
      selectedRemoteProfileId: 'remote-a',
      profiles: [{
        id: 'remote-a',
        label: 'Relay',
        scope: 'remote',
        endpoint: null,
        credentials: { connectionCredentialConfigured: true },
      }],
      states: [{
        profileId: 'remote-a',
        status: 'offline',
        recovery: null,
        authoritativeCoreId: null,
        workerGeneration: null,
        capabilities: [],
        eventRevision: 0,
        error: null,
      }],
    };
    const connected: RemoteHostSnapshotDto = {
      ...remote,
      revision: 4,
      states: [{
        ...remote.states[0]!,
        status: 'connected',
        capabilities: ['teams', 'issues', 'usage'],
      }],
    };
    getSnapshot.mockResolvedValue(remote);
    connectRemoteHost.mockResolvedValue(connected);

    const hook = renderHook(() => useRemoteHostSnapshot());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(connectRemoteHost).toHaveBeenCalledTimes(1);
    expect(connectRemoteHost).toHaveBeenCalledWith('remote-a');
    expect(hook.result.current.snapshot).toEqual(connected);

    act(() => listener?.({ revision: 5, profileId: 'remote-a', reason: 'state' }));
    await act(async () => { await Promise.resolve(); });
    expect(connectRemoteHost).toHaveBeenCalledTimes(1);
  });

  it('does not undo an explicit disconnect while Remote remains selected', async () => {
    const connected: RemoteHostSnapshotDto = {
      revision: 3,
      sourceMode: 'remote',
      selectedRemoteProfileId: 'remote-a',
      profiles: [],
      states: [{
        profileId: 'remote-a',
        status: 'connected',
        recovery: null,
        authoritativeCoreId: 'core-a',
        workerGeneration: 1,
        capabilities: ['teams'],
        eventRevision: 1,
        error: null,
      }],
    };
    const disconnected: RemoteHostSnapshotDto = {
      ...connected,
      revision: 4,
      states: [{
        ...connected.states[0]!,
        status: 'offline',
        capabilities: [],
      }],
    };
    getSnapshot.mockResolvedValueOnce(connected).mockResolvedValue(disconnected);

    renderHook(() => useRemoteHostSnapshot());
    await act(async () => { await Promise.resolve(); });
    act(() => listener?.({ revision: 4, profileId: 'remote-a', reason: 'state' }));
    await act(async () => { await Promise.resolve(); });

    expect(connectRemoteHost).not.toHaveBeenCalled();
  });

  it('connects again after the user switches from Local back to Remote', async () => {
    const connected: RemoteHostSnapshotDto = {
      revision: 3,
      sourceMode: 'remote',
      selectedRemoteProfileId: 'remote-a',
      profiles: [],
      states: [{
        profileId: 'remote-a',
        status: 'connected',
        recovery: null,
        authoritativeCoreId: 'core-a',
        workerGeneration: 1,
        capabilities: ['teams'],
        eventRevision: 1,
        error: null,
      }],
    };
    const local: RemoteHostSnapshotDto = {
      ...connected,
      revision: 4,
      sourceMode: 'local',
      states: [{
        ...connected.states[0]!,
        status: 'offline',
        capabilities: [],
      }],
    };
    const remote = { ...local, revision: 5, sourceMode: 'remote' as const };
    const reconnected: RemoteHostSnapshotDto = { ...connected, revision: 6 };
    getSnapshot.mockResolvedValue(connected);
    connectRemoteHost.mockResolvedValue({
      ...reconnected,
      states: [{ ...connected.states[0]!, capabilities: ['teams', 'issues', 'usage'] }],
    });
    window.api.setRemoteHostSourceMode = vi.fn()
      .mockResolvedValueOnce(local)
      .mockResolvedValueOnce(remote);

    const hook = renderHook(() => useRemoteHostSnapshot());
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await hook.result.current.setSourceMode('local'); });
    await act(async () => { await hook.result.current.setSourceMode('remote'); });
    await act(async () => { await Promise.resolve(); });

    expect(connectRemoteHost).toHaveBeenCalledTimes(1);
    expect(connectRemoteHost).toHaveBeenCalledWith('remote-a');
  });

  it('surfaces one startup connection error without entering a retry loop', async () => {
    const remote: RemoteHostSnapshotDto = {
      revision: 3,
      sourceMode: 'remote',
      selectedRemoteProfileId: 'remote-a',
      profiles: [],
      states: [{
        profileId: 'remote-a',
        status: 'offline',
        recovery: null,
        authoritativeCoreId: null,
        workerGeneration: null,
        capabilities: [],
        eventRevision: 0,
        error: null,
      }],
    };
    getSnapshot.mockResolvedValue(remote);
    connectRemoteHost.mockRejectedValue(new Error('远程执行节点当前离线。'));

    const hook = renderHook(() => useRemoteHostSnapshot());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => listener?.({ revision: 4, profileId: 'remote-a', reason: 'state' }));
    await act(async () => { await Promise.resolve(); });

    expect(connectRemoteHost).toHaveBeenCalledTimes(1);
    expect(hook.result.current.error).toBe('远程执行节点当前离线。');
  });

  it('does not surface a stale connection failure after switching back to Local', async () => {
    const remote: RemoteHostSnapshotDto = {
      revision: 3,
      sourceMode: 'remote',
      selectedRemoteProfileId: 'remote-a',
      profiles: [],
      states: [{
        profileId: 'remote-a',
        status: 'offline',
        recovery: null,
        authoritativeCoreId: null,
        workerGeneration: null,
        capabilities: [],
        eventRevision: 0,
        error: null,
      }],
    };
    const local = { ...remote, revision: 4, sourceMode: 'local' as const };
    let rejectConnect!: (reason: unknown) => void;
    connectRemoteHost.mockReturnValue(new Promise((_resolve, reject) => {
      rejectConnect = reject;
    }));
    getSnapshot.mockResolvedValue(remote);
    window.api.setRemoteHostSourceMode = vi.fn().mockResolvedValue(local);

    const hook = renderHook(() => useRemoteHostSnapshot());
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await hook.result.current.setSourceMode('local'); });
    await act(async () => {
      rejectConnect(new Error('当前主机已切换，请重试。'));
      await Promise.resolve();
    });

    expect(hook.result.current.error).toBeNull();
  });
});
