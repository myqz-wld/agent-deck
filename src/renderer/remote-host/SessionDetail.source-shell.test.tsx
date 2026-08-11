// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SessionDetail } from '@renderer/components/SessionDetail';
import { registerBuiltinDiffRenderers } from '@renderer/components/diff/install';
import type { RemoteSessionSourceView } from './source-types';

afterEach(cleanup);
beforeAll(registerBuiltinDiffRenderers);

function remoteSource(): RemoteSessionSourceView {
  const session = {
    id: 'same-session',
    adapterId: 'codex-cli',
    title: 'Remote session',
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
  };
  return {
    busy: false,
    capabilities: new Set([
      'events.replay',
      'sessions.write',
      'pending.read',
      'pending.respond',
      'sessions.runtime.read',
      'sessions.runtime.write',
      'sessions.context.read',
    ]),
    dataRevision: 0,
    error: null,
    eventLoadError: null,
    events: {
      events: [{
        id: 1,
        sessionId: session.id,
        agentId: 'codex-cli',
        kind: 'message',
        payload: { role: 'assistant', text: 'remote-only activity' },
        ts: 2,
      }],
      revision: 2,
      truncated: false,
    },
    historySessions: [],
    hasMoreHistorySessions: false,
    hasMoreSessions: false,
    identity: 'remote-a:core-a:1',
    loading: false,
    pendingBySession: new Map(),
    profile: {
      id: 'remote-a',
      label: 'Production Core',
      scope: 'remote',
      endpoint: {
        hostname: 'core.example.test',
        port: 22,
        username: 'agentdeck',
        hostKeyFingerprint: 'SHA256:test',
      },
      credentials: { connectionCredentialConfigured: true },
    },
    recoveringWorker: false,
    context: {
      contextUsage: {
        usedTokens: 34_000,
        windowTokens: 100_000,
        updatedAt: 2,
        runtimeIdentity: {
          version: 1,
          runtimeKey: 'codex:openai:remote-model:default',
          adapter: 'codex-cli',
          runtimeProvider: 'openai',
          model: 'remote-model',
          capacityConfigFingerprint: 'default',
        },
      },
      revision: 3,
    },
    runtime: { adapterId: 'codex-cli', values: { model: 'remote-model' }, revision: 3 },
    summaries: null,
    taskLoadError: null,
    tasks: null,
    sessionTotal: 1,
    selectedPending: { requests: [], revision: 4 },
    selectedSession: session,
    selectedSessionId: session.id,
    sessions: [session],
    state: {
      profileId: 'remote-a',
      status: 'connected',
      recovery: null,
      authoritativeCoreId: 'authoritative-a',
      workerGeneration: null,
      capabilities: [],
      eventRevision: 2,
      error: null,
    },
    usable: true,
    clearError: vi.fn(),
    createSession: vi.fn(),
    getSessionCapabilities: vi.fn(),
    listWorkspaceDirectories: vi.fn(),
    listFileChanges: vi.fn(),
    getFileChange: vi.fn(),
    getFileFinalDiff: vi.fn(),
    loadImageBlob: vi.fn(async () => ({ ok: false as const, reason: 'unsupported_source' as const })),
    interrupt: vi.fn(),
    previewHandOff: vi.fn(),
    commitHandOff: vi.fn(),
    loadMoreHistorySessions: vi.fn(),
    loadMoreSessions: vi.fn(),
    refresh: vi.fn(),
    respondPending: vi.fn(),
    selectSession: vi.fn(),
    send: vi.fn(),
    steer: vi.fn(),
    updateRuntime: vi.fn(),
  };
}

describe('SessionDetail source shell', () => {
  it('renders Remote through the shared shell and never falls back to local-only APIs', () => {
    const localFileChanges = vi.fn();
    window.api = { getFileChanges: localFileChanges } as unknown as typeof window.api;
    render(<SessionDetail remoteSource={remoteSource()} onClose={vi.fn()} />);

    expect(document.querySelectorAll('[data-session-detail-shell]')).toHaveLength(1);
    expect(screen.getByText('Remote session')).toBeTruthy();
    expect(screen.getByText('remote-only activity')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '待处理' })).toBeNull();
    expect(screen.queryByRole('button', { name: '运行时' })).toBeNull();
    expect(screen.getByDisplayValue('remote-model')).toBeTruthy();
    expect(screen.getByLabelText('上下文窗口用量').textContent)
      .toContain('34K / 100K');

    fireEvent.click(screen.getByRole('button', { name: '改动' }));
    expect(screen.getByText(/不会回退读取本地工作区/)).toBeTruthy();
    expect(localFileChanges).not.toHaveBeenCalled();
  });

  it('hides the old detail and every action while a new session identity is loading', () => {
    const source = remoteSource();
    render(<SessionDetail
      remoteSource={{ ...source, selectedSessionId: 'next-session' }}
      onClose={vi.fn()}
    />);

    expect(screen.getAllByText('正在读取远程 session…')).toHaveLength(2);
    expect(screen.queryByText('Remote session')).toBeNull();
    expect(screen.queryByText('remote-only activity')).toBeNull();
    expect(screen.queryByText(/remote-model/)).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
  });

  it('renders Core-owned summaries and text diffs without calling Local file APIs', async () => {
    const source = remoteSource();
    source.capabilities = new Set([
      ...source.capabilities,
      'sessions.summaries.read',
      'sessions.file-changes.read',
    ]);
    source.summaries = {
      summaries: [{
        id: 1,
        sessionId: 'same-session',
        content: 'remote summary only',
        trigger: 'time',
        ts: 10,
        sourceEventRevision: 8,
        sourceRebuildAfterRevision: 0,
        generationSource: 'llm',
      }],
      revision: 9,
    };
    source.listFileChanges = vi.fn(async () => ({
      items: [{
        id: 3,
        sessionId: 'same-session',
        filePath: 'repo/src/index.ts',
        kind: 'text',
        toolCallId: null,
        hasBeforeBlob: true,
        hasAfterBlob: true,
        hasBeforeSnapshot: false,
        hasAfterSnapshot: false,
        ts: 11,
      }],
      nextCursor: null,
      revision: 9,
    }));
    source.getFileChange = vi.fn(async () => ({
      change: {
        id: 3,
        sessionId: 'same-session',
        filePath: 'repo/src/index.ts',
        kind: 'text',
        beforeBlob: 'old',
        afterBlob: 'new',
        beforeSnapshot: null,
        afterSnapshot: null,
        metadata: {},
        toolCallId: null,
        ts: 11,
      },
      revision: 9,
    }));
    const localFileChanges = vi.fn();
    window.api = { listFileChangePage: localFileChanges } as unknown as typeof window.api;
    render(<SessionDetail remoteSource={source} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '总结' }));
    expect(screen.getByText('remote summary only')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '改动' }));
    await waitFor(() => expect(source.listFileChanges).toHaveBeenCalledOnce());
    await waitFor(() => expect(source.getFileChange).toHaveBeenCalledWith(3));
    expect(screen.getByTitle('repo/src/index.ts（1 次改动）')).toBeTruthy();
    expect(localFileChanges).not.toHaveBeenCalled();
  });

  it('loads an image diff only through the Remote asset loader', async () => {
    const source = remoteSource();
    source.capabilities = new Set([
      ...source.capabilities, 'sessions.file-changes.read', 'assets',
    ]);
    source.listFileChanges = vi.fn(async () => ({
      items: [{
        id: 4, sessionId: 'same-session', filePath: 'repo/image.png', kind: 'image',
        toolCallId: null, hasBeforeBlob: false, hasAfterBlob: true,
        hasBeforeSnapshot: false, hasAfterSnapshot: false, ts: 12,
      }],
      nextCursor: null,
      revision: 10,
    }));
    source.getFileChange = vi.fn(async () => ({
      change: {
        id: 4, sessionId: 'same-session', filePath: 'repo/image.png', kind: 'image',
        beforeBlob: null,
        afterBlob: JSON.stringify({
          kind: 'remote-file-change', changeId: 4, side: 'after',
        }),
        beforeSnapshot: null, afterSnapshot: null, metadata: {}, toolCallId: null, ts: 12,
      },
      revision: 10,
    }));
    source.loadImageBlob = vi.fn(async () => ({
      ok: true as const, dataUrl: 'data:image/png;base64,YQ==', mime: 'image/png', bytes: 1,
    }));
    const localImageLoader = vi.fn();
    window.api = { loadImageBlob: localImageLoader } as unknown as typeof window.api;
    render(<SessionDetail remoteSource={source} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '改动' }));
    await waitFor(() => expect(source.getFileChange).toHaveBeenCalledWith(4));
    await waitFor(() => expect(source.loadImageBlob).toHaveBeenCalledWith(
      'same-session',
      { kind: 'remote-file-change', changeId: 4, side: 'after' },
    ));
    expect(localImageLoader).not.toHaveBeenCalled();
  });

  it('renders the shared task presentation from Remote Core data', () => {
    const source = remoteSource();
    source.capabilities = new Set([...source.capabilities, 'tasks']);
    source.tasks = {
      tasks: [{
        id: 'task-1', ownerSessionId: 'same-session', teamId: null,
        subject: '远程任务只读投影', description: null, status: 'active',
        activeForm: '正在验证远程任务', priority: 5, blocks: [], blockedBy: [], labels: ['remote'],
        createdAt: '2026-08-07T00:00:00.000Z',
        updatedAt: '2026-08-07T00:01:00.000Z',
      }],
      revision: 9,
    };
    render(<SessionDetail remoteSource={source} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '任务' }));
    expect(screen.getByText('远程任务只读投影')).toBeTruthy();
    expect(screen.getByText('正在验证远程任务')).toBeTruthy();
  });
});
