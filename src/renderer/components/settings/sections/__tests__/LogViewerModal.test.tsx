// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@renderer/utils/logger', () => ({
  default: {
    scope: () => ({ error: vi.fn() }),
  },
}));

vi.mock('@renderer/lib/monaco-local', () => ({
  configureLocalMonaco: vi.fn(),
}));

vi.mock('@monaco-editor/react', () => ({
  Editor: ({ value }: { value?: string }) => <pre>{value}</pre>,
}));

import { LogViewerModal } from '../LogViewerModal';

interface ReadResult {
  ok: boolean;
  existed: boolean;
  content?: string;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

function setReadMock(logsReadToday: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { logsReadToday },
  });
}

describe('LogViewerModal request lifecycle', () => {
  it('renders a concise local error when the read invoke rejects', async () => {
    setReadMock(vi.fn().mockRejectedValue(new Error('transport detail must stay local')));

    render(<LogViewerModal open onClose={vi.fn()} />);

    expect(await screen.findByText('读取日志失败，请重试。')).toBeTruthy();
    expect(screen.queryByText(/transport detail/)).toBeNull();
  });

  it('invalidates an in-flight read immediately when close is clicked', async () => {
    const pending = deferred<ReadResult>();
    setReadMock(vi.fn().mockReturnValue(pending.promise));
    const onClose = vi.fn();
    render(<LogViewerModal open onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: '关闭日志查看' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ ok: true, existed: true, content: 'STALE_AFTER_CLOSE' });
      await pending.promise;
    });

    expect(screen.queryByText('STALE_AFTER_CLOSE')).toBeNull();
  });

  it('does not paint an older refresh after close and reopen', async () => {
    const initial = deferred<ReadResult>();
    const staleRefresh = deferred<ReadResult>();
    const currentOpen = deferred<ReadResult>();
    const logsReadToday = vi.fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(staleRefresh.promise)
      .mockReturnValueOnce(currentOpen.promise);
    setReadMock(logsReadToday);
    const view = render(<LogViewerModal open onClose={vi.fn()} />);

    await act(async () => {
      initial.resolve({ ok: true, existed: true, content: 'INITIAL' });
      await initial.promise;
    });
    expect(await screen.findByText('INITIAL')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /刷新/ }));
    view.rerender(<LogViewerModal open={false} onClose={vi.fn()} />);
    view.rerender(<LogViewerModal open onClose={vi.fn()} />);

    await act(async () => {
      staleRefresh.resolve({ ok: true, existed: true, content: 'STALE_REFRESH' });
      await staleRefresh.promise;
    });
    expect(screen.queryByText('STALE_REFRESH')).toBeNull();

    await act(async () => {
      currentOpen.resolve({ ok: true, existed: true, content: 'CURRENT_OPEN' });
      await currentOpen.promise;
    });
    await waitFor(() => expect(screen.getByText('CURRENT_OPEN')).toBeTruthy());
    expect(screen.queryByText('STALE_REFRESH')).toBeNull();
  });
});
