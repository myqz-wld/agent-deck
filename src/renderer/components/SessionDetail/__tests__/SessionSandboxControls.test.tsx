// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionRecord } from '@shared/types';
import { SessionSandboxControls } from '../composer-sdk/SessionSandboxControls';

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'grok-session',
    agentId: 'grok-build',
    cwd: '/repo',
    title: 'Grok',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    grokSandbox: 'workspace',
    ...overrides,
  };
}

let restartWithGrokSandbox: ReturnType<typeof vi.fn>;
let setCodexSandbox: ReturnType<typeof vi.fn>;
let restartWithClaudeCodeSandbox: ReturnType<typeof vi.fn>;
let setCodexApprovalPolicy: ReturnType<typeof vi.fn>;
let confirmDialog: ReturnType<typeof vi.fn>;

beforeEach(() => {
  restartWithGrokSandbox = vi.fn().mockResolvedValue('grok-session');
  setCodexSandbox = vi.fn().mockResolvedValue(undefined);
  restartWithClaudeCodeSandbox = vi.fn().mockResolvedValue('claude-session');
  setCodexApprovalPolicy = vi.fn().mockResolvedValue(undefined);
  confirmDialog = vi.fn().mockResolvedValue(true);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      restartWithGrokSandbox,
      setCodexSandbox,
      restartWithClaudeCodeSandbox,
      setCodexApprovalPolicy,
      confirmDialog,
    } as unknown as Window['api'],
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('Codex live approval control', () => {
  it('shows strict-to-loose policies and applies the choice to the next turn', async () => {
    const view = render(
      <SessionSandboxControls
        session={session({
          id: 'codex-session',
          agentId: 'codex-cli',
          codexApprovalPolicy: null,
          codexSandbox: 'workspace-write',
        })}
        turnBusy={false}
      />,
    );

    expect(screen.getByLabelText('审批').textContent).toContain('从不询问');
    fireEvent.click(screen.getByLabelText('审批'));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '非可信命令前询问',
      '按需询问',
      '从不询问',
    ]);
    fireEvent.click(screen.getByRole('option', { name: '按需询问' }));

    await waitFor(() => {
      expect(setCodexApprovalPolicy).toHaveBeenCalledWith(
        'codex-cli',
        'codex-session',
        'on-request',
      );
    });

    view.rerender(
      <SessionSandboxControls
        session={session({
          id: 'codex-session',
          agentId: 'codex-cli',
          codexApprovalPolicy: 'on-request',
          codexSandbox: 'workspace-write',
        })}
        turnBusy
      />,
    );
    expect((screen.getByLabelText('审批') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('uses canonical Codex CLI copy in the fully open sandbox confirmation', async () => {
    render(
      <SessionSandboxControls
        session={session({
          id: 'codex-session',
          agentId: 'codex-cli',
          codexSandbox: 'workspace-write',
        })}
        turnBusy={false}
      />,
    );

    fireEvent.click(screen.getByLabelText('沙盒'));
    fireEvent.click(screen.getByRole('option', { name: '⚠️ 完全开放' }));

    await waitFor(() => {
      expect(confirmDialog).toHaveBeenCalledWith({
        title: '关闭 Codex CLI 沙盒（完全开放）',
        message: '将从 Codex CLI 的下一轮对话起生效',
        detail:
          '关闭后，Codex CLI 可以读写任意文件、执行任意命令。当前正在运行的轮次不会中断，后续消息会使用新设置。\n\n失败时会自动恢复当前沙盒设置。继续？',
        okLabel: '关闭沙盒',
        cancelLabel: '取消',
        destructive: true,
      });
    });
  });
});

describe('Claude Code live sandbox control', () => {
  it('uses canonical Claude Code copy in the fully open sandbox confirmation', async () => {
    render(
      <SessionSandboxControls
        session={session({
          id: 'claude-session',
          agentId: 'claude-code',
          claudeCodeSandbox: 'workspace-write',
        })}
        turnBusy={false}
      />,
    );

    fireEvent.click(screen.getByLabelText('沙盒'));
    fireEvent.click(screen.getByRole('option', { name: '⚠️ 完全开放' }));

    await waitFor(() => {
      expect(confirmDialog).toHaveBeenCalledWith({
        title: '关闭 Claude Code 系统沙盒',
        message: '需要重启当前 Claude Code 会话',
        detail:
          '重启后，Claude Code 不再受系统沙盒约束（仅靠应用内授权弹窗管控）。重启约需 5–10 秒。\n\n失败时会自动恢复当前沙盒设置。继续？',
        okLabel: '重启并关闭沙盒',
        cancelLabel: '取消',
        destructive: true,
      });
    });
  });
});

describe('Grok Build live sandbox control', () => {
  it('requests a built-in profile through the Grok Build cold restart API', async () => {
    render(<SessionSandboxControls session={session()} turnBusy={false} />);

    fireEvent.click(screen.getByLabelText('沙盒'));
    expect(
      screen.getByRole('option', { name: '跟随 Grok Build 原生配置' }).title,
    ).toBe('不添加 --sandbox，由 Grok Build 配置、环境变量或托管策略决定');
    fireEvent.click(screen.getByRole('option', { name: '广泛只读' }));

    await waitFor(() => {
      expect(restartWithGrokSandbox).toHaveBeenCalledWith(
        'grok-build',
        'grok-session',
        'read-only',
      );
    });
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it('supports a custom sandbox.toml profile without restarting while typing', async () => {
    render(<SessionSandboxControls session={session()} turnBusy={false} />);

    fireEvent.click(screen.getByLabelText('沙盒'));
    fireEvent.click(screen.getByRole('option', { name: '自定义配置…' }));
    fireEvent.change(screen.getByLabelText('自定义沙盒配置名称'), {
      target: { value: 'project-locked' },
    });
    expect(restartWithGrokSandbox).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '应用' }));

    await waitFor(() => {
      expect(restartWithGrokSandbox).toHaveBeenCalledWith(
        'grok-build',
        'grok-session',
        'project-locked',
      );
    });
  });

  it('restores the current custom selection when a built-in switch fails', async () => {
    restartWithGrokSandbox.mockRejectedValueOnce(new Error('switch failed'));
    render(
      <SessionSandboxControls
        session={session({ grokSandbox: 'project-locked' })}
        turnBusy={false}
      />,
    );

    fireEvent.click(screen.getByLabelText('沙盒'));
    fireEvent.click(screen.getByRole('option', { name: '广泛只读' }));

    await waitFor(() => {
      expect(screen.getByText(/switch failed/)).toBeTruthy();
      expect(
        (screen.getByLabelText(
          '自定义沙盒配置名称',
        ) as HTMLInputElement).value,
      ).toBe('project-locked');
    });
  });

  it('shows an arbitrary strict-named custom profile without offering it as a built-in', () => {
    render(
      <SessionSandboxControls
        session={session({ grokSandbox: 'strict' })}
        turnBusy={false}
      />,
    );

    expect(
      (screen.getByLabelText(
        '自定义沙盒配置名称',
      ) as HTMLInputElement).value,
    ).toBe('strict');
    expect(
      (screen.getByLabelText(
        '自定义沙盒配置名称',
      ) as HTMLInputElement).placeholder,
    ).toBe('输入 sandbox.toml 配置名称');
    fireEvent.click(screen.getByLabelText('沙盒'));
    expect(screen.queryByRole('option', { name: '严格隔离' })).toBeNull();
    expect(screen.queryByRole('option', { name: '开发机宽松' })).toBeNull();
  });

  it('confirms an off request and disables switching while the turn is busy', async () => {
    const view = render(
      <SessionSandboxControls session={session()} turnBusy={false} />,
    );
    fireEvent.click(screen.getByLabelText('沙盒'));
    fireEvent.click(screen.getByRole('option', { name: '⚠️ 完全开放' }));

    await waitFor(() => {
      expect(confirmDialog).toHaveBeenCalledWith({
        title: '关闭 Grok Build 系统沙盒',
        message: '需要重启当前 Grok Build 会话',
        detail:
          '重启后，Grok Build 不再受系统沙盒约束，但工具授权规则仍然生效。仅空闲会话可以切换；失败时会自动恢复当前档位。\n\n继续？',
        okLabel: '重启并关闭沙盒',
        cancelLabel: '取消',
        destructive: true,
      });
    });
    expect(restartWithGrokSandbox).toHaveBeenCalledWith(
      'grok-build',
      'grok-session',
      'off',
    );

    view.rerender(<SessionSandboxControls session={session()} turnBusy />);
    expect(
      (screen.getByLabelText(
        '沙盒',
      ) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
