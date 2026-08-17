// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FAST_ASYNC_FALLBACK_GRACE_MS } from '@renderer/hooks/useDelayedAsyncFallback';
import { NewSessionDialog } from '../NewSessionDialog';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function sessionCreationDefaults() {
  return {
    provider: '',
    model: '',
    thinking: 'high' as const,
    permissionMode: 'bypassPermissions' as const,
    sessionMode: 'default' as const,
    approvalPolicy: 'on-request' as const,
    codexSandbox: 'workspace-write' as const,
    claudeCodeSandbox: 'workspace-write' as const,
    grokSandbox: 'workspace',
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listAdapters: vi.fn().mockResolvedValue([{
        id: 'claude-code',
        displayName: 'Claude',
        capabilities: { canCreateSession: true, canSetPermissionMode: true },
      }]),
      getAdapterSessionCreationDefaults: vi.fn().mockResolvedValue(sessionCreationDefaults()),
      listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
      listCodexGatewayProfiles: vi.fn().mockResolvedValue([]),
      chooseDirectory: vi.fn(),
      createAdapterSession: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  Reflect.deleteProperty(window, 'api');
  vi.restoreAllMocks();
});

describe('NewSessionDialog readiness', () => {
  it('hides fast initialization and shows an explicit loading shell after the grace period', async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof sessionCreationDefaults> & { model: string }>();
    window.api.getAdapterSessionCreationDefaults = vi.fn().mockReturnValue(pending.promise);
    render(<NewSessionDialog open={true} onClose={vi.fn()} onCreated={vi.fn()} />);

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(window.api.listAdapters).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-new-session-modal-root="true"]')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '新建会话' })).toBeNull();
    expect(screen.queryByText('模型配置')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(screen.queryByRole('dialog', { name: '新建会话' })).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole('dialog', { name: '新建会话' })).toBeTruthy();
    expect(screen.getByText('正在读取会话配置…')).toBeTruthy();
    expect(screen.queryByText('模型配置')).toBeNull();

    await act(async () => {
      pending.resolve({ ...sessionCreationDefaults(), model: 'claude-config-model' });
    });

    expect(screen.getByText(/模型：claude-config-model/)).toBeTruthy();
    expect(screen.queryByText('正在读取会话配置…')).toBeNull();
    const localTarget = screen.getByText('创建目标：本机');
    expect(localTarget.className).toContain('bg-black/20');
    expect(localTarget.className).not.toContain('status-working');
  });

  it('includes provider discovery before revealing the complete fast form', async () => {
    vi.useFakeTimers();
    const providers = deferred<{ id: string; name?: string; settingsPath: string }[]>();
    const listClaudeGatewayProfiles = vi.fn(() => providers.promise);
    window.api.listClaudeGatewayProfiles = listClaudeGatewayProfiles;
    render(<NewSessionDialog open={true} onClose={vi.fn()} onCreated={vi.fn()} />);

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(listClaudeGatewayProfiles).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: '新建会话' })).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    await act(async () => providers.resolve([{
      id: 'gateway-a',
      name: 'Gateway A',
      settingsPath: '/config/gateway-a.json',
    }]));
    expect(screen.getByRole('dialog', { name: '新建会话' })).toBeTruthy();
    expect(screen.getByText('模型配置')).toBeTruthy();
    expect(screen.queryByText('正在读取会话配置…')).toBeNull();
  });

  it('presents a settled empty adapter inventory directly without a false loading label', async () => {
    vi.useFakeTimers();
    const pendingDefaults = deferred<ReturnType<typeof sessionCreationDefaults>>();
    window.api.listAdapters = vi.fn().mockResolvedValue([]);
    window.api.getAdapterSessionCreationDefaults = vi.fn(() => pendingDefaults.promise);
    render(<NewSessionDialog open={true} onClose={vi.fn()} onCreated={vi.fn()} />);

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('没有可用的助手')).toBeTruthy();
    expect(screen.queryByText('正在读取助手配置…')).toBeNull();
    expect(screen.queryByText('正在读取会话配置…')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS));
    expect(screen.getByText('没有可用的助手')).toBeTruthy();
    expect(screen.queryByText('正在读取助手配置…')).toBeNull();
    await act(async () => pendingDefaults.resolve(sessionCreationDefaults()));
  });

  it('starts a fresh hidden readiness cycle after close and reopen', async () => {
    vi.useFakeTimers();
    const reopenedDefaults = deferred<ReturnType<typeof sessionCreationDefaults> & {
      model: string;
    }>();
    const getDefaults = vi.fn()
      .mockResolvedValueOnce({ ...sessionCreationDefaults(), model: 'first-model' })
      .mockReturnValueOnce(reopenedDefaults.promise);
    window.api.getAdapterSessionCreationDefaults = getDefaults;
    const view = render(
      <NewSessionDialog open={true} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText(/模型：first-model/)).toBeTruthy();

    view.rerender(<NewSessionDialog open={false} onClose={vi.fn()} onCreated={vi.fn()} />);
    view.rerender(<NewSessionDialog open={true} onClose={vi.fn()} onCreated={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(document.querySelector('[data-new-session-modal-root="true"]')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '新建会话' })).toBeNull();
    expect(screen.queryByText(/模型：first-model/)).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS));
    expect(screen.getByText('正在读取会话配置…')).toBeTruthy();
    await act(async () => reopenedDefaults.resolve({
      ...sessionCreationDefaults(),
      model: 'second-model',
    }));
    expect(screen.getByText(/模型：second-model/)).toBeTruthy();
  });

  it('keeps the complete form mounted and delays progress during later revalidation', async () => {
    vi.useFakeTimers();
    const refreshedDefaults = deferred<ReturnType<typeof sessionCreationDefaults>>();
    window.api.getAdapterSessionCreationDefaults = vi.fn()
      .mockResolvedValueOnce(sessionCreationDefaults())
      .mockReturnValueOnce(refreshedDefaults.promise);
    render(<NewSessionDialog open={true} onClose={vi.fn()} onCreated={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.change(screen.getByRole('textbox', { name: '第一条消息' }), {
      target: { value: 'run task' },
    });
    fireEvent.click(screen.getByText('模型配置'));
    const provider = screen.getByLabelText('模型网关') as HTMLInputElement;
    fireEvent.change(provider, { target: { value: 'gateway-a' } });

    expect(provider.disabled).toBe(false);
    expect(screen.getByText('模型配置')).toBeTruthy();
    expect((screen.getByRole('button', { name: '创建' }) as HTMLButtonElement).disabled)
      .toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(screen.queryByText('正在更新会话配置…')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText('正在更新会话配置…')).toBeTruthy();
    await act(async () => refreshedDefaults.resolve(sessionCreationDefaults()));
    expect(screen.queryByText('正在更新会话配置…')).toBeNull();
    expect((screen.getByRole('button', { name: '创建' }) as HTMLButtonElement).disabled)
      .toBe(false);
  });
});
