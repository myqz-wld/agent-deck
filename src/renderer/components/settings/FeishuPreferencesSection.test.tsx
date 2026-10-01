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
    listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
    listCodexGatewayProfiles: vi.fn().mockResolvedValue([]),
    getRemoteHostFeishuPreferences: vi.fn().mockResolvedValue(settings()),
    getRemoteHostSessionCapabilities: vi.fn().mockImplementation(({ adapterId }) =>
      Promise.resolve(sessionConsoleCapabilitiesFixture(adapterId ?? 'codex-cli'))),
    updateRemoteHostFeishuPreferences: vi.fn().mockImplementation(async ({ purpose, preference }) =>
      ({ ...settings(), [purpose]: preference, settingsRevision: 5, revision: 21 })),
  };
  Object.defineProperty(window, 'api', { configurable: true, value: result });
  return result;
}
function changeModel(value: string): void {
  const input = screen.getByLabelText('机器人聊天 模型');
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}
afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(window, 'api'); });

describe('shared Feishu model settings', () => {
  it('saves the selected purpose’s native mode and sandbox while retaining model choices', async () => {
    const backend = api(); render(<FeishuPreferencesSection source={source} />);
    fireEvent.click(await screen.findByLabelText('机器人聊天 审批策略'));
    fireEvent.click(screen.getByRole('option', { name: '按需询问' }));
    fireEvent.click(screen.getByLabelText('机器人聊天 沙盒'));
    fireEvent.click(screen.getByRole('option', { name: /^完全只读/ }));
    expect(screen.queryByLabelText('机器人聊天 权限模式')).toBeNull();
    expect(screen.queryByLabelText('新建会话 权限模式')).toBeNull();
    expect(screen.queryByLabelText('新建会话 审批策略')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存机器人聊天选择' }));
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(1));
    expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'conversation',
      preference: { adapterId: 'codex-cli', model: 'chat-model', provider: '', thinking: 'high',
        approvalPolicy: 'on-request', codexSandbox: 'read-only' } }));
  });

  it('offers only live supported policies and keeps unavailable saved values visible without allowing a save', async () => {
    const backend = api();
    backend.getRemoteHostFeishuPreferences.mockResolvedValue({ ...settings(), conversation: {
      ...settings().conversation, approvalPolicy: 'on-request' } });
    backend.getRemoteHostSessionCapabilities.mockImplementation(({ adapterId }) => {
      const value = sessionConsoleCapabilitiesFixture(adapterId ?? 'codex-cli');
      if (adapterId === 'codex-cli') value.create.options.approvalPolicy = { ...value.create.options.approvalPolicy,
        defaultValue: 'never', allowedValues: ['never'] };
      return Promise.resolve(value);
    });
    render(<FeishuPreferencesSection source={source} />);
    fireEvent.click(await screen.findByLabelText('机器人聊天 审批策略'));
    expect(screen.queryByRole('option', { name: '按需询问' })).toBeNull();
    expect((screen.getByRole('option', { name: 'on-request（暂不可用）' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '保存机器人聊天选择' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('saves the assistant’s concrete configuration through the selected Core and exact authority', async () => {
    const backend = api(); render(<FeishuPreferencesSection source={source} />);
    const chat = await screen.findByLabelText('机器人聊天 模型');
    expect((chat as HTMLInputElement).value).toBe('chat-model');
    expect(screen.queryByLabelText('新建会话 模型')).toBeNull();
    expect(screen.getByLabelText('机器人聊天 审批策略').textContent).toContain('从不询问');
    expect(screen.getByLabelText('机器人聊天 沙盒').textContent).toContain('工作目录可写');
    expect(screen.getByLabelText('机器人聊天 思考程度').textContent).toContain('HIGH');
    expect(screen.queryByText(/跟随/)).toBeNull();
    changeModel('chosen-model');
    fireEvent.click(screen.getByRole('button', { name: '保存机器人聊天选择' }));
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(1));
    expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledWith({ profileId: 'remote-a', purpose: 'conversation',
      preference: { adapterId: 'codex-cli', model: 'chosen-model', provider: '', thinking: 'high',
        approvalPolicy: 'never', codexSandbox: 'workspace-write' },
      expectedSettingsRevision: 4, expectedAuthority: source.expectedAuthority, intentId: expect.any(String) });
    expect(backend.getRemoteHostSessionCapabilities).toHaveBeenCalledTimes(1);
    expect(backend.getRemoteHostSessionCapabilities).toHaveBeenCalledWith({ profileId: 'remote-a',
      adapterId: 'codex-cli', provider: '', workingDirectory: '.' });
    expect(backend.listClaudeGatewayProfiles).not.toHaveBeenCalled();
    expect(backend.listCodexGatewayProfiles).not.toHaveBeenCalled();
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
    await screen.findByLabelText('机器人聊天 模型');
    changeModel('unsaved-model');
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

  it('uses one grace period for settings and capabilities and commits the complete form at once', async () => {
    vi.useFakeTimers();
    const backend = api();
    let finishSettings!: (value: FeishuPreferencesResult) => void;
    let finishCapabilities!: (value: ReturnType<typeof sessionConsoleCapabilitiesFixture>) => void;
    backend.getRemoteHostFeishuPreferences.mockReturnValue(new Promise(resolve => { finishSettings = resolve; }));
    backend.getRemoteHostSessionCapabilities.mockReturnValue(new Promise(resolve => { finishCapabilities = resolve; }));
    render(<FeishuPreferencesSection source={source} />);
    await act(() => vi.advanceTimersByTimeAsync(100));
    await act(async () => finishSettings(settings()));
    expect(screen.queryByLabelText('机器人聊天 模型')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(49));
    expect(screen.queryByRole('status')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText('正在读取模型配置…')).toBeTruthy();
    expect(screen.queryByLabelText('机器人聊天 助手')).toBeNull();
    await act(async () => finishCapabilities(sessionConsoleCapabilitiesFixture()));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByLabelText('机器人聊天 审批策略').textContent).toContain('从不询问');
  });

  it('retains an unsaved form during a slow refresh and blocks stale writes without flashing a loader', async () => {
    const backend = api(); render(<FeishuPreferencesSection source={source} />);
    const model = await screen.findByLabelText('机器人聊天 模型');
    changeModel('draft-model');
    vi.useFakeTimers();
    let finish!: (value: FeishuPreferencesResult) => void;
    backend.getRemoteHostFeishuPreferences.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: '刷新配置' }));
    expect(screen.getByLabelText('机器人聊天 模型')).toBe(model);
    expect((model as HTMLInputElement).value).toBe('draft-model');
    fireEvent.click(screen.getByRole('button', { name: '保存机器人聊天选择' }));
    expect(backend.updateRemoteHostFeishuPreferences).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(149));
    expect(screen.queryByRole('status')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText('正在读取模型配置…')).toBeTruthy();
    expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('draft-model');
    await act(async () => finish(settings('refreshed-model')));
    expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('refreshed-model');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('retains the complete form during adapter changes and commits only the matching capability response', async () => {
    const backend = api(); render(<FeishuPreferencesSection source={source} />);
    const model = await screen.findByLabelText('机器人聊天 模型');
    changeModel('edited-model');
    vi.useFakeTimers();
    let finish!: (value: ReturnType<typeof sessionConsoleCapabilitiesFixture>) => void;
    backend.getRemoteHostSessionCapabilities.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByLabelText('机器人聊天 助手'));
    fireEvent.click(screen.getByRole('option', { name: 'Claude Code' }));
    expect((model as HTMLInputElement).value).toBe('edited-model');
    expect(screen.getByLabelText('机器人聊天 审批策略')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(149));
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('button', { name: '保存机器人聊天选择' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '保存机器人聊天选择' }));
    expect(backend.updateRemoteHostFeishuPreferences).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText('正在读取可用配置…')).toBeTruthy();
    await act(async () => finish(sessionConsoleCapabilitiesFixture('claude-code')));
    expect(screen.queryByLabelText('机器人聊天 审批策略')).toBeNull();
    expect(screen.getByLabelText('机器人聊天 权限模式').textContent).toContain('不再询问');
    expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('sonnet');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('resolves a fast Gateway change directly to that Gateway defaults', async () => {
    const backend = api();
    backend.getRemoteHostSessionCapabilities.mockImplementation(({ provider }) => {
      const value = sessionConsoleCapabilitiesFixture();
      value.create.options.provider = { ...value.create.options.provider, allowedValues: ['gateway-a'], defaultValue: provider };
      if (provider) {
        value.create.options.model = { ...value.create.options.model, defaultValue: 'gateway-model' };
        value.create.options.thinking = { ...value.create.options.thinking, defaultValue: 'medium' };
        value.create.options.approvalPolicy = { ...value.create.options.approvalPolicy, defaultValue: 'on-request' };
      }
      return Promise.resolve(value);
    });
    render(<FeishuPreferencesSection source={source} />);
    await screen.findByLabelText('机器人聊天 模型');
    vi.useFakeTimers();
    fireEvent.click(screen.getByLabelText('机器人聊天 模型网关'));
    fireEvent.click(screen.getByRole('option', { name: 'gateway-a' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('gateway-model');
    expect((screen.getByLabelText('机器人聊天 模型网关') as HTMLInputElement).value).toBe('gateway-a');
    expect(screen.getByLabelText('机器人聊天 思考程度').textContent).toContain('MEDIUM');
    expect(screen.getByLabelText('机器人聊天 审批策略').textContent).toContain('按需询问');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/跟随/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存机器人聊天选择' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledWith(expect.objectContaining({
      preference: { adapterId: 'codex-cli', provider: 'gateway-a', model: 'gateway-model', thinking: 'medium',
        approvalPolicy: 'on-request', codexSandbox: 'workspace-write' },
    }));
    expect((screen.getByRole('button', { name: '保存机器人聊天选择' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('initializes an unconfigured assistant from remote new-session defaults and can save them directly', async () => {
    const backend = api();
    backend.getRemoteHostFeishuPreferences.mockResolvedValue({ ...settings(), conversation: defaultFeishuModelPreference() });
    const defaults = sessionConsoleCapabilitiesFixture('claude-code');
    defaults.create.options.provider = { ...defaults.create.options.provider, allowedValues: ['remote-gateway'], defaultValue: 'remote-gateway' };
    backend.getRemoteHostSessionCapabilities.mockResolvedValue(defaults);
    render(<FeishuPreferencesSection source={source} />);
    const model = await screen.findByLabelText('机器人聊天 模型');
    expect((model as HTMLInputElement).value).toBe('sonnet');
    expect(screen.getByLabelText('机器人聊天 助手').textContent).toContain('Claude Code');
    expect(screen.queryByText('请选择助手')).toBeNull();
    expect((screen.getByLabelText('机器人聊天 模型网关') as HTMLInputElement).value).toBe('remote-gateway');
    expect(screen.getByLabelText('机器人聊天 思考程度').textContent).toContain('HIGH');
    expect(screen.getByLabelText('机器人聊天 权限模式').textContent).toContain('不再询问');
    expect(backend.updateRemoteHostFeishuPreferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存机器人聊天选择' }));
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(1));
    expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledWith(expect.objectContaining({
      preference: { adapterId: 'claude-code', provider: 'remote-gateway', model: 'sonnet', thinking: 'high',
        permissionMode: 'bypassPermissions', claudeCodeSandbox: 'workspace-write' },
    }));
    expect(backend.getRemoteHostSessionCapabilities).toHaveBeenCalledTimes(1);
    expect(backend.listClaudeGatewayProfiles).not.toHaveBeenCalled();
  });

  it('keeps explicit thinking choices per Gateway while applying each Gateway model default', async () => {
    const backend = api();
    backend.getRemoteHostSessionCapabilities.mockImplementation(({ provider }) => {
      const result = sessionConsoleCapabilitiesFixture();
      result.create.options.provider = { ...result.create.options.provider,
        allowedValues: ['gateway-a', 'gateway-b'], defaultValue: provider };
      result.create.options.model = { ...result.create.options.model, defaultValue: `${provider || 'native'}-model` };
      result.create.options.thinking = { ...result.create.options.thinking, defaultValue: provider === 'gateway-a' ? 'medium' : 'high' };
      return Promise.resolve(result);
    });
    render(<FeishuPreferencesSection source={source} />);
    await screen.findByLabelText('机器人聊天 模型');
    const chooseGateway = async (name: string): Promise<void> => {
      fireEvent.click(screen.getByLabelText('机器人聊天 模型网关'));
      fireEvent.click(screen.getByRole('option', { name }));
      await waitFor(() => expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe(`${name}-model`));
    };
    await chooseGateway('gateway-a');
    fireEvent.click(screen.getByLabelText('机器人聊天 思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'MAX' }));
    await chooseGateway('gateway-b');
    expect(screen.getByLabelText('机器人聊天 思考程度').textContent).toContain('HIGH');
    await chooseGateway('gateway-a');
    expect(screen.getByLabelText('机器人聊天 思考程度').textContent).toContain('MAX');
    fireEvent.click(screen.getByRole('button', { name: '保存机器人聊天选择' }));
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(1));
    expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledWith(expect.objectContaining({
      preference: expect.objectContaining({ provider: 'gateway-a', model: 'gateway-a-model', thinking: 'max' }),
    }));
    expect(backend.listCodexGatewayProfiles).not.toHaveBeenCalled();
  });
});
