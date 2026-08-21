// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '@shared/types';
import { FAST_ASYNC_FALLBACK_GRACE_MS } from '@renderer/hooks/useDelayedAsyncFallback';
import { AssetsLibraryDialog } from './AssetsLibraryDialog';
import { SettingsDialog } from './SettingsDialog';

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

describe('dialog initial readiness', () => {
  it('delays Settings loading copy and commits a fast settings result directly', async () => {
    const settings = deferred<typeof DEFAULT_SETTINGS>();
    window.api = {
      getSettings: vi.fn(() => settings.promise),
      hookStatus: vi.fn(async () => ({
        installed: false, scope: 'user', settingsPath: '', installedHooks: [],
      })),
    } as unknown as Window['api'];
    render(<SettingsDialog open onClose={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.queryByText('读取设置中…')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(screen.queryByText('读取设置中…')).toBeNull();

    await act(async () => {
      settings.resolve(DEFAULT_SETTINGS);
      await settings.promise;
    });
    expect(screen.getByRole('tab', { name: '通用' })).toBeTruthy();
    expect(screen.queryByText('读取设置中…')).toBeNull();
  });

  it('reveals the Assets loading fallback only when its read crosses 150 ms', async () => {
    const assets = deferred<{
      assets: [];
      assetsTruncated: false;
      injection: typeof DEFAULT_SETTINGS;
      readOnlyReason: string;
      revision: number;
    }>();
    window.api = {
      listRemoteHostNodeAssets: vi.fn(() => assets.promise),
    } as unknown as Window['api'];
    render(<AssetsLibraryDialog open onClose={vi.fn()} remote={{
      identity: 'remote-a:core-a:1',
      label: 'Remote A',
      profileId: 'remote-a',
      supportsNodeAssets: true,
      usable: true,
    }} />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.queryByText('正在读取资产…')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(screen.queryByText('正在读取资产…')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText('正在读取资产…')).toBeTruthy();
  });
});
