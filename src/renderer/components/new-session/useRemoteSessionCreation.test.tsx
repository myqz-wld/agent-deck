// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type { SessionConsoleCapabilitiesResult } from '@contracts/index';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { useRemoteSessionCreation } from './useRemoteSessionCreation';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function descriptor(
  provider: string,
  workingDirectory = '.',
): SessionConsoleCapabilitiesResult {
  const fixture = sessionConsoleCapabilitiesFixture('codex-cli', workingDirectory);
  return {
    ...fixture,
    create: {
      ...fixture.create,
      options: {
        ...fixture.create.options,
        provider: {
          allowedValues: ['default-provider', 'team-provider'],
          allowCustom: true,
          allowEmpty: false,
          defaultValue: provider,
          disabledReason: null,
          enabled: true,
        },
      },
    },
  };
}

function source(
  getSessionCapabilities: RemoteSessionSourceView['getSessionCapabilities'],
  usable = true,
): RemoteSessionSourceView {
  return {
    identity: 'remote-a:core-a:1',
    usable,
    capabilities: new Set(['session-console.read']),
    getSessionCapabilities,
  } as unknown as RemoteSessionSourceView;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useRemoteSessionCreation authority projection', () => {
  it('commits a non-empty default provider without issuing a duplicate capability read', async () => {
    vi.useFakeTimers();
    const getSessionCapabilities = vi.fn().mockResolvedValue(descriptor('default-provider'));
    const currentSource = source(getSessionCapabilities);
    const hook = renderHook(() => useRemoteSessionCreation({
      active: true,
      scopeKey: 'dialog-a',
      source: currentSource,
      workingDirectory: '.',
    }));

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(hook.result.current.ready).toBe(true);
    expect(hook.result.current.options.provider).toBe('default-provider');
    expect(getSessionCapabilities).toHaveBeenCalledOnce();

    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(getSessionCapabilities).toHaveBeenCalledOnce();
  });

  it('keeps an accepted provider override authoritative even if response metadata has another default', async () => {
    vi.useFakeTimers();
    const getSessionCapabilities = vi.fn().mockResolvedValue(descriptor('default-provider'));
    const currentSource = source(getSessionCapabilities);
    const hook = renderHook(() => useRemoteSessionCreation({
      active: true,
      scopeKey: 'dialog-a',
      source: currentSource,
      workingDirectory: '.',
    }));
    await act(() => vi.advanceTimersByTimeAsync(0));

    act(() => hook.result.current.setOption('provider', 'team-provider'));
    expect(hook.result.current.ready).toBe(false);
    expect(hook.result.current.presentationDescriptor).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(120));

    expect(getSessionCapabilities).toHaveBeenCalledTimes(2);
    expect(getSessionCapabilities).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: 'team-provider',
    }));
    expect(hook.result.current.options.provider).toBe('team-provider');
    expect(hook.result.current.ready).toBe(true);
  });

  it('retains the complete presentation and valid explicit choices during cwd revalidation', async () => {
    vi.useFakeTimers();
    const next = deferred<SessionConsoleCapabilitiesResult>();
    const getSessionCapabilities = vi.fn()
      .mockResolvedValueOnce(descriptor('default-provider'))
      .mockReturnValueOnce(next.promise);
    const currentSource = source(getSessionCapabilities);
    const hook = renderHook(
      ({ cwd }) => useRemoteSessionCreation({
        active: true,
        scopeKey: 'dialog-a',
        source: currentSource,
        workingDirectory: cwd,
      }),
      { initialProps: { cwd: '.' } },
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    act(() => hook.result.current.setOption('model', 'custom-model'));

    hook.rerender({ cwd: 'repo/two' });
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.descriptor).toBeNull();
    expect(hook.result.current.presentationDescriptor).not.toBeNull();
    expect(hook.result.current.options.model).toBe('custom-model');

    await act(() => vi.advanceTimersByTimeAsync(120));
    await act(async () => next.resolve(descriptor('default-provider', 'repo/two')));
    expect(hook.result.current.ready).toBe(true);
    expect(hook.result.current.options.model).toBe('custom-model');
  });

  it('keeps the prior adapter projection intact until the new adapter commits atomically', async () => {
    vi.useFakeTimers();
    const next = deferred<SessionConsoleCapabilitiesResult>();
    const getSessionCapabilities = vi.fn()
      .mockResolvedValueOnce(descriptor('default-provider'))
      .mockReturnValueOnce(next.promise);
    const currentSource = source(getSessionCapabilities);
    const hook = renderHook(() => useRemoteSessionCreation({
      active: true,
      scopeKey: 'dialog-a',
      source: currentSource,
      workingDirectory: '.',
    }));
    await act(() => vi.advanceTimersByTimeAsync(0));

    act(() => hook.result.current.setAdapterId('claude-code'));
    expect(hook.result.current.adapterId).toBe('claude-code');
    expect(hook.result.current.presentationAdapterId).toBe('codex-cli');
    expect(hook.result.current.presentationDescriptor?.selectedAdapterId).toBe('codex-cli');
    expect(hook.result.current.presentationOptions.model).toBe('gpt-5');
    expect(hook.result.current.descriptor).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(120));
    await act(async () => next.resolve(sessionConsoleCapabilitiesFixture('claude-code', '.')));
    expect(hook.result.current.adapterId).toBe('claude-code');
    expect(hook.result.current.presentationAdapterId).toBe('claude-code');
    expect(hook.result.current.presentationDescriptor?.selectedAdapterId).toBe('claude-code');
    expect(hook.result.current.presentationOptions.model).toBe('sonnet');
    expect(hook.result.current.ready).toBe(true);
  });

  it('invalidates an in-flight snapshot across same-identity disconnect and reconnect', async () => {
    vi.useFakeTimers();
    const stale = deferred<SessionConsoleCapabilitiesResult>();
    const getSessionCapabilities = vi.fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(descriptor('default-provider'));
    const connected = source(getSessionCapabilities);
    const hook = renderHook(
      ({ current }) => useRemoteSessionCreation({
        active: true,
        scopeKey: 'dialog-a',
        source: current,
        workingDirectory: '.',
      }),
      { initialProps: { current: connected } },
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(getSessionCapabilities).toHaveBeenCalledOnce();

    hook.rerender({ current: source(getSessionCapabilities, false) });
    expect(hook.result.current.descriptor).toBeNull();
    expect(hook.result.current.presentationDescriptor).toBeNull();
    await act(async () => stale.resolve(descriptor('default-provider')));
    expect(hook.result.current.descriptor).toBeNull();

    hook.rerender({ current: source(getSessionCapabilities, true) });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(getSessionCapabilities).toHaveBeenCalledTimes(2);
    expect(hook.result.current.ready).toBe(true);
  });

  it('retries a terminal capability-read failure without reopening the authoring surface', async () => {
    vi.useFakeTimers();
    const getSessionCapabilities = vi.fn()
      .mockRejectedValueOnce(new Error('temporary capability failure'))
      .mockResolvedValueOnce(descriptor('default-provider'));
    const currentSource = source(getSessionCapabilities);
    const hook = renderHook(() => useRemoteSessionCreation({
      active: true,
      scopeKey: 'dialog-a',
      source: currentSource,
      workingDirectory: '.',
    }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(hook.result.current.error).toBe('temporary capability failure');
    expect(hook.result.current.ready).toBe(false);

    act(() => hook.result.current.retry());
    expect(hook.result.current.loading).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(getSessionCapabilities).toHaveBeenCalledTimes(2);
    expect(hook.result.current.ready).toBe(true);
    expect(hook.result.current.error).toBeNull();
  });
});
