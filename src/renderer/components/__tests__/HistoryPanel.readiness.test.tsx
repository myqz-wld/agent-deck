// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteHostSessionPresentationDto } from '@shared/remote-host';
import type { SessionRecord } from '@shared/types';
import { FAST_ASYNC_FALLBACK_GRACE_MS } from '@renderer/hooks/useDelayedAsyncFallback';
import { source as remoteSource } from '@renderer/remote-host/remote-dialogs-test-fixture';
import { HistoryPanel } from '../HistoryPanel';

const localSession: SessionRecord = {
  id: 'local-history',
  agentId: 'codex-cli',
  cwd: '/workspace/project',
  title: 'Local history result',
  source: 'sdk',
  lifecycle: 'closed',
  activity: 'finished',
  startedAt: 1,
  lastEventAt: 2,
  endedAt: 2,
  archivedAt: null,
  model: null,
  thinking: null,
};

const remoteSession: RemoteHostSessionPresentationDto = {
  id: 'remote-history', adapterId: 'codex-cli', title: 'Remote history result', source: 'sdk',
  lifecycle: 'closed', activity: 'finished', archived: false, pinned: false,
  createdAt: 1, updatedAt: 2, endedAt: 2, model: null, thinking: null,
  runtimeProvider: null, context: null, spawnedBy: null, spawnDepth: 0, teams: [],
  summary: null, summaryGenerationSource: null, workspaceLabel: 'Workspace', contextOnly: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function installLocalApi(listSessionHistory: Window['api']['listSessionHistory']): void {
  const off = vi.fn();
  window.api = {
    listSessionHistory,
    onSessionRenamed: vi.fn(() => off),
    onSessionUpserted: vi.fn(() => off),
  } as unknown as Window['api'];
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  Reflect.deleteProperty(window, 'api');
});

describe('HistoryPanel 150 ms presentation readiness', () => {
  it('reveals a fast Local result directly without flashing empty or loading copy', async () => {
    const request = deferred<SessionRecord[]>();
    installLocalApi(vi.fn(() => request.promise));
    render(<HistoryPanel onSelect={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.queryByText('加载中…')).toBeNull();
    expect(screen.queryByText('没有匹配结果')).toBeNull();

    await act(async () => {
      request.resolve([localSession]);
      await request.promise;
    });

    expect(screen.getByText('Local history result')).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();
  });

  it('shows the Local initial loading fallback only at the shared 150 ms boundary', async () => {
    const request = deferred<SessionRecord[]>();
    const onPresentationReadyChange = vi.fn();
    installLocalApi(vi.fn(() => request.promise));
    render(<HistoryPanel
      onSelect={vi.fn()}
      onPresentationReadyChange={onPresentationReadyChange}
    />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(onPresentationReadyChange).toHaveBeenLastCalledWith(false);

    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(screen.queryByText('加载中…')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText('加载中…')).toBeTruthy();
    expect(onPresentationReadyChange).toHaveBeenLastCalledWith(true);
  });

  it('retains settled Local rows and delays refresh progress without enabling stale actions', async () => {
    const refresh = deferred<SessionRecord[]>();
    const list = vi.fn()
      .mockResolvedValueOnce([localSession])
      .mockReturnValueOnce(refresh.promise);
    installLocalApi(list);
    render(<HistoryPanel onSelect={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.getByText('Local history result')).toBeTruthy();
    const progress = screen.getByText('刷新中…');
    expect(progress.className).toContain('invisible');

    fireEvent.change(screen.getByPlaceholderText('搜索标题、工作区、事件或总结…'), {
      target: { value: 'needle' },
    });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Local history result')).toBeTruthy();
    expect(screen.getByText('Local history result').closest('[inert]')).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(progress.className).toContain('invisible');
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(progress.className).not.toContain('invisible');
    expect(screen.getByText('Local history result')).toBeTruthy();

    await act(async () => {
      refresh.resolve([]);
      await refresh.promise;
    });
    expect(screen.getByText('没有匹配结果')).toBeTruthy();
  });

  it('reactivates an unarchived closed Local history row from its action menu', async () => {
    const list = vi.fn().mockResolvedValue([localSession]);
    const reactivateSession = vi.fn(async () => undefined);
    installLocalApi(list);
    window.api.reactivateSession = reactivateSession;
    render(<HistoryPanel onSelect={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.contextMenu(screen.getByText('Local history result'), {
      clientX: 120,
      clientY: 80,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '重新激活' }));
    await act(async () => { await Promise.resolve(); });

    expect(reactivateSession).toHaveBeenCalledWith('local-history');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('uses the same initial boundary for an unresolved Remote History page', async () => {
    const initial = {
      ...remoteSource(),
      capabilities: new Set(['sessions.presentation.read', 'sessions.history.write']),
      historyInitialized: false,
      historyLoading: true,
    };
    const view = render(<HistoryPanel remoteSource={initial} onSelect={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(screen.queryByText('加载中…')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText('加载中…')).toBeTruthy();

    view.rerender(<HistoryPanel
      remoteSource={{
        ...initial,
        historyInitialized: true,
        historyLoading: false,
        historySessions: [remoteSession],
      }}
      onSelect={vi.fn()}
    />);
    expect(screen.getByText('Remote history result')).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();
  });
});
