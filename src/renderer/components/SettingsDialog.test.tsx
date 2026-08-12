// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '@shared/types';
import { SettingsDialog } from './SettingsDialog';
import { GrokSandboxPicker } from './GrokSandboxPicker';

const RAW_BACKEND_ERROR =
  'RAW_BACKEND_MARKER secret=sk-live-token path=/Users/alice/.config URL=https://internal.example';
const HOOK_STATUS = {
  installed: false,
  scope: 'user',
  settingsPath: '/safe/settings.json',
  installedHooks: [],
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
  it('includes Grok Build authentication and external terminal Hook controls', async () => {
    const hookStatus = vi.fn().mockResolvedValue({
      installed: false,
      scope: 'user',
      settingsPath: '',
      installedHooks: [],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
        hookStatus,
      },
    });

    render(<SettingsDialog open onClose={vi.fn()} />);
    const grokTab = await screen.findByRole('tab', { name: 'Grok Build' });
    fireEvent.click(grokTab);

    expect(screen.getByText('Grok Build 配置')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ACP 认证' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Grok Build 终端 Hook' })).toBeTruthy();
    expect(hookStatus).toHaveBeenCalledWith('user', undefined, 'grok-build');
  });

  it('shows canonical runtime names in terminal Hook load errors', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
        hookStatus: vi.fn().mockRejectedValue(new Error(RAW_BACKEND_ERROR)),
      },
    });

    render(<SettingsDialog open onClose={vi.fn()} />);

    await screen.findByText(
      'Claude Code 终端 Hook 状态读取失败，请重试。\n' +
        'Codex CLI 终端 Hook 状态读取失败，请重试。\n' +
        'Grok Build 终端 Hook 状态读取失败，请重试。',
      { normalizer: (value) => value },
    );
    expectRawBackendDetailsHidden();
  });

  it('recovers with defaults without exposing a settings-read exception', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockRejectedValue(new Error(RAW_BACKEND_ERROR)),
        hookStatus: vi.fn().mockResolvedValue(HOOK_STATUS),
      },
    });

    render(<SettingsDialog open onClose={vi.fn()} />);

    expect(await screen.findByText('设置读取失败，请重试。')).toBeTruthy();
    expect(
      await screen.findByRole('textbox', { name: '空闲多久后休眠（分钟）' }),
    ).toBeTruthy();
    expectRawBackendDetailsHidden();
  });

  it('shows a fixed save failure without exposing the backend exception', async () => {
    const setSettings = vi.fn().mockRejectedValue(new Error(RAW_BACKEND_ERROR));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
        hookStatus: vi.fn().mockResolvedValue(HOOK_STATUS),
        setSettings,
      },
    });

    render(<SettingsDialog open onClose={vi.fn()} />);

    const input = await screen.findByRole('textbox', {
      name: '空闲多久后休眠（分钟）',
    });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '61' } });
    fireEvent.blur(input);

    expect(await screen.findByText('保存设置失败，请重试。')).toBeTruthy();
    expect(setSettings).toHaveBeenCalledWith({ activeWindowMs: 3_660_000 });
    expectRawBackendDetailsHidden();
  });

  it('uses canonical executable and sandbox copy, including custom Grok Build profiles', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue({
          ...DEFAULT_SETTINGS,
          grokSandbox: 'strict',
        }),
        hookStatus: vi.fn().mockResolvedValue({
          installed: false,
          scope: 'user',
          settingsPath: '',
          installedHooks: [],
        }),
      },
    });

    const { container } = render(<SettingsDialog open onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '外部工具' }));
    expect(screen.getByText('Codex CLI 二进制路径')).toBeTruthy();
    expect(
      screen.getByText(
        '留空会使用应用内置 Codex CLI（推荐）。要指定外部程序，可在终端运行 which codex 后填入返回路径。',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Claude Code 二进制路径')).toBeTruthy();
    expect(
      screen.getByText(
        '留空会使用应用内置 Claude Code（推荐）。要指定外部程序，可在终端运行 which claude 后填入返回路径。',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '实验功能' }));
    expect(screen.getByText('Codex CLI 沙盒（系统隔离）')).toBeTruthy();
    expect(screen.getByText('Grok Build 沙盒（请求档位）')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Grok Build 沙盒请求档位' }),
    ).toBeTruthy();
    expect(
      (screen.getByRole('textbox', {
        name: 'Grok Build 自定义沙盒配置名称',
      }) as HTMLInputElement).value,
    ).toBe('strict');
    expect(
      (screen.getByRole('textbox', {
        name: 'Grok Build 自定义沙盒配置名称',
      }) as HTMLInputElement).placeholder,
    ).toBe('输入自定义 sandbox.toml 配置名称');
    expect(container.textContent).toContain(
      '可选广泛只读、工作目录可写、完全开放，或输入 sandbox.toml 中定义的配置名称；企业托管要求仍可能覆盖这里的请求。',
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Grok Build 沙盒请求档位' }),
    );
    expect(screen.getByRole('option', { name: '自定义配置…' }).title).toBe(
      '使用 ~/.grok/sandbox.toml 或项目 .grok/sandbox.toml 中定义的配置名称',
    );
  });

  it('uses canonical Grok Build copy when inheriting sandbox configuration', () => {
    render(<GrokSandboxPicker value="" onChange={vi.fn()} />);

    const picker = screen.getByRole('button', {
      name: 'Grok Build 沙盒请求档位',
    });
    expect(picker.title).toBe(
      '不添加会话级覆盖，使用 Agent Deck 设置或 Grok Build 原生配置',
    );
    fireEvent.click(picker);
    expect(screen.getByRole('option', { name: '跟随设置（默认）' }).title).toBe(
      '不添加会话级覆盖，使用 Agent Deck 设置或 Grok Build 原生配置',
    );
  });

  it.each([
    [
      'Claude Code',
      'claude-code',
      '安装到 ~/.claude/settings.json',
    ],
    [
      'Codex CLI',
      'codex-cli',
      '安装到 ~/.codex/hooks.json',
    ],
    [
      'Grok Build',
      'grok-build',
      '安装到 ~/.grok/hooks/agent-deck.json',
    ],
  ] as const)(
    'shows fixed %s terminal Hook installation failures',
    async (displayName, adapterId, installLabel) => {
      const installHook = vi.fn().mockRejectedValue(new Error(RAW_BACKEND_ERROR));
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
          hookStatus: vi.fn().mockResolvedValue(HOOK_STATUS),
          installHook,
        },
      });

      render(<SettingsDialog open onClose={vi.fn()} />);

      fireEvent.click(await screen.findByRole('tab', { name: displayName }));
      fireEvent.click(
        screen.getByRole('button', { name: `${displayName} 终端 Hook` }),
      );
      fireEvent.click(screen.getByRole('button', { name: installLabel }));

      expect(
        await screen.findByText(
          `${displayName} 终端 Hook 安装失败，请重试。`,
        ),
      ).toBeTruthy();
      expect(installHook).toHaveBeenCalledWith('user', undefined, adapterId);
      expectRawBackendDetailsHidden();
    },
  );

  it.each([
    ['Claude Code', 'claude-code'],
    ['Codex CLI', 'codex-cli'],
    ['Grok Build', 'grok-build'],
  ] as const)(
    'shows fixed %s terminal Hook removal failures',
    async (displayName, adapterId) => {
      const uninstallHook = vi.fn().mockRejectedValue(new Error(RAW_BACKEND_ERROR));
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
          hookStatus: vi.fn().mockResolvedValue({
            ...HOOK_STATUS,
            installed: true,
            installedHooks: ['SessionStart'],
          }),
          uninstallHook,
        },
      });

      render(<SettingsDialog open onClose={vi.fn()} />);

      fireEvent.click(await screen.findByRole('tab', { name: displayName }));
      fireEvent.click(
        screen.getByRole('button', { name: `${displayName} 终端 Hook` }),
      );
      fireEvent.click(screen.getByRole('button', { name: '卸载' }));

      expect(
        await screen.findByText(
          `${displayName} 终端 Hook 卸载失败，请重试。`,
        ),
      ).toBeTruthy();
      expect(uninstallHook).toHaveBeenCalledWith('user', undefined, adapterId);
      expectRawBackendDetailsHidden();
    },
  );
});
