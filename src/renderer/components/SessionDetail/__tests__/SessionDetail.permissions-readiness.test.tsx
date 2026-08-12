// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAST_ASYNC_FALLBACK_GRACE_MS } from '@renderer/hooks/useDelayedAsyncFallback';
import type { PermissionScanResult, SessionRecord } from '@shared/types';

vi.mock('../../activity-feed', () => ({
  ActivityFeed: () => <div>activity-ready</div>,
  ActivityRecordsView: () => null,
}));

vi.mock('../../permissions/ClaudePermissionsPanels', () => ({
  MergedPanel: ({ merged }: { merged: { marker?: string } }) => (
    <div>{`claude:${merged.marker ?? 'unknown'}`}</div>
  ),
  LayerPanel: () => null,
}));

import { SessionDetail } from '..';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function session(): SessionRecord {
  return {
    id: 'session-a',
    agentId: 'claude-code',
    cwd: '/repo',
    title: 'Local session',
    source: 'cli',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: 2,
  };
}

function scan(): PermissionScanResult {
  return {
    cwdResolved: '/repo',
    merged: { marker: 'ready' },
    user: { path: '/user' },
    userLocal: { path: '/user-local' },
    project: { path: '/project' },
    local: { path: '/local' },
  } as unknown as PermissionScanResult;
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('Local SessionDetail permission readiness', () => {
  it('preloads permission files and switches tabs only after the initial scan settles', async () => {
    const pending = deferred<PermissionScanResult>();
    const scanCwdSettings = vi.fn(() => pending.promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSessionGitBranch: vi.fn().mockResolvedValue(null),
        scanCwdSettings,
      } as unknown as Window['api'],
    });

    render(<SessionDetail session={session()} onClose={vi.fn()} />);

    await waitFor(() => expect(scanCwdSettings).toHaveBeenCalledWith('/repo'));
    expect(screen.getByText('activity-ready')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    expect(screen.getByText('activity-ready')).toBeTruthy();
    expect(screen.queryByText('扫描中…')).toBeNull();

    await act(async () => pending.resolve(scan()));
    expect(await screen.findByText('claude:ready')).toBeTruthy();
    expect(screen.queryByText('activity-ready')).toBeNull();
  });

  it('shows the permission loading state only after the fast-read grace period expires', async () => {
    vi.useFakeTimers();
    const pending = deferred<PermissionScanResult>();
    const scanCwdSettings = vi.fn(() => pending.promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSessionGitBranch: vi.fn().mockResolvedValue(null),
        scanCwdSettings,
      } as unknown as Window['api'],
    });

    render(<SessionDetail session={session()} onClose={vi.fn()} />);
    await act(async () => Promise.resolve());
    expect(scanCwdSettings).toHaveBeenCalledWith('/repo');

    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(screen.getByText('activity-ready')).toBeTruthy();
    expect(screen.queryByText('扫描中…')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText('扫描中…')).toBeTruthy();
    expect(screen.queryByText('activity-ready')).toBeNull();

    await act(async () => pending.resolve(scan()));
    expect(screen.getByText('claude:ready')).toBeTruthy();
    expect(screen.queryByText('扫描中…')).toBeNull();
  });
});
