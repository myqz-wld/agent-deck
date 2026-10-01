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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function api(initial = settings()) {
  let saved = initial;
  const persist = (request: { preference: typeof saved.conversation; expectedSettingsRevision: number }) => {
    expect(request.expectedSettingsRevision).toBe(saved.settingsRevision);
    saved = { ...saved, conversation: request.preference, settingsRevision: saved.settingsRevision + 1, revision: saved.revision + 1 };
    return structuredClone(saved);
  };
  const backend = {
    listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
    listCodexGatewayProfiles: vi.fn().mockResolvedValue([]),
    getRemoteHostFeishuPreferences: vi.fn(async () => structuredClone(saved)),
    getRemoteHostSessionCapabilities: vi.fn().mockImplementation(({ adapterId }) =>
      Promise.resolve(sessionConsoleCapabilitiesFixture(adapterId ?? 'codex-cli'))),
    updateRemoteHostFeishuPreferences: vi.fn(async request => persist(request)),
  };
  Object.defineProperty(window, 'api', { configurable: true, value: backend });
  return { ...backend, persist };
}
function changeModel(value: string): void {
  const input = screen.getByLabelText('机器人聊天 模型');
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}
function choose(field: string, name: string | RegExp): void {
  fireEvent.click(screen.getByLabelText(`机器人聊天 ${field}`));
  fireEvent.click(screen.getByRole('option', { name }));
}
afterEach(() => {
  cleanup(); vi.useRealTimers(); Reflect.deleteProperty(window, 'api');
  window.localStorage.removeItem('agent-deck:settings:section:feishu-conversation');
});

describe('Feishu assistant automatic settings', () => {
  it('uses one compact form and saves selections immediately without normal save or refresh buttons', async () => {
    const backend = api(); render(<FeishuPreferencesSection source={source} />);
    await screen.findByLabelText('机器人聊天 模型');
    expect(screen.queryByRole('button', { name: /保存|刷新/ })).toBeNull();
    expect(screen.queryByLabelText('新建会话 模型')).toBeNull();
    expect(screen.getByLabelText('机器人聊天 沙盒').closest('[data-generator-fields]')).toBeTruthy();
    choose('审批策略', '按需询问');
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(1));
    choose('沙盒', /^完全只读/);
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(2));
    expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenLastCalledWith({ profileId: 'remote-a', purpose: 'conversation',
      preference: { adapterId: 'codex-cli', provider: '', model: 'chat-model', thinking: 'high', approvalPolicy: 'on-request', codexSandbox: 'read-only' },
      expectedSettingsRevision: 5, expectedAuthority: source.expectedAuthority, intentId: expect.any(String) });
    expect(backend.listClaudeGatewayProfiles).not.toHaveBeenCalled();
    expect(backend.listCodexGatewayProfiles).not.toHaveBeenCalled();
  });

  it('commits model input on blur while leaving typing local', async () => {
    const backend = api(); render(<FeishuPreferencesSection source={source} />);
    const model = await screen.findByLabelText('机器人聊天 模型');
    fireEvent.focus(model);
    fireEvent.change(model, { target: { value: 'chosen-model' } });
    expect(backend.updateRemoteHostFeishuPreferences).not.toHaveBeenCalled();
    fireEvent.blur(model);
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(1));
    expect(backend.updateRemoteHostFeishuPreferences.mock.calls[0][0].preference.model).toBe('chosen-model');
  });

  it('coalesces edits behind the current save and advances the confirmed revision without rolling back the form', async () => {
    const backend = api();
    const gate = deferred<void>();
    backend.updateRemoteHostFeishuPreferences.mockImplementationOnce(async request => { await gate.promise; return backend.persist(request); });
    render(<FeishuPreferencesSection source={source} />);
    await screen.findByLabelText('机器人聊天 模型');
    changeModel('first-model');
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(1));
    choose('审批策略', '按需询问');
    changeModel('latest-model');
    expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(1);
    await act(async () => gate.resolve());
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(2));
    expect(backend.updateRemoteHostFeishuPreferences.mock.calls[1][0]).toMatchObject({
      expectedSettingsRevision: 5, preference: { model: 'latest-model', approvalPolicy: 'on-request' },
    });
    expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('latest-model');
  });

  it('finishes already requested edits after closing and reopens from the accepted settings', async () => {
    const backend = api(); const gate = deferred<void>();
    backend.updateRemoteHostFeishuPreferences.mockImplementationOnce(async request => { await gate.promise; return backend.persist(request); });
    const view = render(<FeishuPreferencesSection source={source} />);
    await screen.findByLabelText('机器人聊天 模型');
    changeModel('first-model');
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(1));
    changeModel('last-model');
    view.unmount();
    await act(async () => gate.resolve());
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(2));
    render(<FeishuPreferencesSection source={source} />);
    await waitFor(() => expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('last-model'));
  });

  it('retains failed edits and reads the latest revision before an explicit retry', async () => {
    const backend = api(); backend.updateRemoteHostFeishuPreferences.mockRejectedValueOnce(new Error('PRIVATE_BACKEND_PATH'));
    render(<FeishuPreferencesSection source={source} />);
    await screen.findByLabelText('机器人聊天 模型');
    changeModel('unsaved-model');
    await screen.findByRole('alert');
    expect(screen.queryByText(/PRIVATE_BACKEND_PATH/)).toBeNull();
    expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('unsaved-model');
    backend.getRemoteHostFeishuPreferences.mockResolvedValue({ ...settings(), settingsRevision: 9 });
    backend.updateRemoteHostFeishuPreferences.mockImplementationOnce(async request => ({ ...settings(), conversation: request.preference, settingsRevision: 10 }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(2));
    expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenLastCalledWith(expect.objectContaining({ expectedSettingsRevision: 9,
      preference: expect.objectContaining({ model: 'unsaved-model' }) }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('keeps unsupported saved policies visible and does not autosave an invalid configuration', async () => {
    const backend = api({ ...settings(), conversation: { ...settings().conversation, approvalPolicy: 'on-request' } });
    backend.getRemoteHostSessionCapabilities.mockImplementation(() => {
      const result = sessionConsoleCapabilitiesFixture();
      result.create.options.approvalPolicy = { ...result.create.options.approvalPolicy, defaultValue: 'never', allowedValues: ['never'] };
      return Promise.resolve(result);
    });
    render(<FeishuPreferencesSection source={source} />);
    await screen.findByLabelText('机器人聊天 模型');
    changeModel('edited-model');
    expect(backend.updateRemoteHostFeishuPreferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('机器人聊天 审批策略'));
    expect((screen.getByRole('option', { name: 'on-request（暂不可用）' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('option', { name: '从不询问' }));
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(1));
  });

  it('uses one 150 ms boundary for preferences and capabilities, then commits the complete form', async () => {
    vi.useFakeTimers(); const backend = api();
    const preferences = deferred<FeishuPreferencesResult>();
    const capabilities = deferred<ReturnType<typeof sessionConsoleCapabilitiesFixture>>();
    backend.getRemoteHostFeishuPreferences.mockReturnValue(preferences.promise);
    backend.getRemoteHostSessionCapabilities.mockReturnValue(capabilities.promise);
    render(<FeishuPreferencesSection source={source} />);
    await act(() => vi.advanceTimersByTimeAsync(100));
    await act(async () => preferences.resolve(settings()));
    await act(() => vi.advanceTimersByTimeAsync(49));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByLabelText('机器人聊天 模型')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    await act(async () => capabilities.resolve(sessionConsoleCapabilitiesFixture()));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByLabelText('机器人聊天 审批策略').textContent).toContain('从不询问');
  });

  it('retains a warm form on reopen and quietly revalidates before accepting edits', async () => {
    const backend = api(); const first = render(<FeishuPreferencesSection source={source} />);
    await screen.findByLabelText('机器人聊天 模型');
    fireEvent.click(screen.getByRole('button', { name: '机器人聊天', expanded: true }));
    expect(screen.queryByRole('textbox', { name: '机器人聊天 模型' })).toBeNull();
    first.unmount();
    const refresh = deferred<FeishuPreferencesResult>();
    backend.getRemoteHostFeishuPreferences.mockReturnValueOnce(refresh.promise);
    vi.useFakeTimers();
    render(<FeishuPreferencesSection source={source} />);
    expect(screen.queryByRole('textbox', { name: '机器人聊天 模型' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '机器人聊天', expanded: false }));
    expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('chat-model');
    choose('审批策略', '按需询问');
    expect(backend.updateRemoteHostFeishuPreferences).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(149));
    expect(screen.queryByRole('status')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    await act(async () => refresh.resolve(settings('fresh-model')));
    expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('fresh-model');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the form through a slow adapter read and finishes autosave while collapsed', async () => {
    const backend = api(); render(<FeishuPreferencesSection source={source} />);
    await screen.findByLabelText('机器人聊天 模型');
    const next = deferred<ReturnType<typeof sessionConsoleCapabilitiesFixture>>();
    backend.getRemoteHostSessionCapabilities.mockReturnValueOnce(next.promise);
    vi.useFakeTimers(); choose('助手', 'Claude Code');
    await act(() => vi.advanceTimersByTimeAsync(149));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByLabelText('机器人聊天 审批策略')).toBeTruthy();
    expect(backend.updateRemoteHostFeishuPreferences).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '机器人聊天', expanded: true }));
    expect(screen.queryByRole('textbox', { name: '机器人聊天 模型' })).toBeNull();
    await act(async () => next.resolve(sessionConsoleCapabilitiesFixture('claude-code')));
    expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '机器人聊天', expanded: false }));
    expect(backend.getRemoteHostFeishuPreferences).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('机器人聊天 审批策略')).toBeNull();
    expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('sonnet');
    expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledWith(expect.objectContaining({
      preference: expect.objectContaining({ adapterId: 'claude-code', model: 'sonnet', permissionMode: 'bypassPermissions' }),
    }));
  });

  it('uses and remembers the selected remote Gateway defaults', async () => {
    const backend = api();
    backend.getRemoteHostSessionCapabilities.mockImplementation(({ provider }) => {
      const result = sessionConsoleCapabilitiesFixture();
      result.create.options.provider = { ...result.create.options.provider, allowedValues: ['gateway-a', 'gateway-b'], defaultValue: provider };
      result.create.options.model = { ...result.create.options.model, defaultValue: `${provider || 'native'}-model` };
      result.create.options.thinking = { ...result.create.options.thinking, defaultValue: provider === 'gateway-a' ? 'medium' : 'high' };
      return Promise.resolve(result);
    });
    render(<FeishuPreferencesSection source={source} />); await screen.findByLabelText('机器人聊天 模型');
    const gateway = async (name: string) => {
      choose('模型网关', name);
      await waitFor(() => expect((screen.getByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe(`${name}-model`));
    };
    await gateway('gateway-a'); choose('思考程度', 'MAX');
    await gateway('gateway-b'); expect(screen.getByLabelText('机器人聊天 思考程度').textContent).toContain('HIGH');
    await gateway('gateway-a'); expect(screen.getByLabelText('机器人聊天 思考程度').textContent).toContain('MAX');
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenLastCalledWith(expect.objectContaining({
      preference: expect.objectContaining({ provider: 'gateway-a', model: 'gateway-a-model', thinking: 'max' }),
    })));
    expect(backend.listCodexGatewayProfiles).not.toHaveBeenCalled();
  });

  it('prefills an unconfigured assistant without a write and applies an explicit first selection', async () => {
    const backend = api({ ...settings(), conversation: defaultFeishuModelPreference() });
    const defaults = sessionConsoleCapabilitiesFixture('claude-code');
    defaults.create.options.provider = { ...defaults.create.options.provider, allowedValues: ['remote-gateway'], defaultValue: 'remote-gateway' };
    backend.getRemoteHostSessionCapabilities.mockResolvedValue(defaults);
    render(<FeishuPreferencesSection source={source} />);
    expect((await screen.findByLabelText('机器人聊天 模型') as HTMLInputElement).value).toBe('sonnet');
    expect(backend.updateRemoteHostFeishuPreferences).not.toHaveBeenCalled();
    choose('助手', 'Claude Code');
    await waitFor(() => expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledTimes(1));
    expect(backend.updateRemoteHostFeishuPreferences).toHaveBeenCalledWith(expect.objectContaining({
      preference: expect.objectContaining({ adapterId: 'claude-code', provider: 'remote-gateway', model: 'sonnet' }),
    }));
  });

  it('never applies an old Core response to the new source', async () => {
    const backend = api(); const old = deferred<FeishuPreferencesResult>();
    backend.getRemoteHostFeishuPreferences.mockReturnValueOnce(old.promise);
    const view = render(<FeishuPreferencesSection source={source} />);
    view.rerender(<FeishuPreferencesSection source={{ ...source, identity: 'remote-b:core-b:2', profileId: 'remote-b',
      expectedAuthority: { authoritativeCoreId: 'core-b', workerGeneration: 2 } }} />);
    await screen.findByLabelText('机器人聊天 模型');
    await act(async () => old.resolve(settings('stale-private-model')));
    expect(screen.queryByDisplayValue('stale-private-model')).toBeNull();
  });

  it('does not load remote preferences in local or disconnected settings', () => {
    const backend = api(); const view = render(<FeishuPreferencesSection source={null} />);
    view.rerender(<FeishuPreferencesSection source={{ ...source, usable: false }} />);
    expect(backend.getRemoteHostFeishuPreferences).not.toHaveBeenCalled();
  });
});
