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
});
