// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFeishuModelPreference, type FeishuPreferencesResult } from '@contracts/index';
import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import { FeishuPreferencesSection, type FeishuPreferencesSource } from './FeishuPreferencesSection';

const source: FeishuPreferencesSource = { identity: 'remote-a:core-a:1', profileId: 'remote-a', usable: true,
  supportsFeishuPreferences: true, expectedAuthority: { authoritativeCoreId: 'core-a', workerGeneration: 1 } };
function settings(model = 'chat-model'): FeishuPreferencesResult {
  return { conversation: { ...defaultFeishuModelPreference(), adapterId: 'codex-cli', model },
    session: { ...defaultFeishuModelPreference(), adapterId: 'claude-code', model: 'work-model' }, settingsRevision: 4, revision: 20 };
}
function api() {
  const result = {
    getRemoteHostFeishuPreferences: vi.fn().mockResolvedValue(settings()),
    getRemoteHostSessionCapabilities: vi.fn().mockImplementation(({ adapterId }) =>
      Promise.resolve(sessionConsoleCapabilitiesFixture(adapterId ?? 'codex-cli'))),
    updateRemoteHostFeishuPreferences: vi.fn().mockImplementation(async ({ purpose, preference }) =>
      ({ ...settings(), [purpose]: preference, settingsRevision: 5, revision: 21 })),
  };
  Object.defineProperty(window, 'api', { configurable: true, value: result });
  return result;
}
afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(window, 'api'); });

describe('shared Feishu model settings', () => {
  it('edits the two last choices separately through the selected Core and exact authority', async () => {
    const backend = api(); render(<FeishuPreferencesSection source={source} />);
    const chat = await screen.findByLabelText('机器人聊天 模型');
    expect((chat as HTMLInputElement).value).toBe('chat-model');
    expect((screen.getByLabelText('新建会话 模型') as HTMLInputElement).value).toBe('work-model');
    fireEvent.change(chat, { target: { value: 'chosen-model' } });
    fireEvent.click(screen.getByRole('button', { name: '保存机器人聊天选择' }));
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(1));
    expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledWith({ profileId: 'remote-a', purpose: 'conversation',
      preference: { adapterId: 'codex-cli', model: 'chosen-model', provider: '', thinking: '' },
      expectedSettingsRevision: 4, expectedAuthority: source.expectedAuthority, intentId: expect.any(String) });
    expect((screen.getByLabelText('新建会话 模型') as HTMLInputElement).value).toBe('work-model');
  });
  it('suppresses loading copy during the initial 150 ms', async () => {
    const backend = api(); backend.getRemoteHostFeishuPreferences.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers(); render(<FeishuPreferencesSection source={source} />);
    await act(async () => { vi.advanceTimersByTime(149); });
    expect(screen.queryByText('正在读取模型配置…')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(screen.getByText('正在读取模型配置…')).toBeTruthy();
  });
  it('ignores late responses from the previously selected Core', async () => {
    const backend = api(); let resolveOld!: (value: FeishuPreferencesResult) => void;
    backend.getRemoteHostFeishuPreferences.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    const view = render(<FeishuPreferencesSection source={source} />);
    view.rerender(<FeishuPreferencesSection source={{ ...source, identity: 'remote-b:core-b:2', profileId: 'remote-b',
      expectedAuthority: { authoritativeCoreId: 'core-b', workerGeneration: 2 } }} />);
    await screen.findByLabelText('机器人聊天 模型');
    await act(async () => resolveOld(settings('stale-private-model')));
    expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('chat-model');
    expect(screen.queryByDisplayValue('stale-private-model')).toBeNull();
  });
  it('preserves a failed-save draft, hides raw errors, and requires refreshing before another save', async () => {
    const backend = api(); backend.updateRemoteHostFeishuPreferences.mockRejectedValue(new Error('PRIVATE_BACKEND_PATH'));
    render(<FeishuPreferencesSection source={source} />);
    fireEvent.change(await screen.findByLabelText('机器人聊天 模型'), { target: { value: 'unsaved-model' } });
    const save = screen.getByRole('button', { name: '保存机器人聊天选择' }); fireEvent.click(save);
    await screen.findByRole('alert');
    expect(screen.queryByText(/PRIVATE_BACKEND_PATH/)).toBeNull();
    expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('unsaved-model');
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '刷新配置' }));
    await waitFor(() => expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('chat-model'));
  });
  it('never loads remote preferences from a local or disconnected settings page', () => {
    const backend = api(); const view = render(<FeishuPreferencesSection source={null} />);
    view.rerender(<FeishuPreferencesSection source={{ ...source, usable: false }} />);
    expect(backend.getRemoteHostFeishuPreferences).not.toHaveBeenCalled();
    expect(backend.getRemoteHostSessionCapabilities).not.toHaveBeenCalled();
  });
});
