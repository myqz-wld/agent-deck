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
let restartWithCodexSandbox: ReturnType<typeof vi.fn>;
let setCodexApprovalPolicy: ReturnType<typeof vi.fn>;
let confirmDialog: ReturnType<typeof vi.fn>;

beforeEach(() => {
  restartWithGrokSandbox = vi.fn().mockResolvedValue('grok-session');
  restartWithCodexSandbox = vi.fn().mockResolvedValue('codex-session');
  setCodexApprovalPolicy = vi.fn().mockResolvedValue(undefined);
  confirmDialog = vi.fn().mockResolvedValue(true);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      restartWithGrokSandbox,
      restartWithCodexSandbox,
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

    fireEvent.click(screen.getByLabelText('审批'));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '非可信命令前询问',
      '按需询问',
      '从不询问',
    ]);
    fireEvent.click(screen.getByRole('option', { name: '从不询问' }));

    await waitFor(() => {
      expect(setCodexApprovalPolicy).toHaveBeenCalledWith(
        'codex-cli',
        'codex-session',
        'never',
      );
    });

    view.rerender(
      <SessionSandboxControls
        session={session({
          id: 'codex-session',
          agentId: 'codex-cli',
          codexApprovalPolicy: 'never',
          codexSandbox: 'workspace-write',
        })}
        turnBusy
      />,
    );
    expect(
      (screen.getByLabelText('审批') as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe('Grok live sandbox control', () => {
  it('requests a built-in profile through the Grok-only cold restart API', async () => {
    render(<SessionSandboxControls session={session()} turnBusy={false} />);

    fireEvent.click(screen.getByLabelText('Grok 沙盒（请求档位）'));
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

    fireEvent.click(screen.getByLabelText('Grok 沙盒（请求档位）'));
    fireEvent.click(screen.getByRole('option', { name: '自定义 profile…' }));
    fireEvent.change(screen.getByLabelText('Grok 自定义沙盒 profile'), {
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

    fireEvent.click(screen.getByLabelText('Grok 沙盒（请求档位）'));
    fireEvent.click(screen.getByRole('option', { name: '广泛只读' }));

    await waitFor(() => {
      expect(screen.getByText(/switch failed/)).toBeTruthy();
      expect(
        (screen.getByLabelText(
          'Grok 自定义沙盒 profile',
        ) as HTMLInputElement).value,
      ).toBe('project-locked');
    });
  });

  it('shows a legacy strict value as a custom profile without offering removed built-ins', () => {
    render(
      <SessionSandboxControls
        session={session({ grokSandbox: 'strict' })}
        turnBusy={false}
      />,
    );

    expect(
      (screen.getByLabelText('Grok 自定义沙盒 profile') as HTMLInputElement).value,
    ).toBe('strict');
    fireEvent.click(screen.getByLabelText('Grok 沙盒（请求档位）'));
    expect(screen.queryByRole('option', { name: '严格隔离' })).toBeNull();
    expect(screen.queryByRole('option', { name: '开发机宽松' })).toBeNull();
  });

  it('confirms an off request and disables switching while the turn is busy', async () => {
    const view = render(
      <SessionSandboxControls session={session()} turnBusy={false} />,
    );
    fireEvent.click(screen.getByLabelText('Grok 沙盒（请求档位）'));
    fireEvent.click(screen.getByRole('option', { name: '⚠️ 完全开放' }));

    await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
    expect(restartWithGrokSandbox).toHaveBeenCalledWith(
      'grok-build',
      'grok-session',
      'off',
    );

    view.rerender(<SessionSandboxControls session={session()} turnBusy />);
    expect(
      (screen.getByLabelText('Grok 沙盒（请求档位）') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
