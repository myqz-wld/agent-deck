// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/types';
import { defaultFeishuModelPreference, type FeishuPreferencesResult } from '@contracts/index';
import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import { SettingsDialog } from './SettingsDialog';
import { useSettingsDialogRead, type RemoteSettingsSource } from './settings/use-settings-dialog-read';

const remote: RemoteSettingsSource = {
  identity: 'remote-a:core-a:1', label: 'Remote test', profileId: 'remote-a', usable: true,
  supportsNodeConfiguration: false, supportsNodeHooksRead: false, supportsFeishuPreferences: true,
  expectedAuthority: { authoritativeCoreId: 'core-a', workerGeneration: 1 },
};
const preferences: FeishuPreferencesResult = {
  conversation: { ...defaultFeishuModelPreference(), adapterId: 'codex-cli', model: 'cached-model' },
  session: defaultFeishuModelPreference(), settingsRevision: 1, revision: 1,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function api() {
  const backend = {
    getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
    getRemoteHostFeishuPreferences: vi.fn().mockResolvedValue(preferences),
    getRemoteHostSessionCapabilities: vi.fn().mockResolvedValue(sessionConsoleCapabilitiesFixture('codex-cli')),
  };
  Object.defineProperty(window, 'api', { configurable: true, value: backend });
  return backend;
}
afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(window, 'api'); });

describe('remote settings complete presentation', () => {
  it('waits for the complete form and shows only one fallback at 150ms', async () => {
    vi.useFakeTimers();
    const backend = api();
    const capability = deferred<ReturnType<typeof sessionConsoleCapabilitiesFixture>>();
    backend.getRemoteHostSessionCapabilities.mockReturnValue(capability.promise);
    render(<SettingsDialog open onClose={vi.fn()} remote={remote} />);
    await act(async () => { await Promise.resolve(); });
    act(() => vi.advanceTimersByTime(149));
    expect(screen.queryByText('读取设置中…')).toBeNull();
    expect(screen.queryByLabelText('机器人聊天 模型')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('读取设置中…');
    expect(screen.queryByText(/正在读取模型配置|正在读取远端设置/)).toBeNull();
    await act(async () => capability.resolve(sessionConsoleCapabilitiesFixture('codex-cli')));
    expect(screen.queryByText('读取设置中…')).toBeNull();
    expect(screen.getByLabelText('机器人聊天 模型')).toBeTruthy();
  });

  it('restores the matching remote form immediately on reopen and isolates a different Core', async () => {
    const backend = api();
    const first = render(<SettingsDialog open onClose={vi.fn()} remote={remote} />);
    await screen.findByLabelText('机器人聊天 模型');
    first.unmount();
    const pending = deferred<FeishuPreferencesResult>();
    backend.getRemoteHostFeishuPreferences.mockReturnValue(pending.promise);
    const reopened = render(<SettingsDialog open onClose={vi.fn()} remote={remote} />);
    expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('cached-model');
    expect(screen.queryByText('读取设置中…')).toBeNull();
    await waitFor(() => expect(backend.getRemoteHostFeishuPreferences).toHaveBeenCalledTimes(2));
    reopened.rerender(<SettingsDialog open onClose={vi.fn()} remote={{ ...remote, identity: 'remote-a:core-b:2',
      expectedAuthority: { authoritativeCoreId: 'core-b', workerGeneration: 2 } }} />);
    expect(screen.queryByLabelText('机器人聊天 模型')).toBeNull();
    await act(async () => pending.resolve({ ...preferences, conversation: { ...preferences.conversation, model: 'core-b-model' } }));
    expect((await screen.findByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('core-b-model');
  });

  it('does not roll back a local appearance change when a remote revalidation completes', async () => {
    const backend = api();
    const hook = renderHook(({ open }) => useSettingsDialogRead(open, remote), { initialProps: { open: true } });
    await waitFor(() => expect(hook.result.current.pending).toBe(false));
    hook.rerender({ open: false });
    const pending = deferred<FeishuPreferencesResult>();
    backend.getRemoteHostFeishuPreferences.mockReturnValue(pending.promise);
    hook.rerender({ open: true });
    const changed = { ...DEFAULT_SETTINGS, alwaysOnTop: !DEFAULT_SETTINGS.alwaysOnTop };
    act(() => hook.result.current.setSettings(changed));
    await act(async () => pending.resolve(preferences));
    await waitFor(() => expect(hook.result.current.pending).toBe(false));
    expect(hook.result.current.value?.settings).toEqual(changed);
  });
});
