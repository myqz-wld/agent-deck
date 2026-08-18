// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SessionDetail } from '@renderer/components/SessionDetail';
import { registerBuiltinDiffRenderers } from '@renderer/components/diff/install';
import { remoteSource } from './session-detail-source-shell-test-fixture';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});
beforeAll(registerBuiltinDiffRenderers);

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

  it('does not expose the removed permissions page', () => {
    const source = remoteSource();
    render(<SessionDetail remoteSource={source} onClose={vi.fn()} />);

    for (const label of ['活动', '任务', '改动', '总结', '跨会话']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: '权限' })).toBeNull();
  });

  it('loads bounded Remote cross-session messages lazily through the shared presentation', async () => {
    const listRemoteMessages = vi.fn().mockResolvedValue({
      sessionId: 'same-session',
      messages: [{
        id: 'message-1', teamId: null,
        fromSessionId: 'peer-session', fromTitle: '远程协作者',
        toSessionId: 'same-session', toTitle: 'Remote session',
        body: '远程消息', status: 'delivered', statusReason: null,
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
    await screen.findByText('远程消息');
    expect(listRemoteMessages).toHaveBeenCalledWith({
      profileId: 'remote-a', sessionId: 'same-session', limit: 100,
    });
    expect(screen.getByText('远程协作者')).toBeTruthy();
    expect(listLocalMessages).not.toHaveBeenCalled();
  });

  it('keeps unsupported cross-session data explicit without local fallback', () => {
    const listRemoteMessages = vi.fn();
    const localFallback = vi.fn();
    window.api = {
      listRemoteHostSessionMessages: listRemoteMessages,
      listAgentDeckMessagesBySession: localFallback,
    } as unknown as typeof window.api;
    render(<SessionDetail remoteSource={remoteSource()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '跨会话' }));
    expect(screen.getByText('当前版本暂不支持查看跨会话消息。')).toBeTruthy();
    expect(listRemoteMessages).not.toHaveBeenCalled();
    expect(localFallback).not.toHaveBeenCalled();
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

  it('adds IAB after cross-session without auto-selecting and binds the Remote source', async () => {
    const source = remoteSource();
    const snapshot = {
      protocolVersion: 1 as const,
      source: {
        kind: 'remote' as const,
        profileId: 'remote-a',
        coreId: 'authoritative-a',
        generation: null,
        sessionId: 'same-session',
      },
      revision: 4,
      tabs: [
        { id: 1, title: 'First page', url: 'https://one.test', active: true, viewportRevision: 1 },
        { id: 2, title: 'Second page', url: 'https://two.test', active: false, viewportRevision: 1 },
      ],
    };
    const begin = vi.fn(async () => ({ leaseId: 'lease-1', source: snapshot.source, snapshot }));
    const update = vi.fn(async (request) => ({
      snapshot,
      appliedBounds: request.bounds,
    }));
    window.api = {
      getBrowserState: vi.fn(async () => snapshot),
      onBrowserStateChanged: vi.fn(() => () => undefined),
      beginBrowserPresentation: begin,
      updateBrowserPresentation: update,
      closeBrowserPresentationTab: vi.fn(async () => ({ snapshot, appliedBounds: null })),
      parkBrowserPresentation: vi.fn(async () => true),
    } as unknown as typeof window.api;
    const resizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect(): void {}
      unobserve(): void {}
    };
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 11, y: 123, width: 360, height: 420,
      top: 123, left: 11, right: 371, bottom: 543,
      toJSON: () => ({}),
    });

    try {
      render(<SessionDetail remoteSource={source} onClose={vi.fn()} />);
      const iab = await screen.findByRole('button', { name: 'IAB' });
      const messages = screen.getByRole('button', { name: '跨会话' });
      expect(messages.compareDocumentPosition(iab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByText('remote-only activity')).toBeTruthy();
      expect(begin).not.toHaveBeenCalled();

      fireEvent.click(iab);
      await waitFor(() => expect(begin).toHaveBeenCalledWith({
        source: snapshot.source,
        expectedRevision: 4,
      }));
      expect(screen.getByRole('button', { name: '关闭 First page' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '关闭 Second page' })).toBeTruthy();
      await waitFor(() => expect(update).toHaveBeenCalledWith({
        leaseId: 'lease-1',
        tabId: 1,
        bounds: { x: 11, y: 123, width: 360, height: 420 },
      }));
      fireEvent.click(screen.getByRole('button', { name: 'Second page' }));
      await waitFor(() => expect(update).toHaveBeenCalledWith({
        leaseId: 'lease-1',
        tabId: 2,
        bounds: { x: 11, y: 123, width: 360, height: 420 },
      }));
    } finally {
      rect.mockRestore();
      globalThis.ResizeObserver = resizeObserver;
    }
  });
});
