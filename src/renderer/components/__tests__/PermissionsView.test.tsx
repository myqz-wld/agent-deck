// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CodexPermissionScanResult, PermissionScanResult } from '@shared/types';

vi.mock('../permissions/CodexPermissionsPanel', () => ({
  CodexPermissionsPanel: ({ data, loading, onRefresh }: {
    data: { marker?: string };
    loading: boolean;
    onRefresh: () => void;
  }) => (
    <div>
      <span>{`codex:${data.marker ?? 'unknown'}:${loading ? 'loading' : 'idle'}`}</span>
      <button type="button" onClick={onRefresh}>codex-refresh</button>
    </div>
  ),
}));

vi.mock('../permissions/ClaudePermissionsPanels', () => ({
  MergedPanel: ({ merged }: { merged: { marker?: string } }) => (
    <div>{`claude:${merged.marker ?? 'unknown'}`}</div>
  ),
  LayerPanel: () => null,
}));

import { PermissionsView } from '../PermissionsView';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function claudeScan(marker: string): PermissionScanResult {
  return {
    cwdResolved: `/repo/${marker}`,
    merged: { marker },
    user: { path: `/user/${marker}` },
    userLocal: { path: `/user-local/${marker}` },
    project: { path: `/project/${marker}` },
    local: { path: `/local/${marker}` },
  } as unknown as PermissionScanResult;
}

function codexScan(marker: string): CodexPermissionScanResult {
  return { marker } as unknown as CodexPermissionScanResult;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('PermissionsView adapter routing', () => {
  it('renders ACP-native Grok controls without scanning Claude or Codex settings', async () => {
    const scanCwdSettings = vi.fn();
    const scanCodexSettings = vi.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { scanCwdSettings, scanCodexSettings },
    });

    render(
      <PermissionsView
        cwd="/repo"
        sessionId="grok-session"
        agentId="grok-build"
        sessionMode="plan"
      />,
    );

    expect(screen.getByText('Grok Build 当前运行权限')).toBeTruthy();
    expect(screen.getByText('计划模式')).toBeTruthy();
    expect(screen.getByText(/ACP 运行时请求/)).toBeTruthy();
    expect(screen.getByText(/提供方原生控制/)).toBeTruthy();
    expect(screen.getByText(/不读取 Claude Code settings\.json/)).toBeTruthy();
    await waitFor(() => {
      expect(scanCwdSettings).not.toHaveBeenCalled();
      expect(scanCodexSettings).not.toHaveBeenCalled();
    });
  });

  it('ignores a deferred scan from the prior adapter/session/cwd props', async () => {
    const oldScan = deferred<PermissionScanResult>();
    const newScan = deferred<CodexPermissionScanResult>();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        scanCwdSettings: vi.fn(() => oldScan.promise),
        scanCodexSettings: vi.fn(() => newScan.promise),
      } as unknown as Window['api'],
    });

    const view = render(
      <PermissionsView cwd="/repo/a" sessionId="session-a" agentId="claude-code" />,
    );
    view.rerender(
      <PermissionsView cwd="/repo/b" sessionId="session-b" agentId="codex-cli" />,
    );

    await act(async () => newScan.resolve(codexScan('new')));
    expect(screen.getByText('codex:new:idle')).toBeTruthy();

    await act(async () => oldScan.resolve(claudeScan('stale')));
    expect(screen.getByText('codex:new:idle')).toBeTruthy();
    expect(screen.queryByText('claude:stale')).toBeNull();
  });

  it('keeps loading while a newer overlapping manual refresh is pending', async () => {
    const older = deferred<CodexPermissionScanResult>();
    const newer = deferred<CodexPermissionScanResult>();
    const scanCodexSettings = vi.fn()
      .mockResolvedValueOnce(codexScan('initial'))
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { scanCwdSettings: vi.fn(), scanCodexSettings } as unknown as Window['api'],
    });
    render(<PermissionsView cwd="/repo" sessionId="session" agentId="codex-cli" />);
    await screen.findByText('codex:initial:idle');

    fireEvent.click(screen.getByRole('button', { name: 'codex-refresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'codex-refresh' }));
    await act(async () => older.resolve(codexScan('stale')));
    expect(screen.getByText('codex:initial:loading')).toBeTruthy();

    await act(async () => newer.resolve(codexScan('newest')));
    expect(screen.getByText('codex:newest:idle')).toBeTruthy();
  });

  it('does not let a stale manual-refresh error replace a newer success', async () => {
    const older = deferred<CodexPermissionScanResult>();
    const newer = deferred<CodexPermissionScanResult>();
    const scanCodexSettings = vi.fn()
      .mockResolvedValueOnce(codexScan('initial'))
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { scanCwdSettings: vi.fn(), scanCodexSettings } as unknown as Window['api'],
    });
    render(<PermissionsView cwd="/repo" sessionId="session" agentId="codex-cli" />);
    await screen.findByText('codex:initial:idle');

    fireEvent.click(screen.getByRole('button', { name: 'codex-refresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'codex-refresh' }));
    await act(async () => newer.resolve(codexScan('newest')));
    await act(async () => older.reject(new Error('stale failure')));

    expect(screen.getByText('codex:newest:idle')).toBeTruthy();
    expect(screen.queryByText(/stale failure/)).toBeNull();
  });

  it('retains the last complete projection when a refresh fails', async () => {
    const refresh = deferred<CodexPermissionScanResult>();
    const scanCodexSettings = vi.fn()
      .mockResolvedValueOnce(codexScan('initial'))
      .mockReturnValueOnce(refresh.promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { scanCwdSettings: vi.fn(), scanCodexSettings } as unknown as Window['api'],
    });
    render(<PermissionsView cwd="/repo" sessionId="session" agentId="codex-cli" />);
    await screen.findByText('codex:initial:idle');

    fireEvent.click(screen.getByRole('button', { name: 'codex-refresh' }));
    expect(screen.getByText('codex:initial:loading')).toBeTruthy();
    await act(async () => refresh.reject(new Error('temporary failure')));

    expect(screen.getByText('codex:initial:idle')).toBeTruthy();
    expect(screen.getByText('扫描失败：temporary failure，当前显示上次结果。')).toBeTruthy();
  });

  it('offers a retry after the initial scan fails', async () => {
    const scanCodexSettings = vi.fn()
      .mockRejectedValueOnce(new Error('initial failure'))
      .mockResolvedValueOnce(codexScan('recovered'));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { scanCwdSettings: vi.fn(), scanCodexSettings } as unknown as Window['api'],
    });
    render(<PermissionsView cwd="/repo" sessionId="session" agentId="codex-cli" />);

    expect(await screen.findByText('扫描失败：initial failure')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('codex:recovered:idle')).toBeTruthy();
    expect(scanCodexSettings).toHaveBeenCalledTimes(2);
  });
});
