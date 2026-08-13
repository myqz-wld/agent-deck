// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '@shared/types';
import type {
  NodeConfigurationGetResult,
  NodeProviderDefaultsDto,
} from '@contracts/index';
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

function configuration(
  overrides: Partial<NodeProviderDefaultsDto> = {},
  revision = 4,
): NodeConfigurationGetResult {
  return {
    providerDefaults: {
      claudeCliPath: '/Applications/Agent Deck/claude',
      claudeCodeSandbox: DEFAULT_SETTINGS.claudeCodeSandbox,
      codexCliPath: '/Applications/Agent Deck/codex',
      codexSandbox: DEFAULT_SETTINGS.codexSandbox,
      enableAgentDeckMcp: DEFAULT_SETTINGS.enableAgentDeckMcp,
      grokCliPath: '/Applications/Agent Deck/grok',
      grokSandbox: DEFAULT_SETTINGS.grokSandbox,
      injectAgentDeckClaudeAgents: DEFAULT_SETTINGS.injectAgentDeckClaudeAgents,
      injectAgentDeckClaudeMd: DEFAULT_SETTINGS.injectAgentDeckClaudeMd,
      injectAgentDeckClaudeSkills: DEFAULT_SETTINGS.injectAgentDeckClaudeSkills,
      injectAgentDeckCodexAgents: DEFAULT_SETTINGS.injectAgentDeckCodexAgents,
      injectAgentDeckCodexAgentsMd: DEFAULT_SETTINGS.injectAgentDeckCodexAgentsMd,
      injectAgentDeckCodexSkills: DEFAULT_SETTINGS.injectAgentDeckCodexSkills,
      injectAgentDeckGrokAgents: DEFAULT_SETTINGS.injectAgentDeckGrokAgents,
      injectAgentDeckGrokAgentsMd: DEFAULT_SETTINGS.injectAgentDeckGrokAgentsMd,
      injectAgentDeckGrokSkills: DEFAULT_SETTINGS.injectAgentDeckGrokSkills,
      mcpHttpEnabled: DEFAULT_SETTINGS.mcpHttpEnabled,
      permissionTimeoutMs: DEFAULT_SETTINGS.permissionTimeoutMs,
      summaryModel: DEFAULT_SETTINGS.summaryModel,
      summaryThinking: DEFAULT_SETTINGS.summaryThinking,
      summaryTimeoutMs: DEFAULT_SETTINGS.summaryTimeoutMs,
      ...overrides,
    },
    sessionLifecycle: {
      activeWindowMs: DEFAULT_SETTINGS.activeWindowMs,
      closeAfterMs: DEFAULT_SETTINGS.closeAfterMs,
      historyRetentionDays: DEFAULT_SETTINGS.historyRetentionDays,
    },
    revision,
  };
}
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

function settingsStructure(container: HTMLElement): Array<[string, string[]]> {
  return [...container.querySelectorAll<HTMLElement>('[data-settings-group]')].map((group) => {
    const sections = [...group.children]
      .filter((child): child is HTMLElement => child instanceof HTMLElement)
      .flatMap((child) => child.dataset.settingsSection ? [child.dataset.settingsSection] : []);
    return [group.dataset.settingsGroup ?? '', sections];
  });
}

const GENERAL_STRUCTURE: Array<[string, string[]]> = [
  ['会话', ['生命周期', '会话续接上下文', '间歇总结']],
  ['提醒与外观', ['提醒', '窗口', '快捷键']],
  ['集成与运行环境', ['Hook Server（本地端口）', '外部工具', '实验功能', '日志']],
  ['跨工具协作（MCP）', ['Agent Deck MCP']],
];

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
        getRemoteHostNodeConfiguration: vi.fn().mockResolvedValue(configuration({
            claudeCodeSandbox: 'strict',
            codexSandbox: 'read-only',
            enableAgentDeckMcp: true,
            grokSandbox: 'off',
            permissionTimeoutMs: 30_000,
            summaryModel: 'summary-model',
            summaryThinking: 'low',
            summaryTimeoutMs: 60_000,
          })),
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
    fireEvent.click(await screen.findByRole('button', { name: '实验功能' }));
    expect((screen.getByRole('textbox', {
      name: 'Claude Code 沙盒（系统隔离）',
    }) as HTMLInputElement).value).toBe('完全只读');
    fireEvent.click(screen.getByRole('button', { name: '外部工具' }));
    expect(screen.getByDisplayValue('/Applications/Agent Deck/claude')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Agent Deck MCP' }));
    expect((screen.getByRole('checkbox', { name: '允许会话使用协作功能' }) as HTMLInputElement).disabled)
      .toBe(true);
    expect((screen.getByRole('checkbox', {
      name: '允许 Codex CLI 和 Grok Build 连接',
    }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code 终端 Hook' }));
    expect((screen.getByRole('button', { name: '安装 Hook' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(screen.getAllByText(
      '远端运行设置仅供查看。通用页中的提醒、窗口、快捷键和日志仍使用这台电脑的设置。',
    )).toHaveLength(1);
    expect(localHookStatus).not.toHaveBeenCalled();
    expect(remoteHookStatus).toHaveBeenCalledTimes(3);
  });

  it('uses the exact Local group and section hierarchy in Remote general settings', async () => {
    const hookStatus = vi.fn().mockResolvedValue({
      installed: false,
      scope: 'user',
      settingsPath: '',
      installedHooks: [],
    });
    const remoteHookStatus = vi.fn().mockImplementation(
      ({ adapterId }: { adapterId: 'claude-code' | 'codex-cli' | 'grok-build' }) =>
        Promise.resolve({ adapterId, revision: 4, status: REMOTE_HOOK_STATUS }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
        hookStatus,
        getRemoteHostNodeConfiguration: vi.fn().mockResolvedValue(configuration({
            claudeCodeSandbox: 'strict', codexSandbox: 'read-only',
            enableAgentDeckMcp: true, grokSandbox: 'off', permissionTimeoutMs: 30_000,
            summaryModel: 'summary-model', summaryThinking: 'low', summaryTimeoutMs: 60_000,
          })),
        getRemoteHostNodeHookStatus: remoteHookStatus,
      },
    });

    const localView = render(<SettingsDialog open onClose={vi.fn()} />);
    await screen.findByRole('textbox', { name: '空闲多久后休眠（分钟）' });
    const localStructure = settingsStructure(localView.container);
    expect(localStructure).toEqual(GENERAL_STRUCTURE);
    localView.unmount();
    window.localStorage.clear();

    const remoteView = render(<SettingsDialog open onClose={vi.fn()} remote={{
      identity: 'remote-a:core-a:1',
      label: 'aws-relay-on-mac',
      profileId: 'remote-a',
      supportsNodeConfiguration: true,
      supportsNodeHooksRead: true,
      usable: true,
    }} />);
    await screen.findByRole('textbox', { name: '待处理请求超时' });
    const remoteStructure = settingsStructure(remoteView.container);
    expect(remoteStructure).toEqual(localStructure);
    expect(remoteStructure).toEqual(GENERAL_STRUCTURE);
    expect(remoteView.container.textContent).not.toContain('Worker 配置');
    expect(remoteView.container.textContent).not.toContain('Remote Core');
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
      '当前远端版本不支持读取设置，请升级后重试。',
    )).toBeTruthy();
    expect(localHookStatus).not.toHaveBeenCalled();
    expect(remoteHookStatus).not.toHaveBeenCalled();
  });

  it('loads Worker configuration after reconnecting without requiring the dialog to close', async () => {
    const remoteConfiguration = vi.fn().mockResolvedValue(configuration({
        claudeCodeSandbox: 'strict', codexSandbox: 'read-only',
        enableAgentDeckMcp: true, grokSandbox: 'off', permissionTimeoutMs: 30_000,
        summaryModel: '', summaryThinking: '', summaryTimeoutMs: 60_000,
      }, 8));
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
    expect(await screen.findByText(/远端环境尚未连接/)).toBeTruthy();
    expect(remoteConfiguration).not.toHaveBeenCalled();

    view.rerender(<SettingsDialog open onClose={vi.fn()} remote={{ ...base, usable: true }} />);
    expect((await screen.findByRole('textbox', {
      name: '待处理请求超时',
    }) as HTMLInputElement).value).toBe('30 秒');
    expect(remoteConfiguration).toHaveBeenCalledWith({ profileId: 'remote-a' });
    expect(remoteHookStatus).toHaveBeenCalledTimes(3);
  });

  it('ignores a same-identity Worker response that lands after disconnect', async () => {
    let resolveConfiguration!: (value: NodeConfigurationGetResult) => void;
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
      '当前远端环境尚未连接，暂时无法读取设置。',
    )).toBeTruthy();

    resolveConfiguration(configuration({
        claudeCodeSandbox: 'strict',
        codexSandbox: 'read-only',
        enableAgentDeckMcp: true,
        grokSandbox: 'off',
        permissionTimeoutMs: 30_000,
        summaryModel: 'stale-worker-model',
        summaryThinking: 'low',
        summaryTimeoutMs: 60_000,
      }, 99));
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
