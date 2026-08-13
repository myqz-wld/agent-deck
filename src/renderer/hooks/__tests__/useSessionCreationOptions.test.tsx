// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionCreationDefaults } from '@shared/types';
import { useSessionCreationOptions } from '../useSessionCreationOptions';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function defaults(model: string): SessionCreationDefaults {
  return {
    provider: '',
    model,
    thinking: 'high',
    permissionMode: 'bypassPermissions',
    sessionMode: 'default',
    approvalPolicy: 'on-request',
    codexSandbox: 'workspace-write',
    claudeCodeSandbox: 'workspace-write',
    grokSandbox: 'workspace',
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'api');
});

describe('useSessionCreationOptions request fencing', () => {
  it('uses never as the Codex approval fallback without changing its sandbox fallback', () => {
    const hook = renderHook(() => useSessionCreationOptions({
      adapterId: 'codex-cli',
      cwd: '/repo',
      active: false,
    }));

    expect(hook.result.current.approvalPolicy).toBe('never');
    expect(hook.result.current.codexSandbox).toBe('workspace-write');
  });

  it('includes provider discovery in the initial complete-form readiness boundary', async () => {
    vi.useFakeTimers();
    const catalog = deferred<readonly { id: string; name?: string }[]>();
    const getDefaults = vi.fn().mockResolvedValue(defaults('claude-default'));
    const listClaudeGatewayProfiles = vi.fn(() => catalog.promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getAdapterSessionCreationDefaults: getDefaults,
        listClaudeGatewayProfiles,
      } as unknown as Window['api'],
    });

    const hook = renderHook(() => useSessionCreationOptions({
      adapterId: 'claude-code',
      cwd: '/repo',
      scopeKey: 'dialog-a',
    }));
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(getDefaults).toHaveBeenCalledOnce();
    expect(listClaudeGatewayProfiles).toHaveBeenCalledOnce();
    expect(hook.result.current.defaultsLoading).toBe(false);
    expect(hook.result.current.configurationLoading).toBe(true);
    expect(hook.result.current.providerOptions).toEqual([]);

    await act(async () => catalog.resolve([{ id: 'gateway-a', name: 'Gateway A' }]));
    expect(hook.result.current.configurationLoading).toBe(false);
    expect(hook.result.current.providerOptions).toEqual([
      { id: 'gateway-a', name: 'Gateway A' },
    ]);
  });

  it('never applies stale adapter, cwd, or provider completions and catches rejection', async () => {
    vi.useFakeTimers();
    const requests = [
      deferred<SessionCreationDefaults>(),
      deferred<SessionCreationDefaults>(),
      deferred<SessionCreationDefaults>(),
    ];
    const getDefaults = vi.fn()
      .mockReturnValueOnce(requests[0].promise)
      .mockReturnValueOnce(requests[1].promise)
      .mockReturnValueOnce(requests[2].promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getAdapterSessionCreationDefaults: getDefaults },
    });

    const hook = renderHook(
      ({ adapterId, cwd }) => useSessionCreationOptions({ adapterId, cwd }),
      { initialProps: { adapterId: 'claude-code', cwd: '/repo/one' } },
    );
    await act(() => vi.advanceTimersByTimeAsync(120));

    act(() => hook.result.current.setProvider('deepseek'));
    await act(() => vi.advanceTimersByTimeAsync(120));
    hook.rerender({ adapterId: 'codex-cli', cwd: '/repo/two' });
    await act(() => vi.advanceTimersByTimeAsync(120));

    await act(async () => requests[2].resolve(defaults('latest')));
    expect(hook.result.current.model).toBe('latest');

    await act(async () => requests[1].reject(new Error('stale failure')));
    await act(async () => requests[0].resolve(defaults('stale')));
    expect(hook.result.current.model).toBe('latest');
    expect(getDefaults).toHaveBeenCalledTimes(3);
  });

  it('does not retain a prior cwd-derived model after the next cwd lookup fails', async () => {
    vi.useFakeTimers();
    const getDefaults = vi.fn()
      .mockResolvedValueOnce({ ...defaults('repo-one-model'), model: 'repo-one-model' })
      .mockRejectedValueOnce(new Error('unreadable cwd config'));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getAdapterSessionCreationDefaults: getDefaults } as unknown as Window['api'],
    });
    const hook = renderHook(
      ({ cwd }) => useSessionCreationOptions({ adapterId: 'grok-build', cwd }),
      { initialProps: { cwd: '/repo/one' } },
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(hook.result.current.model).toBe('repo-one-model');

    hook.rerender({ cwd: '/repo/two' });
    await act(() => vi.advanceTimersByTimeAsync(120));
    expect(hook.result.current.model).toBe('grok-4.5');
    expect(hook.result.current.configurationLoading).toBe(false);
  });
});
