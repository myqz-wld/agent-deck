// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SessionDetail } from '@renderer/components/SessionDetail';
import { registerBuiltinDiffRenderers } from '@renderer/components/diff/install';
import { legacyRemoteSessionPresentation } from './session-summary-presentation';
import type { RemoteSessionSourceView } from './source-types';

afterEach(cleanup);
beforeAll(registerBuiltinDiffRenderers);

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function remoteSource(): RemoteSessionSourceView {
  const session = {
    id: 'same-session',
    adapterId: 'codex-cli',
    title: 'Remote session',
    status: 'active-idle',
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
    resourceRevisions: {
      'session-list': 0, 'session-detail': 0, pending: 0, teams: 0,
      issues: 0, usage: 0, 'node-configuration': 0, 'node-assets': 0,
    },
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
    historyQuery: '',
    historySessions: [],
    hasMoreHistorySessions: false,
    hasMoreSessions: false,
    identity: 'remote-a:core-a:1',
    loading: false,
    pendingBuckets: [],
    pendingBySession: new Map(),
    pendingLoading: false,
    pendingLoadError: null,
    pendingTotal: 0,
    pendingScanTruncated: false,
    hasMorePending: false,
    presentationCounts: null,
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
    sessions: [legacyRemoteSessionPresentation(session)],
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
    listOutgoing: vi.fn(async () => ({
      sessionId: 'remote-session', adapterId: 'codex-cli', messages: [], revision: 1,
    })),
    loadMorePending: vi.fn(),
    loadMoreSessions: vi.fn(),
    refresh: vi.fn(),
    respondPending: vi.fn(),
    removeOutgoing: vi.fn(async () => true),
    selectSession: vi.fn(),
    setHistoryQuery: vi.fn(),
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

    expect(screen.getByText('正在读取远程 session…')).toBeTruthy();
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

  it('loads only the path-free Remote Permissions projection when its tab is opened', async () => {
    const getRemotePermissions = vi.fn().mockResolvedValue({
      sessionId: 'same-session',
      adapterId: 'codex-cli',
      effective: {
        adapterId: 'codex-cli',
        approvalPolicy: 'on-request',
        approvalPolicySource: 'session',
        sandbox: 'workspace-write',
        sandboxSource: 'session',
      },
      workspace: { read: 'allowed', write: 'allowed', network: 'provider-default' },
      rules: { state: 'unavailable', items: [], omittedCount: 0, truncated: false },
      revision: 12,
    });
    const scanLocalPermissions = vi.fn();
    window.api = {
      getRemoteHostSessionPermissions: getRemotePermissions,
      scanPermissions: scanLocalPermissions,
      scanCodexPermissions: scanLocalPermissions,
    } as unknown as typeof window.api;
    const source = remoteSource();
    source.capabilities = new Set([...source.capabilities, 'sessions.permissions.read']);
    render(<SessionDetail remoteSource={source} onClose={vi.fn()} />);

    expect(getRemotePermissions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    await waitFor(() => expect(getRemotePermissions).toHaveBeenCalledWith({
      profileId: 'remote-a',
      sessionId: 'same-session',
      adapterId: 'codex-cli',
    }));
    expect(screen.getByText('Codex CLI 当前生效权限')).toBeTruthy();
    expect(screen.getByText('工作区可写')).toBeTruthy();
    expect(screen.getByText('由提供方默认值决定')).toBeTruthy();
    expect(scanLocalPermissions).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('auth.json');
    expect(document.body.textContent).not.toContain('/Users/');
  });

  it('loads bounded Remote cross-session messages lazily through the shared presentation', async () => {
    const listRemoteMessages = vi.fn().mockResolvedValue({
      sessionId: 'same-session',
      messages: [{
        id: 'message-1', teamId: null,
        fromSessionId: 'peer-session', fromTitle: '远程协作者',
        toSessionId: 'same-session', toTitle: 'Remote session',
        body: '远程投影消息', status: 'delivered', statusReason: null,
        sentAt: 10, deliveredAt: 11, replyToMessageId: null,
      }],
      truncated: false,
      revision: 12,
    });
    const listLocalMessages = vi.fn();
    window.api = {
      listRemoteHostSessionMessages: listRemoteMessages,
      listAgentDeckMessagesBySession: listLocalMessages,
    } as unknown as typeof window.api;
    const source = remoteSource();
    source.capabilities = new Set([...source.capabilities, 'sessions.messages.read']);
    render(<SessionDetail remoteSource={source} onClose={vi.fn()} />);

    expect(listRemoteMessages).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '跨会话' }));
    await screen.findByText('远程投影消息');
    expect(listRemoteMessages).toHaveBeenCalledWith({
      profileId: 'remote-a', sessionId: 'same-session', limit: 100,
    });
    expect(screen.getByText('远程协作者')).toBeTruthy();
    expect(listLocalMessages).not.toHaveBeenCalled();
  });

  it('keeps old-Core metadata tabs explicit and makes no Remote or Local fallback request', () => {
    const getRemotePermissions = vi.fn();
    const listRemoteMessages = vi.fn();
    const localFallback = vi.fn();
    window.api = {
      getRemoteHostSessionPermissions: getRemotePermissions,
      listRemoteHostSessionMessages: listRemoteMessages,
      scanPermissions: localFallback,
      listAgentDeckMessagesBySession: localFallback,
    } as unknown as typeof window.api;
    render(<SessionDetail remoteSource={remoteSource()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    expect(screen.getByText(/未提供无路径、无配置原文的生效权限投影/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '跨会话' }));
    expect(screen.getByText(/不会回退读取本地消息数据库/)).toBeTruthy();
    expect(getRemotePermissions).not.toHaveBeenCalled();
    expect(listRemoteMessages).not.toHaveBeenCalled();
    expect(localFallback).not.toHaveBeenCalled();
  });

  it('drops a late Permissions projection after the Remote identity changes', async () => {
    const oldResult = deferred<Awaited<ReturnType<
      typeof window.api.getRemoteHostSessionPermissions
    >>>();
    const result = (profileId: string, sandbox: 'read-only' | 'workspace-write') => ({
      sessionId: 'same-session',
      adapterId: 'codex-cli' as const,
      effective: {
        adapterId: 'codex-cli' as const,
        approvalPolicy: 'on-request' as const,
        approvalPolicySource: 'session' as const,
        sandbox,
        sandboxSource: 'session' as const,
      },
      workspace: { read: 'allowed' as const, write: 'allowed' as const, network: 'denied' as const },
      rules: { state: 'unavailable' as const, items: [], omittedCount: 0, truncated: false },
      revision: profileId === 'remote-a' ? 1 : 2,
    });
    const getPermissions = vi.fn((request: { profileId: string }) =>
      request.profileId === 'remote-a'
        ? oldResult.promise
        : Promise.resolve(result('remote-b', 'workspace-write')));
    window.api = {
      getRemoteHostSessionPermissions: getPermissions,
    } as unknown as typeof window.api;
    const sourceA = remoteSource();
    sourceA.capabilities = new Set([...sourceA.capabilities, 'sessions.permissions.read']);
    const rendered = render(<SessionDetail remoteSource={sourceA} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    await waitFor(() => expect(getPermissions).toHaveBeenCalledTimes(1));

    const sourceB = remoteSource();
    sourceB.identity = 'remote-b:core-b:2';
    sourceB.profile = { ...sourceB.profile!, id: 'remote-b', label: 'Backup Core' };
    sourceB.state = {
      ...sourceB.state!, profileId: 'remote-b', authoritativeCoreId: 'authoritative-b',
    };
    sourceB.selectedSession = { ...sourceB.selectedSession!, title: 'Remote B session' };
    sourceB.capabilities = new Set([...sourceB.capabilities, 'sessions.permissions.read']);
    rendered.rerender(<SessionDetail remoteSource={sourceB} onClose={vi.fn()} />);
    await screen.findByText('Remote B session');
    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    await screen.findByText('工作区可写');

    await act(async () => {
      oldResult.resolve(result('remote-a', 'read-only'));
      await oldResult.promise;
    });
    expect(screen.getByText('工作区可写')).toBeTruthy();
    expect(screen.queryByText('只读')).toBeNull();
  });

  it('renders a precise reconnecting detail shell with all session actions absent', () => {
    const source = remoteSource();
    source.usable = false;
    source.selectedSession = null;
    source.state = { ...source.state!, status: 'reconnecting' };
    render(<SessionDetail remoteSource={source} onClose={vi.fn()} />);

    expect(screen.getByText('Remote SSH 正在重连')).toBeTruthy();
    expect(screen.getByText(/重新确认 Core 身份后才能读取此会话/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
    expect(screen.queryByRole('button', { name: '接力' })).toBeNull();
  });
});
