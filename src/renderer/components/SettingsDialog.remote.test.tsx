// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '@shared/types';
import { SettingsDialog } from './SettingsDialog';

const RAW_BACKEND_ERROR =
  'RAW_BACKEND_MARKER secret=sk-live-token path=/Users/alice/.config URL=https://internal.example';
const REMOTE_HOOK_STATUS = {
  supported: true,
  state: 'not-installed',
  scope: 'user',
  writeAllowed: true,
  disabledReason: null,
} as const;
const EXPECTED_AUTHORITY = {
  authoritativeCoreId: 'core-a',
  workerGeneration: 1,
} as const;

function expectRawBackendDetailsHidden(): void {
  const text = document.body.textContent ?? '';
  for (const marker of [
    'RAW_BACKEND_MARKER',
    'sk-live-token',
    '/Users/alice/.config',
    'https://internal.example',
  ]) {
    expect(text).not.toContain(marker);
  }
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  Reflect.deleteProperty(window, 'api');
});

describe('SettingsDialog adapter views', () => {
  it('binds Remote settings and Hook actions to the selected Worker only', async () => {
    const localHookStatus = vi.fn();
    const remoteHookStatus = vi.fn().mockResolvedValue({
      adapterId: 'claude-code',
      revision: 4,
      status: REMOTE_HOOK_STATUS,
    });
    const installRemote = vi.fn().mockResolvedValue({
      adapterId: 'claude-code',
      revision: 5,
      status: { ...REMOTE_HOOK_STATUS, state: 'installed' },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
        hookStatus: localHookStatus,
        getRemoteHostNodeConfiguration: vi.fn().mockResolvedValue({
          providerDefaults: {
            claudeCodeSandbox: 'strict',
            codexSandbox: 'read-only',
            enableAgentDeckMcp: true,
            grokSandbox: 'off',
            permissionTimeoutMs: 30_000,
            summaryModel: 'summary-model',
            summaryThinking: 'low',
            summaryTimeoutMs: 60_000,
          },
          revision: 4,
        }),
        getRemoteHostNodeHookStatus: remoteHookStatus,
        installRemoteHostNodeHook: installRemote,
      },
    });

    render(<SettingsDialog open onClose={vi.fn()} remote={{
      identity: 'remote-a:core-a:1',
      label: 'aws-relay-on-mac',
      profileId: 'remote-a',
      expectedAuthority: EXPECTED_AUTHORITY,
      supportsNodeConfiguration: true,
      supportsNodeHooksRead: true,
      supportsNodeHooksWrite: true,
      usable: true,
    }} />);

    expect(await screen.findByText('设置 · aws-relay-on-mac')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '设置 · aws-relay-on-mac' })).toBeTruthy();
    expect(await screen.findByText('Claude Code 沙盒默认值')).toBeTruthy();
    expect(screen.getByText('strict')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code 终端 Hook' }));
    expect(screen.getByText(/作用目标：当前 Remote Worker/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '在 Worker 上安装 Hook' }));
    await vi.waitFor(() => expect(installRemote).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'remote-a',
      adapterId: 'claude-code',
    })));
    expect(localHookStatus).not.toHaveBeenCalled();
    expect(remoteHookStatus).toHaveBeenCalledTimes(3);
  });

  it('never falls back to Local settings when the Remote Core lacks node configuration', async () => {
    const localHookStatus = vi.fn();
    const remoteHookStatus = vi.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
        hookStatus: localHookStatus,
        getRemoteHostNodeHookStatus: remoteHookStatus,
      },
    });
    render(<SettingsDialog open onClose={vi.fn()} remote={{
      identity: 'remote-a:legacy-core',
      label: 'legacy-worker',
      profileId: 'remote-a',
      expectedAuthority: { authoritativeCoreId: 'legacy-core', workerGeneration: null },
      supportsNodeConfiguration: false,
      supportsNodeHooksRead: false,
      supportsNodeHooksWrite: false,
      usable: true,
    }} />);
    expect(await screen.findByText(
      '当前 Remote Core 版本未提供节点配置能力；请先升级远端部署。',
    )).toBeTruthy();
    expect(localHookStatus).not.toHaveBeenCalled();
    expect(remoteHookStatus).not.toHaveBeenCalled();
  });

  it('loads Worker configuration after reconnecting without requiring the dialog to close', async () => {
    const remoteConfiguration = vi.fn().mockResolvedValue({
      providerDefaults: {
        claudeCodeSandbox: 'strict', codexSandbox: 'read-only',
        enableAgentDeckMcp: true, grokSandbox: 'off', permissionTimeoutMs: 30_000,
        summaryModel: '', summaryThinking: '', summaryTimeoutMs: 60_000,
      },
      revision: 8,
    });
    const remoteHookStatus = vi.fn().mockResolvedValue({
      adapterId: 'claude-code', revision: 8, status: REMOTE_HOOK_STATUS,
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
        getRemoteHostNodeConfiguration: remoteConfiguration,
        getRemoteHostNodeHookStatus: remoteHookStatus,
      },
    });
    const base = {
      identity: 'remote-a:core-a:1', label: 'aws-relay-on-mac', profileId: 'remote-a',
      expectedAuthority: EXPECTED_AUTHORITY,
      supportsNodeConfiguration: true,
      supportsNodeHooksRead: true,
      supportsNodeHooksWrite: true,
    } as const;
    const view = render(<SettingsDialog open onClose={vi.fn()} remote={{
      ...base, usable: false,
    }} />);
    expect(await screen.findByText(/Remote Worker 尚未连接/)).toBeTruthy();
    expect(remoteConfiguration).not.toHaveBeenCalled();

    view.rerender(<SettingsDialog open onClose={vi.fn()} remote={{ ...base, usable: true }} />);
    expect(await screen.findByText('配置 revision')).toBeTruthy();
    expect(await screen.findByText('8')).toBeTruthy();
    expect(remoteConfiguration).toHaveBeenCalledWith({ profileId: 'remote-a' });
    expect(remoteHookStatus).toHaveBeenCalledTimes(3);
  });

  it('ignores a same-identity Worker response that lands after disconnect', async () => {
    let resolveConfiguration!: (value: {
      providerDefaults: {
        claudeCodeSandbox: string;
        codexSandbox: string;
        enableAgentDeckMcp: boolean;
        grokSandbox: string;
        permissionTimeoutMs: number;
        summaryModel: string;
        summaryThinking: string;
        summaryTimeoutMs: number;
      };
      revision: number;
    }) => void;
    const remoteConfiguration = vi.fn(() => new Promise((resolve) => {
      resolveConfiguration = resolve;
    }));
    const remoteHookStatus = vi.fn().mockResolvedValue({
      adapterId: 'claude-code', revision: 8, status: REMOTE_HOOK_STATUS,
    });
    const localHookStatus = vi.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
        hookStatus: localHookStatus,
        getRemoteHostNodeConfiguration: remoteConfiguration,
        getRemoteHostNodeHookStatus: remoteHookStatus,
      },
    });
    const base = {
      identity: 'remote-a:core-a:1', label: 'aws-relay-on-mac', profileId: 'remote-a',
      expectedAuthority: EXPECTED_AUTHORITY,
      supportsNodeConfiguration: true,
      supportsNodeHooksRead: true,
      supportsNodeHooksWrite: true,
    } as const;
    const view = render(
      <SettingsDialog open onClose={vi.fn()} remote={{ ...base, usable: true }} />,
    );
    await vi.waitFor(() => expect(remoteConfiguration).toHaveBeenCalledOnce());

    view.rerender(
      <SettingsDialog open onClose={vi.fn()} remote={{ ...base, usable: false }} />,
    );
    expect(await screen.findByText(
      '当前 Remote Worker 尚未连接；不会读取或修改本机 Hook 作为替代。',
    )).toBeTruthy();

    resolveConfiguration({
      providerDefaults: {
        claudeCodeSandbox: 'strict',
        codexSandbox: 'read-only',
        enableAgentDeckMcp: true,
        grokSandbox: 'off',
        permissionTimeoutMs: 30_000,
        summaryModel: 'stale-worker-model',
        summaryThinking: 'low',
        summaryTimeoutMs: 60_000,
      },
      revision: 99,
    });
    await Promise.resolve();
    expect(screen.queryByText('stale-worker-model')).toBeNull();
    expect(screen.queryByText('99')).toBeNull();
    expect(localHookStatus).not.toHaveBeenCalled();
  });

  it('does not publish a stale Hook mutation failure after the Worker disconnects', async () => {
    let rejectInstall!: (reason: Error) => void;
    const installRemote = vi.fn(() => new Promise<never>((_resolve, reject) => {
      rejectInstall = reject;
    }));
    const remoteHookStatus = vi.fn().mockResolvedValue({
      adapterId: 'claude-code', revision: 8, status: REMOTE_HOOK_STATUS,
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
        getRemoteHostNodeConfiguration: vi.fn().mockResolvedValue({
          providerDefaults: {
            claudeCodeSandbox: 'strict', codexSandbox: 'read-only',
            enableAgentDeckMcp: true, grokSandbox: 'off', permissionTimeoutMs: 30_000,
            summaryModel: '', summaryThinking: '', summaryTimeoutMs: 60_000,
          },
          revision: 8,
        }),
        getRemoteHostNodeHookStatus: remoteHookStatus,
        installRemoteHostNodeHook: installRemote,
      },
    });
    const base = {
      identity: 'remote-a:core-a:1', label: 'aws-relay-on-mac', profileId: 'remote-a',
      expectedAuthority: EXPECTED_AUTHORITY,
      supportsNodeConfiguration: true,
      supportsNodeHooksRead: true,
      supportsNodeHooksWrite: true,
    } as const;
    const view = render(
      <SettingsDialog open onClose={vi.fn()} remote={{ ...base, usable: true }} />,
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Claude Code' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Claude Code 终端 Hook' }));
    fireEvent.click(await screen.findByRole('button', { name: '在 Worker 上安装 Hook' }));
    await vi.waitFor(() => expect(installRemote).toHaveBeenCalledOnce());

    view.rerender(
      <SettingsDialog open onClose={vi.fn()} remote={{ ...base, usable: false }} />,
    );
    rejectInstall(new Error(RAW_BACKEND_ERROR));
    await Promise.resolve();

    expect(screen.getByText(
      '当前 Remote Worker 尚未连接；不会读取或修改本机 Hook 作为替代。',
    )).toBeTruthy();
    expect(screen.queryByText('Claude Code 终端 Hook 安装失败，请重试。')).toBeNull();
    expectRawBackendDetailsHidden();
  });
});
