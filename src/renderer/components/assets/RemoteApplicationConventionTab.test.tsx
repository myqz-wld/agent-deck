// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FAST_ASYNC_FALLBACK_GRACE_MS } from '@renderer/hooks/useDelayedAsyncFallback';
import { RemoteApplicationConventionTab } from './RemoteApplicationConventionTab';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'api');
});

describe('RemoteApplicationConventionTab readiness', () => {
  it('restores a previously read adapter immediately while revalidating its document', async () => {
    const read = vi.fn(async ({ adapterId }: { adapterId: string }) => ({ adapterId, content: `# ${adapterId}`, revision: 1 }));
    window.api = { getRemoteHostNodeAssetConvention: read } as unknown as Window['api'];
    render(<RemoteApplicationConventionTab catalogRevision={1} identity="remote-a:1"
      label="Remote A" profileId="remote-a" onCatalogChanged={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole('button', { name: 'Codex CLI' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByDisplayValue('# codex-cli')).toBeTruthy();
    read.mockReturnValue(new Promise(() => undefined));
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    expect(screen.getByDisplayValue('# claude-code')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(screen.getByDisplayValue('# claude-code')).toBeTruthy();
    expect(screen.queryByText('正在读取应用约定…')).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('delays its initial loading copy until 150 ms', async () => {
    const request = deferred<{
      adapterId: 'claude-code';
      content: string;
      revision: number;
    }>();
    window.api = {
      getRemoteHostNodeAssetConvention: vi.fn(() => request.promise),
    } as unknown as Window['api'];
    render(<RemoteApplicationConventionTab
      catalogRevision={1}
      identity="remote-a:1"
      label="Remote A"
      profileId="remote-a"
      onCatalogChanged={vi.fn()}
    />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.queryByText('正在读取应用约定…')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(screen.queryByText('正在读取应用约定…')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText('正在读取应用约定…')).toBeTruthy();
  });

  it('retains the settled adapter projection for 149 ms during a slow switch', async () => {
    const codex = deferred<{
      adapterId: 'codex-cli';
      content: string;
      revision: number;
    }>();
    window.api = {
      getRemoteHostNodeAssetConvention: vi.fn((request: { adapterId: string }) =>
        request.adapterId === 'claude-code'
          ? Promise.resolve({ adapterId: 'claude-code' as const, content: '# claude', revision: 1 })
          : codex.promise),
    } as unknown as Window['api'];
    render(<RemoteApplicationConventionTab
      catalogRevision={1}
      identity="remote-a:1"
      label="Remote A"
      profileId="remote-a"
      onCatalogChanged={vi.fn()}
    />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByDisplayValue('# claude')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Codex CLI' }));
    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(screen.getByDisplayValue('# claude')).toBeTruthy();
    expect(screen.queryByText('正在读取应用约定…')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.queryByDisplayValue('# claude')).toBeNull();
    expect(screen.getByText('正在读取应用约定…')).toBeTruthy();

    await act(async () => {
      codex.resolve({ adapterId: 'codex-cli', content: '# codex', revision: 1 });
      await codex.promise;
    });
    expect(screen.getByDisplayValue('# codex')).toBeTruthy();
  });
});
