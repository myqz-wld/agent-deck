// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteHostSessionPageDto } from '@shared/remote-host';
import { useRemoteSessionSource } from './use-remote-session-source';
import { deferred, hosts, session } from './use-remote-session-source-test-fixture';

function page(profileId: string, archived: boolean): RemoteHostSessionPageDto {
  return {
    sessions: archived ? [] : [session('same-session', `${profileId} list`)],
    nextCursor: null,
    total: archived ? 0 : 1,
    revision: 1,
  };
}

beforeEach(() => {
  window.api = {
    listRemoteHostSessions: vi.fn(async (request) => page(request.profileId, Boolean(request.includeArchived))),
    listRemoteHostPendingIndex: vi.fn(async () => ({
      buckets: [], nextCursor: null, totalBuckets: 0, totalRequests: 0,
      scanTruncated: false, revision: 1,
    })),
    listRemoteHostPending: vi.fn(async () => ({ requests: [], revision: 1 })),
    getRemoteHostSession: vi.fn(async (request) =>
      session(request.sessionId, `${request.profileId} detail`)),
    getRemoteHostRuntime: vi.fn(async () => ({
      adapterId: 'codex-cli', values: {}, revision: 1,
    })),
    getRemoteHostSessionContext: vi.fn(async () => ({ contextUsage: null, revision: 1 })),
    getRemoteHostSessionInputCapabilities: vi.fn(async () => ({
      adapterId: 'codex-cli',
      activeTurn: {
        mode: 'steer',
        attachments: {
          disabledReason: null,
          enabled: true,
          maxBytesEach: 2_097_152,
          maxBytesTotal: 2_097_152,
          maxCount: 4,
          mimeTypes: ['image/png'],
        },
      },
      revision: 1,
    })),
    listRemoteHostSummaries: vi.fn(async () => ({ summaries: [], revision: 1 })),
    listRemoteHostEvents: vi.fn(async () => ({ events: [], revision: 1, truncated: false })),
    sendRemoteHostMessage: vi.fn(async () => ({
      messageId: 'message-a', sequence: 1, revision: 2,
    })),
    updateRemoteHostRuntime: vi.fn(async () => ({
      controls: { adapterId: 'codex-cli', values: { model: 'next' }, revision: 2 },
      effect: 'hot-applied',
      replacementSessionId: null,
    })),
  } as unknown as typeof window.api;
});

afterEach(() => Reflect.deleteProperty(window, 'api'));

describe('useRemoteSessionSource isolated reads and intent identity', () => {
  it('reuses an ambiguous intent after navigating A to B and back to addressable A', async () => {
    const send = vi.mocked(window.api.sendRemoteHostMessage);
    send.mockRejectedValueOnce(new Error('deadline exceeded'));
    const hook = renderHook(
      ({ value }) => useRemoteSessionSource(value),
      { initialProps: { value: hosts('remote-a', 1) } },
    );
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('same-session'));
    await waitFor(() => expect(hook.result.current.selectedSession).not.toBeNull());
    await act(async () => {
      await expect(hook.result.current.send('same text')).rejects.toThrow('deadline exceeded');
    });

    hook.rerender({ value: hosts('remote-b', 2) });
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-b list'));
    hook.rerender({ value: hosts('remote-a', 3) });
    await waitFor(() => expect(hook.result.current.selectedSessionId).toBe('same-session'));
    await act(async () => { await hook.result.current.send('same text'); });

    expect(send.mock.calls[0]![0].intentId).toBe(send.mock.calls[1]![0].intentId);
  });

  it('publishes the required session before a slow optional summary read settles', async () => {
    const summary = deferred<{ summaries: []; revision: number }>();
    vi.mocked(window.api.listRemoteHostSummaries).mockReturnValue(summary.promise);
    const current = hosts('remote-a', 1);
    current.snapshot!.states[0]!.capabilities.push('sessions.summaries.read');
    const hook = renderHook(() => useRemoteSessionSource(current));
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('same-session'));

    await waitFor(() => expect(hook.result.current.selectedSession?.title)
      .toBe('remote-a detail'));
    expect(hook.result.current.summaries).toBeNull();
    act(() => summary.resolve({ summaries: [], revision: 2 }));
    await waitFor(() => expect(hook.result.current.summaries).toEqual({ summaries: [], revision: 2 }));
  });

  it('publishes Live sessions while a History read remains pending or fails', async () => {
    const history = deferred<RemoteHostSessionPageDto>();
    vi.mocked(window.api.listRemoteHostSessions).mockImplementation((request) =>
      request.includeArchived ? history.promise : Promise.resolve(page(request.profileId, false)));
    const hook = renderHook(() => useRemoteSessionSource(hosts('remote-a', 1)));

    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-a list'));
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.historyLoading).toBe(true);
    act(() => history.reject(new Error('history unavailable')));
    await waitFor(() => expect(hook.result.current.historyLoadError).toBe('history unavailable'));
    expect(hook.result.current.sessions).toHaveLength(1);
  });

  it('uses the latest runtime revision and follows a Worker-controlled replacement session', async () => {
    vi.mocked(window.api.updateRemoteHostRuntime).mockResolvedValueOnce({
      controls: { adapterId: 'codex-cli', values: { model: 'replacement' }, revision: 2 },
      effect: 'restart-required',
      replacementSessionId: 'successor-session',
    });
    const hook = renderHook(() => useRemoteSessionSource(hosts('remote-a', 1)));
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('same-session'));
    await waitFor(() => expect(hook.result.current.runtime?.revision).toBe(1));

    await act(async () => { await hook.result.current.updateRuntime({ codexSandbox: 'read-only' }); });

    expect(window.api.updateRemoteHostRuntime).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'remote-a',
      sessionId: 'same-session',
      expectedRevision: 1,
      patch: { codexSandbox: 'read-only' },
    }));
    expect(hook.result.current.selectedSessionId).toBe('successor-session');
  });

  it('identity-fences context and active-input snapshots across Remote Cores', async () => {
    const oldContext = deferred<{ contextUsage: null; revision: number }>();
    const oldInput = deferred<Awaited<ReturnType<
      typeof window.api.getRemoteHostSessionInputCapabilities
    >>>();
    vi.mocked(window.api.getRemoteHostSessionContext).mockImplementation((request) =>
      request.profileId === 'remote-a'
        ? oldContext.promise
        : Promise.resolve({
            contextUsage: {
              usedTokens: 22,
              windowTokens: 100,
              updatedAt: 9,
              runtimeIdentity: null,
            },
            revision: 3,
          }));
    vi.mocked(window.api.getRemoteHostSessionInputCapabilities).mockImplementation((request) =>
      request.profileId === 'remote-a'
        ? oldInput.promise
        : Promise.resolve({
            adapterId: 'codex-cli',
            activeTurn: {
              mode: 'steer',
              attachments: {
                disabledReason: 'new Core policy',
                enabled: false,
                maxBytesEach: 2_097_152,
                maxBytesTotal: 2_097_152,
                maxCount: 4,
                mimeTypes: ['image/png'],
              },
            },
            revision: 3,
          }));
    const remoteA = hosts('remote-a', 1);
    remoteA.snapshot!.states[0]!.capabilities.push(
      'sessions.context.read',
      'sessions.input.read',
    );
    const hook = renderHook(
      ({ value }) => useRemoteSessionSource(value),
      { initialProps: { value: remoteA } },
    );
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('same-session'));
    await waitFor(() => expect(window.api.getRemoteHostSessionContext).toHaveBeenCalled());

    const remoteB = hosts('remote-b', 2);
    remoteB.snapshot!.states[1]!.capabilities.push(
      'sessions.context.read',
      'sessions.input.read',
    );
    hook.rerender({ value: remoteB });
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-b list'));
    act(() => hook.result.current.selectSession('same-session'));
    await waitFor(() => expect(hook.result.current.context?.contextUsage?.usedTokens).toBe(22));
    expect(hook.result.current.inputCapabilities?.activeTurn.attachments.enabled).toBe(false);

    oldContext.resolve({ contextUsage: null, revision: 2 });
    oldInput.resolve({
      adapterId: 'codex-cli',
      activeTurn: {
        mode: 'steer',
        attachments: {
          disabledReason: null,
          enabled: true,
          maxBytesEach: 2_097_152,
          maxBytesTotal: 2_097_152,
          maxCount: 4,
          mimeTypes: ['image/png'],
        },
      },
      revision: 2,
    });
    await act(async () => { await Promise.all([oldContext.promise, oldInput.promise]); });
    expect(hook.result.current.context?.contextUsage?.usedTokens).toBe(22);
    expect(hook.result.current.inputCapabilities?.activeTurn.attachments.enabled).toBe(false);
  });
});
