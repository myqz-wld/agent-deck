// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLastAdapter, setLastDefaults } from '@renderer/hooks/useLastSessionDefaults';
import { NewSessionDialog } from '../NewSessionDialog';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function configuration(provider = '', model = 'native-model') {
  return {
    provider, model, thinking: 'high' as const, permissionMode: 'bypassPermissions' as const,
    sessionMode: 'default' as const, approvalPolicy: 'never' as const,
    codexSandbox: 'workspace-write' as const, claudeCodeSandbox: 'workspace-write' as const,
    grokSandbox: 'workspace',
    projectTrust: {
      status: 'trusted' as const, canGrant: false, reasonCode: null,
      revision: `sha256:${'a'.repeat(64)}` as const,
    },
  };
}

function chooseGateway(name: string): void {
  fireEvent.click(screen.getByLabelText('模型网关'));
  fireEvent.click(screen.getByRole('option', { name }));
}

function displayedModel(): string {
  return (screen.getByLabelText('模型') as HTMLInputElement).value;
}

async function openDialog() {
  const view = render(<NewSessionDialog open onClose={vi.fn()} onCreated={vi.fn()} />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  fireEvent.click(screen.getByText('模型配置'));
  fireEvent.change(screen.getByRole('textbox', { name: '第一条消息' }), {
    target: { value: 'run task' },
  });
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  setLastAdapter('codex-cli');
  setLastDefaults('codex-cli', { provider: '', model: '', thinking: '' });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listAdapters: vi.fn().mockResolvedValue([{
        id: 'codex-cli', displayName: 'Codex', capabilities: { canCreateSession: true },
      }]),
      getAdapterSessionCreationDefaults: vi.fn().mockResolvedValue(configuration()),
      listCodexGatewayProfiles: vi.fn().mockResolvedValue([{ id: 'gateway-a' }, { id: 'gateway-b' }]),
      createAdapterSession: vi.fn().mockResolvedValue('created-session'),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'api');
});

describe('NewSessionDialog Gateway model presentation', () => {
  it('starts a Gateway read immediately and replaces the retained model directly on a fast result', async () => {
    const next = deferred<ReturnType<typeof configuration>>();
    const read = vi.fn().mockResolvedValueOnce(configuration()).mockReturnValueOnce(next.promise);
    window.api.getAdapterSessionCreationDefaults = read;
    await openDialog();
    chooseGateway('gateway-a');

    expect(displayedModel()).toBe('native-model');
    expect(screen.getByText(/模型：native-model/)).toBeTruthy();
    expect((screen.getByLabelText('模型网关') as HTMLInputElement).value).toBe('gateway-a');
    expect((screen.getByRole('button', { name: '创建' }) as HTMLButtonElement).disabled).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(read).toHaveBeenLastCalledWith('codex-cli', { provider: 'gateway-a' });
    await act(() => vi.advanceTimersByTimeAsync(149));
    expect(displayedModel()).toBe('native-model');
    expect(screen.queryByText('正在更新会话配置…')).toBeNull();
    await act(async () => next.resolve(configuration('gateway-a', 'gateway-model')));

    expect(displayedModel()).toBe('gateway-model');
    expect(screen.queryByText('正在更新会话配置…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await act(async () => {});
    expect(window.api.createAdapterSession).toHaveBeenCalledWith('codex-cli', expect.objectContaining({
      provider: 'gateway-a', model: 'gateway-model',
    }));
  });

  it('retains the model on slow reads and shows progress at 150 ms until the result settles', async () => {
    const next = deferred<ReturnType<typeof configuration>>();
    window.api.getAdapterSessionCreationDefaults = vi.fn()
      .mockResolvedValueOnce(configuration()).mockReturnValueOnce(next.promise);
    await openDialog();
    chooseGateway('gateway-a');
    await act(() => vi.advanceTimersByTimeAsync(149));
    expect(screen.queryByText('正在更新会话配置…')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText('正在更新会话配置…')).toBeTruthy();
    expect(displayedModel()).toBe('native-model');
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(window.api.createAdapterSession).not.toHaveBeenCalled();

    await act(async () => next.resolve(configuration('gateway-a', '')));
    expect(displayedModel()).toBe('');
    expect(screen.queryByText('正在更新会话配置…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await act(async () => {});
    expect(window.api.createAdapterSession).toHaveBeenCalledWith('codex-cli', expect.objectContaining({
      provider: 'gateway-a',
    }));
    expect(vi.mocked(window.api.createAdapterSession).mock.calls[0][1]).not.toHaveProperty('model');
  });

  it('keeps the last displayed model through consecutive Gateway choices and ignores stale reads', async () => {
    const first = deferred<ReturnType<typeof configuration>>();
    const second = deferred<ReturnType<typeof configuration>>();
    window.api.getAdapterSessionCreationDefaults = vi.fn().mockResolvedValueOnce(configuration())
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await openDialog();
    chooseGateway('gateway-a');
    await act(() => vi.advanceTimersByTimeAsync(0));
    chooseGateway('gateway-b');
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(displayedModel()).toBe('native-model');
    await act(async () => first.resolve(configuration('gateway-a', 'stale-model')));
    expect(displayedModel()).toBe('native-model');
    await act(async () => second.resolve(configuration('gateway-b', 'latest-model')));
    expect(displayedModel()).toBe('latest-model');
  });

  it('keeps an explicit model edit while Gateway defaults are pending', async () => {
    const next = deferred<ReturnType<typeof configuration>>();
    window.api.getAdapterSessionCreationDefaults = vi.fn()
      .mockResolvedValueOnce(configuration()).mockReturnValueOnce(next.promise);
    await openDialog();
    chooseGateway('gateway-a');
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'custom-model' } });
    await act(async () => next.resolve(configuration('gateway-a', 'gateway-model')));
    expect(displayedModel()).toBe('custom-model');
  });

  it('releases retained presentation on failure and never carries it into a reopened dialog', async () => {
    const next = deferred<ReturnType<typeof configuration>>();
    const reopened = deferred<ReturnType<typeof configuration>>();
    window.api.getAdapterSessionCreationDefaults = vi.fn().mockResolvedValueOnce(configuration())
      .mockReturnValueOnce(next.promise).mockReturnValueOnce(reopened.promise);
    const view = await openDialog();
    chooseGateway('gateway-a');
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(async () => next.reject(new Error('read failed')));
    expect(displayedModel()).toBe('');
    view.rerender(<NewSessionDialog open={false} onClose={vi.fn()} onCreated={vi.fn()} />);
    view.rerender(<NewSessionDialog open onClose={vi.fn()} onCreated={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.queryByText(/模型：native-model/)).toBeNull();
    await act(async () => reopened.resolve(configuration('gateway-a', 'reopened-model')));
    expect(screen.getByText(/模型：reopened-model/)).toBeTruthy();
  });
});
