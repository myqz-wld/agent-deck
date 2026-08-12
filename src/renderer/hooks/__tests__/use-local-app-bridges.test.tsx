// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLocalAppBridges } from '../use-local-app-bridges';
import { useLocalSessionState } from '../use-local-session-state';
import { useSessionStore } from '@renderer/stores/session-store';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
  vi.restoreAllMocks();
});

describe('Local authority isolation', () => {
  it('touches neither Local APIs nor the Local session store while Remote is authoritative', () => {
    const apiRead = vi.fn(() => {
      throw new Error('Remote mode touched a Local API');
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: new Proxy({}, { get: apiRead }) as unknown as Window['api'],
    });
    const subscribe = vi.spyOn(useSessionStore, 'subscribe');
    const getState = vi.spyOn(useSessionStore, 'getState');

    renderHook(() => {
      useLocalAppBridges(false);
      return useLocalSessionState(false);
    });

    expect(apiRead).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
  });
});
