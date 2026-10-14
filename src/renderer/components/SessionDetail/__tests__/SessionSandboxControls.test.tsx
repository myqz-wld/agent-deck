import { confirmDialog as requestConfirmation } from '@renderer/lib/confirm-dialog';
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@renderer/lib/confirm-dialog', () => ({ confirmDialog: vi.fn() }));
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
  confirmDialog = vi.mocked(requestConfirmation).mockReset().mockResolvedValue(true);
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
  it('keeps sandbox selection separate from the common permission control', () => {
    render(<SessionSandboxControls session={session({ agentId: 'codex-cli', codexSandbox: 'workspace-write' })} turnBusy={false} />);
    expect(screen.getByLabelText('沙盒')).toBeTruthy();
    expect(screen.queryByLabelText('审批')).toBeNull();
    expect(setCodexApprovalPolicy).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole('option', { name: '完全开放' }));

    await waitFor(() => {
      expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({
        title: '将沙盒设为完全开放？',
        detail: '从下一轮生效，当前轮次继续运行。',
        okLabel: '确认切换',
        cancelLabel: '取消',
        destructive: true,
      }));
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
    fireEvent.click(screen.getByRole('option', { name: '完全开放' }));

    await waitFor(() => {
      expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({
        title: '将沙盒设为完全开放？',
        detail: '当前会话会重启。',
        okLabel: '确认切换',
        cancelLabel: '取消',
        destructive: true,
      }));
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

  it('confirms an off request and keeps next-turn switching available while busy', async () => {
    const view = render(
      <SessionSandboxControls session={session()} turnBusy={false} />,
    );
    fireEvent.click(screen.getByLabelText('沙盒'));
    fireEvent.click(screen.getByRole('option', { name: '完全开放' }));

    await waitFor(() => {
      expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({
        title: '将沙盒设为完全开放？',
        detail: '当前轮结束后会重启会话。',
        okLabel: '确认切换',
        cancelLabel: '取消',
        destructive: true,
      }));
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
    ).toBe(false);

    fireEvent.click(screen.getByLabelText('沙盒'));
    fireEvent.click(screen.getByRole('option', { name: '广泛只读' }));
    await waitFor(() => {
      expect(restartWithGrokSandbox).toHaveBeenLastCalledWith(
        'grok-build',
        'grok-session',
        'read-only',
      );
    });
  });
});
