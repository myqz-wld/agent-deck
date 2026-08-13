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
  it('shows selected Worker settings and Hooks with Local-shaped disabled controls', async () => {
    const localHookStatus = vi.fn();
    const remoteHookStatus = vi.fn().mockImplementation(
      ({ adapterId }: { adapterId: 'claude-code' | 'codex-cli' | 'grok-build' }) =>
        Promise.resolve({ adapterId, revision: 4, status: REMOTE_HOOK_STATUS }),
    );
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
      },
    });

    render(<SettingsDialog open onClose={vi.fn()} remote={{
      identity: 'remote-a:core-a:1',
      label: 'aws-relay-on-mac',
      profileId: 'remote-a',
      supportsNodeConfiguration: true,
      supportsNodeHooksRead: true,
      usable: true,
    }} />);

    expect(await screen.findByText('Remote 设置 · aws-relay-on-mac')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Remote 设置 · aws-relay-on-mac' })).toBeTruthy();
    expect(await screen.findByText('Claude Code 沙盒默认值')).toBeTruthy();
    expect(screen.getByDisplayValue('strict')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: '启用 Agent Deck MCP' }) as HTMLInputElement).disabled)
      .toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code 终端 Hook' }));
    expect(screen.getByRole('status').textContent).toContain(
      'Hook 由 Worker 部署管理，Remote 中仅供查看。',
    );
    expect((screen.getByRole('button', { name: '安装 Hook' }) as HTMLButtonElement).disabled)
      .toBe(true);
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
      supportsNodeConfiguration: false,
      supportsNodeHooksRead: false,
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
      supportsNodeConfiguration: true,
      supportsNodeHooksRead: true,
    } as const;
    const view = render(<SettingsDialog open onClose={vi.fn()} remote={{
      ...base, usable: false,
    }} />);
    expect(await screen.findByText(/Worker 尚未连接/)).toBeTruthy();
    expect(remoteConfiguration).not.toHaveBeenCalled();

    view.rerender(<SettingsDialog open onClose={vi.fn()} remote={{ ...base, usable: true }} />);
    expect(await screen.findByText('部署快照版本')).toBeTruthy();
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
      supportsNodeConfiguration: true,
      supportsNodeHooksRead: true,
    } as const;
    const view = render(
      <SettingsDialog open onClose={vi.fn()} remote={{ ...base, usable: true }} />,
    );
    await vi.waitFor(() => expect(remoteConfiguration).toHaveBeenCalledOnce());

    view.rerender(
      <SettingsDialog open onClose={vi.fn()} remote={{ ...base, usable: false }} />,
    );
    expect(await screen.findByText(
      '当前 Worker 尚未连接，暂时无法读取部署配置。',
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

  it('hides backend details when a Remote Hook status read fails', async () => {
    const remoteHookStatus = vi.fn().mockRejectedValue(new Error(RAW_BACKEND_ERROR));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
        getRemoteHostNodeConfiguration: vi.fn().mockRejectedValue(new Error(RAW_BACKEND_ERROR)),
        getRemoteHostNodeHookStatus: remoteHookStatus,
      },
    });
    const base = {
      identity: 'remote-a:core-a:1', label: 'aws-relay-on-mac', profileId: 'remote-a',
      supportsNodeConfiguration: true,
      supportsNodeHooksRead: true,
    } as const;
    render(
      <SettingsDialog open onClose={vi.fn()} remote={{ ...base, usable: true }} />,
    );
    expect(await screen.findByText(/Claude Code 终端 Hook 状态读取失败/)).toBeTruthy();
    expectRawBackendDetailsHidden();
  });
});
