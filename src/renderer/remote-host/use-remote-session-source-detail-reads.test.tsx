// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPermissionPreviewDisplay } from '@contracts/index';
import type {
  RemoteHostSessionPresentationDto,
  RemoteHostSessionPresentationPageDto,
} from '@shared/remote-host';
import type { RemoteHostSnapshotState } from './use-remote-host-snapshot';
import { useRemoteSessionSource } from './use-remote-session-source';
import {
  deferred,
  hosts as fixtureHosts,
  session,
} from './use-remote-session-source-test-fixture';

function sessionPresentation(
  id: string,
  title: string,
  lifecycle: RemoteHostSessionPresentationDto['lifecycle'] = 'active',
  activity: RemoteHostSessionPresentationDto['activity'] = 'idle',
): RemoteHostSessionPresentationDto {
  return {
    id, adapterId: 'codex-cli', title, source: 'sdk', lifecycle, activity,
    archived: lifecycle === 'closed', pinned: false, createdAt: 1, updatedAt: 2,
    endedAt: lifecycle === 'closed' ? 2 : null, model: null, thinking: null,
    runtimeProvider: null, context: null, spawnedBy: null, spawnDepth: 0, teams: [],
    summary: null, summaryGenerationSource: null, workspaceLabel: null, contextOnly: false,
  };
}

function presentationPage(
  title: string,
  revision: number,
  kind: 'history' | 'live' = 'live',
): RemoteHostSessionPresentationPageDto {
  const sessions = kind === 'live' ? [sessionPresentation('same-session', title)] : [];
  return {
    sessions,
    nextCursor: null,
    counts: {
      total: sessions.length, active: sessions.length, dormant: 0, closed: 0,
      working: 0, waiting: 0,
    },
    contextTruncated: false,
    revision,
  };
}

function currentHosts(profileId: string | null, dataRevision: number): RemoteHostSnapshotState {
  const current = fixtureHosts(profileId, dataRevision);
  if (!profileId || !current.snapshot) return current;
  current.snapshot.states = current.snapshot.states.map((state) => state.profileId === profileId
    ? {
        ...state,
        capabilities: [...new Set([
          ...state.capabilities,
          'sessions.input.read',
          'sessions.presentation.read',
        ])],
      }
    : state);
  return current;
}

describe('useRemoteSessionSource detail read fencing', () => {
  const oldDetail = deferred<ReturnType<typeof session>>();
  beforeEach(() => {
    window.api = {
      listRemoteHostSessionPresentations: vi.fn(async (request) =>
        presentationPage(`${request.profileId} list`, 1, request.kind)),
      listRemoteHostPending: vi.fn(async (request) => ({
        requests: [{
          id: 'same-request',
          sessionId: 'same-session',
          kind: 'permission',
          status: 'pending',
          createdAt: 1,
          expiresAt: null,
          display: createPermissionPreviewDisplay('Bash', {
            command: 'pwd', source: request.profileId,
          }),
        }],
        revision: request.profileId === 'remote-a' ? 10 : 20,
      })),
      listRemoteHostPendingIndex: vi.fn(async (request) => {
        const revision = request.profileId === 'remote-a' ? 10 : 20;
        return {
          buckets: [{
            session: sessionPresentation('same-session', `${request.profileId} list`),
            pending: {
              requests: [{
                id: 'same-request', sessionId: 'same-session', kind: 'permission',
                status: 'pending', createdAt: 1, expiresAt: null,
                display: createPermissionPreviewDisplay('Bash', {
                  command: 'pwd', source: request.profileId,
                }),
              }],
              revision,
            },
          }],
          nextCursor: null,
          totalBuckets: 1,
          totalRequests: 1,
          scanTruncated: false,
          revision,
        };
      }),
      getRemoteHostSession: vi.fn((request) => request.profileId === 'remote-a'
        ? oldDetail.promise
        : Promise.resolve({
            id: 'same-session',
            adapterId: 'codex-cli',
            title: 'remote-b detail',
            status: 'active-idle',
            createdAt: 1,
            updatedAt: 3,
          })),
      listRemoteHostEvents: vi.fn(async () => ({
        events: [], revision: 1, truncated: false,
      })),
      getRemoteHostRuntime: vi.fn(async () => ({
        adapterId: 'codex-cli', values: {}, revision: 1,
      })),
      getRemoteHostSessionInputCapabilities: vi.fn(async () => ({
        adapterId: 'codex-cli',
        activeTurn: {
          mode: 'steer',
          attachments: {
            disabledReason: 'test fixture has no active attachment input',
            enabled: false,
            maxBytesEach: 2_097_152,
            maxBytesTotal: 8_388_608,
            maxCount: 4,
            mimeTypes: ['image/png'],
          },
        },
        commands: [],
        revision: 1,
      })),
      listRemoteHostSummaries: vi.fn(async () => ({ summaries: [], revision: 1 })),
      listRemoteHostTasks: vi.fn(async () => ({ tasks: [], revision: 1 })),
      listRemoteHostFileChanges: vi.fn(async () => ({
        items: [], nextCursor: null, revision: 1,
      })),
      getRemoteHostFileChange: vi.fn(async () => ({ change: null, revision: 1 })),
      getRemoteHostFileFinalDiff: vi.fn(async (request) => ({
        fileDiff: {
          ok: false,
          filePath: request.filePath,
          diff: null,
          source: 'recorded-snapshot',
          reason: 'unchanged',
        },
        revision: 1,
      })),
      loadRemoteHostImageAsset: vi.fn(async () => ({
        ok: true, dataUrl: 'data:image/png;base64,YQ==', mime: 'image/png', bytes: 1,
      })),
      getRemoteHostSessionCapabilities: vi.fn(),
      listRemoteHostWorkspaceDirectories: vi.fn(),
      sendRemoteHostMessage: vi.fn(async () => ({
        messageId: 'message-a', sequence: 1, revision: 2,
      })),
      respondRemoteHostPending: vi.fn(async () => ({ revision: 11 })),
    } as unknown as typeof window.api;
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'api');
  });

  it('loads event/summary/task state and fences on-demand file reads to the current source', async () => {
    const sourceHosts = currentHosts('remote-b', 1);
    sourceHosts.snapshot!.states = sourceHosts.snapshot!.states.map((current) =>
      current.profileId === 'remote-b'
        ? {
            ...current,
            capabilities: [
              ...current.capabilities,
              'sessions.summaries.read',
              'sessions.file-changes.read',
              'assets',
              'tasks',
            ],
          }
        : current);
    vi.mocked(window.api.listRemoteHostSummaries).mockResolvedValue({
      summaries: [{
        id: 1,
        sessionId: 'same-session',
        content: 'remote summary',
        trigger: 'time',
        ts: 2,
        sourceEventRevision: 1,
        sourceRebuildAfterRevision: 0,
        generationSource: 'llm',
      }],
      revision: 2,
    });
    vi.mocked(window.api.listRemoteHostTasks).mockResolvedValue({
      tasks: [{
        id: 'task-1', ownerSessionId: 'same-session', teamId: null,
        subject: 'remote task', description: null, status: 'active', activeForm: null,
        priority: 5, blocks: [], blockedBy: [], labels: [],
        createdAt: '2026-08-07T00:00:00.000Z',
        updatedAt: '2026-08-07T00:01:00.000Z',
      }],
      revision: 2,
    });
    vi.mocked(window.api.listRemoteHostEvents).mockResolvedValue({
      events: [{
        id: 7, sessionId: 'same-session', agentId: 'codex-cli', kind: 'message',
        payload: { role: 'assistant', text: 'remote event' }, ts: 2,
      }],
      revision: 2,
      truncated: false,
    });
    const hook = renderHook(() => useRemoteSessionSource(sourceHosts));
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('same-session'));
    await waitFor(() => expect(hook.result.current.summaries?.summaries[0]?.content)
      .toBe('remote summary'));
    await waitFor(() => expect(hook.result.current.tasks?.tasks[0]?.subject).toBe('remote task'));
    await waitFor(() => expect(hook.result.current.events?.events[0]?.id).toBe(7));
    expect(window.api.listRemoteHostEvents).toHaveBeenCalledWith({
      profileId: 'remote-b', sessionId: 'same-session', limit: 100,
    });

    await act(async () => { await hook.result.current.listFileChanges(); });
    await act(async () => { await hook.result.current.getFileChange(3); });
    await act(async () => { await hook.result.current.getFileFinalDiff('repo/src/index.ts'); });
    await act(async () => {
      await hook.result.current.loadImageBlob('same-session', {
        kind: 'remote-file-change', changeId: 3, side: 'after',
      });
    });
    expect(window.api.listRemoteHostFileChanges).toHaveBeenCalledWith({
      profileId: 'remote-b', sessionId: 'same-session', limit: 40,
    });
    expect(window.api.getRemoteHostFileChange).toHaveBeenCalledWith({
      profileId: 'remote-b', sessionId: 'same-session', changeId: 3,
    });
    expect(window.api.getRemoteHostFileFinalDiff).toHaveBeenCalledWith({
      profileId: 'remote-b', sessionId: 'same-session', filePath: 'repo/src/index.ts',
    });
    expect(window.api.loadRemoteHostImageAsset).toHaveBeenCalledWith({
      profileId: 'remote-b', sessionId: 'same-session',
      source: { kind: 'remote-file-change', changeId: 3, side: 'after' },
    });
  });

  it('publishes the required session when an optional summary read fails', async () => {
    const sourceHosts = currentHosts('remote-b', 1);
    sourceHosts.snapshot!.states = sourceHosts.snapshot!.states.map((current) =>
      current.profileId === 'remote-b'
        ? { ...current, capabilities: [...current.capabilities, 'sessions.summaries.read'] }
        : current);
    vi.mocked(window.api.listRemoteHostSummaries).mockRejectedValue(
      new Error('summary unavailable'),
    );
    const hook = renderHook(() => useRemoteSessionSource(sourceHosts));
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('same-session'));

    await waitFor(() => expect(hook.result.current.selectedSession?.title)
      .toBe('remote-b detail'));
    expect(hook.result.current.summaries).toBeNull();
    expect(hook.result.current.summaryLoadError)
      .toBe('读取会话总结失败，请稍后重试。');
    expect(hook.result.current.error).not.toBe('summary unavailable');
  });

  it('starts a fresh detail read immediately after a same-identity reconnect', async () => {
    const staleSummary = deferred<Awaited<ReturnType<
      typeof window.api.listRemoteHostSummaries
    >>>();
    let summaryLoads = 0;
    vi.mocked(window.api.listRemoteHostSummaries).mockImplementation(() => {
      summaryLoads += 1;
      return summaryLoads === 1
        ? staleSummary.promise
        : Promise.resolve({
            summaries: [{
              id: 2,
              sessionId: 'same-session',
              content: 'fresh summary',
              trigger: 'time',
              ts: 3,
              sourceEventRevision: 2,
              sourceRebuildAfterRevision: 0,
              generationSource: 'llm',
            }],
            revision: 2,
          });
    });
    const withSummaries = (revision: number, status: 'connected' | 'reconnecting') => {
      const value = currentHosts('remote-b', revision);
      value.snapshot!.states = value.snapshot!.states.map((current) =>
        current.profileId === 'remote-b'
          ? {
              ...current,
              status,
              capabilities: [...current.capabilities, 'sessions.summaries.read'],
            }
          : current);
      return value;
    };
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: withSummaries(1, 'connected') } },
    );
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('same-session'));
    await waitFor(() => expect(summaryLoads).toBe(1));

    hook.rerender({ value: withSummaries(2, 'reconnecting') });
    expect(hook.result.current.selectedSession).toBeNull();
    hook.rerender({ value: withSummaries(3, 'connected') });

    await waitFor(() => expect(summaryLoads).toBe(2));
    await waitFor(() => expect(hook.result.current.summaries?.summaries[0]?.content)
      .toBe('fresh summary'));

    staleSummary.resolve({
      summaries: [{
        id: 1,
        sessionId: 'same-session',
        content: 'stale summary',
        trigger: 'time',
        ts: 2,
        sourceEventRevision: 1,
        sourceRebuildAfterRevision: 0,
        generationSource: 'llm',
      }],
      revision: 1,
    });
    await act(async () => { await staleSummary.promise; });
    expect(hook.result.current.summaries?.summaries[0]?.content).toBe('fresh summary');
  });
});
