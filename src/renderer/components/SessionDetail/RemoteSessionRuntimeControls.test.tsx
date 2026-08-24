// @vitest-environment happy-dom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteSessionRuntimeControls } from './RemoteSessionRuntimeControls';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'api');
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('RemoteSessionRuntimeControls Codex approval fallback', () => {
  it('keeps model and immediate runtime writes active after StrictMode effect rehearsal', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(
      <StrictMode>
        <RemoteSessionRuntimeControls
          adapterId="codex-cli"
          busy={false}
          canWrite
          identity="remote-a:core-a:1:session-a"
          values={{ approvalPolicy: 'untrusted', model: 'old-model' }}
          onApply={onApply}
        />
      </StrictMode>,
    );

    const model = screen.getByLabelText('模型');
    fireEvent.change(model, { target: { value: 'draft-model' } });
    fireEvent.blur(model);
    await waitFor(() => expect(onApply).toHaveBeenCalledWith({
      provider: null,
      model: 'draft-model',
      thinking: null,
    }));

    fireEvent.click(screen.getByLabelText('审批'));
    fireEvent.click(screen.getByRole('option', { name: '按需询问' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ approvalPolicy: 'on-request' }));
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  it('does not invent concrete approval or sandbox values when the Core omitted them', () => {
    render(
      <RemoteSessionRuntimeControls
        adapterId="codex-cli"
        busy={false}
        canWrite
        identity="remote-a:core-a:session-a"
        values={{ provider: '', model: 'gpt-5.6-sol', thinking: 'low' }}
        onApply={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByLabelText('审批').textContent).toContain('使用当前默认值');
    expect(screen.getByLabelText('沙盒').textContent).toContain('使用当前默认值');
  });

  it('preserves an explicit on-request policy', () => {
    render(
      <RemoteSessionRuntimeControls
        adapterId="codex-cli"
        busy={false}
        canWrite
        identity="remote-a:core-a:session-a"
        values={{ approvalPolicy: 'on-request' }}
        onApply={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByLabelText('审批').textContent).toContain('按需询问');
  });

  it('keeps Grok sandbox editable during an active turn', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(
      <RemoteSessionRuntimeControls
        adapterId="grok-build"
        busy={false}
        canWrite
        identity="remote-a:core-a:session-a"
        turnActive
        values={{ grokSandbox: 'workspace', sessionMode: 'default' }}
        onApply={onApply}
      />,
    );

    expect((screen.getByLabelText('沙盒') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByLabelText('沙盒'));
    fireEvent.click(screen.getByRole('option', { name: '广泛只读' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith({
      grokSandbox: 'read-only',
    }));
  });

  it.each([
    {
      name: 'session switch',
      identity: 'remote-a:core-a:1:session-b',
      canWrite: true,
      busy: false,
    },
    {
      name: 'Worker generation switch',
      identity: 'remote-a:core-a:2:session-a',
      canWrite: true,
      busy: false,
    },
    {
      name: 'disconnect',
      identity: 'remote-a:core-a:1:session-a',
      canWrite: false,
      busy: false,
    },
  ])('drops a deferred sandbox confirmation after $name', async (next) => {
    const confirmation = deferred<boolean>();
    const oldApply = vi.fn().mockResolvedValue(undefined);
    const nextApply = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { confirmDialog: vi.fn(() => confirmation.promise) },
    });
    const view = render(
      <RemoteSessionRuntimeControls
        adapterId="claude-code"
        busy={false}
        canWrite
        identity="remote-a:core-a:1:session-a"
        values={{ claudeCodeSandbox: 'strict' }}
        onApply={oldApply}
      />,
    );

    fireEvent.click(screen.getByLabelText('沙盒'));
    fireEvent.click(screen.getByRole('option', { name: '⚠️ 完全开放' }));
    await waitFor(() => expect(window.api.confirmDialog).toHaveBeenCalledOnce());

    view.rerender(
      <RemoteSessionRuntimeControls
        adapterId="claude-code"
        busy={next.busy}
        canWrite={next.canWrite}
        identity={next.identity}
        values={{ claudeCodeSandbox: 'strict' }}
        onApply={nextApply}
      />,
    );
    await act(async () => confirmation.resolve(true));

    expect(oldApply).not.toHaveBeenCalled();
    expect(nextApply).not.toHaveBeenCalled();
  });

  it('checks queued approval work against its origin before invoking an API', async () => {
    const first = deferred<void>();
    const oldApply = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const nextApply = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <RemoteSessionRuntimeControls
        adapterId="codex-cli"
        busy={false}
        canWrite
        identity="remote-a:core-a:1:session-a"
        values={{ approvalPolicy: 'untrusted', codexSandbox: 'read-only' }}
        onApply={oldApply}
      />,
    );

    fireEvent.click(screen.getByLabelText('审批'));
    fireEvent.click(screen.getByRole('option', { name: '按需询问' }));
    await waitFor(() => expect(oldApply).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByLabelText('审批'));
    fireEvent.click(screen.getByRole('option', { name: '从不询问' }));

    view.rerender(
      <RemoteSessionRuntimeControls
        adapterId="codex-cli"
        busy={false}
        canWrite
        identity="remote-a:core-a:2:session-a"
        values={{ approvalPolicy: 'untrusted', codexSandbox: 'read-only' }}
        onApply={nextApply}
      />,
    );
    await act(async () => first.resolve(undefined));

    expect(oldApply).toHaveBeenCalledTimes(1);
    expect(nextApply).not.toHaveBeenCalled();
  });

  it('does not flush a debounced model edit into a replacement session', async () => {
    vi.useFakeTimers();
    const oldApply = vi.fn().mockResolvedValue(undefined);
    const nextApply = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <RemoteSessionRuntimeControls
        adapterId="codex-cli"
        busy={false}
        canWrite
        identity="remote-a:core-a:1:session-a"
        values={{ model: 'old-model' }}
        onApply={oldApply}
      />,
    );
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'draft-model' } });

    view.rerender(
      <RemoteSessionRuntimeControls
        adapterId="codex-cli"
        busy={false}
        canWrite
        identity="remote-a:core-a:1:session-b"
        values={{ model: 'replacement-model' }}
        onApply={nextApply}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect((screen.getByLabelText('模型') as HTMLInputElement).value).toBe('replacement-model');
    expect(screen.getByText(/会话已切换，上一会话尚未保存的模型编辑已丢弃。/u)).toBeTruthy();
    expect(oldApply).not.toHaveBeenCalled();
    expect(nextApply).not.toHaveBeenCalled();
  });

  it('retries a same-session model edit after the session becomes eligible again', async () => {
    vi.useFakeTimers();
    const onApply = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <RemoteSessionRuntimeControls
        adapterId="codex-cli"
        busy={false}
        canWrite
        identity="remote-a:core-a:1:session-a"
        values={{ model: 'old-model' }}
        onApply={onApply}
      />,
    );
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'draft-model' } });
    view.rerender(
      <RemoteSessionRuntimeControls
        adapterId="codex-cli"
        busy
        canWrite
        identity="remote-a:core-a:1:session-a"
        values={{ model: 'old-model' }}
        onApply={onApply}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('空闲后自动保存');
    view.rerender(
      <RemoteSessionRuntimeControls
        adapterId="codex-cli"
        busy={false}
        canWrite
        identity="remote-a:core-a:1:session-a"
        values={{ model: 'old-model' }}
        onApply={onApply}
      />,
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(onApply).toHaveBeenCalledWith({
      provider: null,
      model: 'draft-model',
      thinking: null,
    });
  });

  it('flushes a model edit on blur before ordinary navigation can unmount it', async () => {
    vi.useFakeTimers();
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(
      <RemoteSessionRuntimeControls
        adapterId="codex-cli"
        busy={false}
        canWrite
        identity="remote-a:core-a:1:session-a"
        values={{ model: 'old-model' }}
        onApply={onApply}
      />,
    );
    const model = screen.getByLabelText('模型');
    fireEvent.change(model, { target: { value: 'draft-model' } });
    fireEvent.blur(model);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(onApply).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(onApply).toHaveBeenCalledOnce();
  });
});
