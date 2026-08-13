// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SessionDetail } from '@renderer/components/SessionDetail';
import { registerBuiltinDiffRenderers } from '@renderer/components/diff/install';
import { FAST_ASYNC_FALLBACK_GRACE_MS } from '@renderer/hooks/useDelayedAsyncFallback';
import { remoteSource } from './session-detail-source-shell-test-fixture';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});
beforeAll(registerBuiltinDiffRenderers);

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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

    expect(screen.getByRole('button', { name: '改动' }).getAttribute('title'))
      .toBe('当前版本暂不支持查看改动。');
    expect(localFileChanges).not.toHaveBeenCalled();
  });

  it('hides the old detail and every action while a new session identity is loading', () => {
    const source = remoteSource();
    render(<SessionDetail
      remoteSource={{ ...source, selectedSessionId: 'next-session' }}
      onClose={vi.fn()}
    />);

    expect(screen.getByText('正在读取远程会话…')).toBeTruthy();
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
    expect(await screen.findByText('Codex 当前生效配置')).toBeTruthy();
    expect(screen.getByText('工作区可写')).toBeTruthy();
    expect(screen.getByText('使用当前运行设置')).toBeTruthy();
    expect(scanLocalPermissions).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('auth.json');
    expect(document.body.textContent).not.toContain('/Users/');
  });

  it('keeps the current Remote tab during the grace period, then shows permission loading', async () => {
    vi.useFakeTimers();
    const pending = deferred<Awaited<ReturnType<
      typeof window.api.getRemoteHostSessionPermissions
    >>>();
    const getRemotePermissions = vi.fn(() => pending.promise);
    window.api = {
      getRemoteHostSessionPermissions: getRemotePermissions,
    } as unknown as typeof window.api;
    const source = remoteSource();
    source.capabilities = new Set([...source.capabilities, 'sessions.permissions.read']);
    render(<SessionDetail remoteSource={source} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    await act(async () => Promise.resolve());
    expect(getRemotePermissions).toHaveBeenCalledOnce();

    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(screen.getByText('remote-only activity')).toBeTruthy();
    expect(screen.queryByText('正在读取权限…')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText('正在读取权限…')).toBeTruthy();
    expect(screen.queryByText('remote-only activity')).toBeNull();

    await act(async () => pending.resolve({
      sessionId: 'same-session',
      adapterId: 'codex-cli',
      effective: {
        adapterId: 'codex-cli', approvalPolicy: 'on-request',
        approvalPolicySource: 'session', sandbox: 'workspace-write', sandboxSource: 'session',
      },
      workspace: { read: 'allowed', write: 'allowed', network: 'provider-default' },
      rules: { state: 'unavailable', items: [], omittedCount: 0, truncated: false },
      revision: 12,
    }));
    expect(screen.getByText('Codex 当前生效配置')).toBeTruthy();
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
    expect(screen.getByText('当前版本暂不支持查看权限。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '跨会话' }));
    expect(screen.getByText('当前版本暂不支持查看跨会话消息。')).toBeTruthy();
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
  });

  it('does not reuse a permission projection after same-identity reconnect', async () => {
    const oldResult = deferred<Awaited<ReturnType<
      typeof window.api.getRemoteHostSessionPermissions
    >>>();
    const fresh = {
      sessionId: 'same-session',
      adapterId: 'codex-cli' as const,
      effective: {
        adapterId: 'codex-cli' as const,
        approvalPolicy: 'on-request' as const,
        approvalPolicySource: 'session' as const,
        sandbox: 'workspace-write' as const,
        sandboxSource: 'session' as const,
      },
      workspace: { read: 'allowed' as const, write: 'allowed' as const,
        network: 'provider-default' as const },
      rules: { state: 'unavailable' as const, items: [], omittedCount: 0,
        truncated: false },
      revision: 2,
    };
    const getPermissions = vi.fn()
      .mockReturnValueOnce(oldResult.promise)
      .mockResolvedValueOnce(fresh);
    window.api = {
      getRemoteHostSessionPermissions: getPermissions,
    } as unknown as typeof window.api;
    const connected = remoteSource();
    connected.capabilities = new Set([
      ...connected.capabilities,
      'sessions.permissions.read',
    ]);
    const rendered = render(<SessionDetail remoteSource={connected} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    await waitFor(() => expect(getPermissions).toHaveBeenCalledOnce());

    rendered.rerender(<SessionDetail
      remoteSource={{
        ...connected,
        usable: false,
        selectedSession: null,
        state: { ...connected.state!, status: 'reconnecting' },
      }}
      onClose={vi.fn()}
    />);
    expect(screen.queryByText('Codex 当前生效配置')).toBeNull();

    rendered.rerender(<SessionDetail remoteSource={connected} onClose={vi.fn()} />);
    expect(screen.getByText('remote-only activity')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    await screen.findByText('Codex 当前生效配置');
    expect(getPermissions).toHaveBeenCalledTimes(2);

    await act(async () => oldResult.resolve({
      ...fresh,
      effective: { ...fresh.effective, sandbox: 'read-only' },
      revision: 1,
    }));
    expect(screen.getByText('工作区可写')).toBeTruthy();
  });

  it('renders a precise reconnecting detail shell with all session actions absent', () => {
    const source = remoteSource();
    source.usable = false;
    source.selectedSession = null;
    source.state = { ...source.state!, status: 'reconnecting' };
    render(<SessionDetail remoteSource={source} onClose={vi.fn()} />);

    expect(screen.getByText('正在重新连接')).toBeTruthy();
    expect(screen.getByText('连接恢复后会自动重新读取当前会话。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
    expect(screen.queryByRole('button', { name: '接力' })).toBeNull();
  });
});
