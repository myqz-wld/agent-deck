// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { RemoteSessionComposer } from './RemoteSessionComposer';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

function source(overrides: Partial<RemoteSessionSourceView> = {}): RemoteSessionSourceView {
  return {
    identity: 'remote-a:core-a:1',
    busy: false,
    usable: true,
    capabilities: new Set([
      'sessions.write',
      'sessions.runtime.write',
      'session-console.read',
    ]),
    selectedSessionId: 'session-a',
    selectedSession: {
      id: 'session-a',
      adapterId: 'claude-code',
      title: 'Remote Claude',
      status: 'active-idle',
      createdAt: 1,
      updatedAt: 2,
    },
    runtime: {
      adapterId: 'claude-code',
      values: {
        provider: 'deepseek',
        model: 'deepseek-v4-flash[1m]',
        thinking: 'max',
        permissionMode: 'default',
        claudeCodeSandbox: 'strict',
      },
      revision: 4,
    },
    getSessionCapabilities: vi.fn().mockResolvedValue({
      create: { attachments: { enabled: true } },
    } as never),
    send: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    updateRuntime: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as RemoteSessionSourceView;
}

describe('RemoteSessionComposer parity and authority', () => {
  it('reuses the Local composer surface while routing message and runtime writes to Remote', async () => {
    const listLocalClaudeGateways = vi.fn();
    const listLocalCodexProviders = vi.fn();
    const confirmDialog = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listClaudeGatewayProfiles: listLocalClaudeGateways,
        listCodexModelProviders: listLocalCodexProviders,
        confirmDialog,
      },
    });
    const remote = source();
    render(<RemoteSessionComposer
      source={remote}
      adapterId="claude-code"
      sessionId="session-a"
    />);

    expect(screen.getByDisplayValue('deepseek-v4-flash[1m]')).toBeTruthy();
    expect(screen.getByRole('button', { name: '放大输入框' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: '上传图片' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '接力' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole('button', { name: '中断' }) as HTMLButtonElement).disabled)
      .toBe(true);

    const input = screen.getByPlaceholderText(/给 Remote Claude Code 发消息/);
    fireEvent.change(input, { target: { value: 'remote hello' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(remote.send).toHaveBeenCalledWith('remote hello', []));

    fireEvent.click(screen.getByLabelText('沙盒'));
    fireEvent.click(screen.getByRole('option', { name: '⚠️ 完全开放' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '关闭 Remote Claude Code 系统沙盒',
    })));
    await waitFor(() => expect(remote.updateRuntime).toHaveBeenCalledWith({
      claudeCodeSandbox: 'off',
    }));

    expect(listLocalClaudeGateways).not.toHaveBeenCalled();
    expect(listLocalCodexProviders).not.toHaveBeenCalled();
  });

  it('keeps active-turn Codex steering text-only and on the selected Remote source', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { confirmDialog: vi.fn() },
    });
    const remote = source({
      selectedSession: {
        id: 'session-a', adapterId: 'codex-cli', title: 'Remote Codex',
        status: 'active-working', createdAt: 1, updatedAt: 2,
      },
      runtime: {
        adapterId: 'codex-cli',
        values: {
          provider: '', model: 'gpt-5.6-sol', thinking: 'low',
          approvalPolicy: 'on-request', codexSandbox: 'workspace-write',
        },
        revision: 5,
      },
    });
    render(<RemoteSessionComposer
      source={remote}
      adapterId="codex-cli"
      sessionId="session-a"
    />);

    expect(await screen.findByPlaceholderText(/修正当前 Remote Codex CLI 轮次/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '上传图片' })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/修正当前 Remote Codex CLI 轮次/), {
      target: { value: 'focus on the failing test' },
    });
    fireEvent.click(screen.getByRole('button', { name: '修正' }));
    await waitFor(() => expect(remote.steer).toHaveBeenCalledWith('focus on the failing test'));
    expect(remote.send).not.toHaveBeenCalled();
  });

  it('filters the file picker with the Worker-negotiated attachment MIME policy', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { confirmDialog: vi.fn() },
    });
    const remote = source({
      getSessionCapabilities: vi.fn().mockResolvedValue({
        create: {
          attachments: {
            enabled: true,
            maxBytesEach: 1_024,
            maxBytesTotal: 2_048,
            maxCount: 2,
            mimeTypes: ['image/png', 'image/webp'],
          },
        },
      } as never),
    });
    const { container } = render(<RemoteSessionComposer
      source={remote}
      adapterId="claude-code"
      sessionId="session-a"
    />);

    await screen.findByRole('button', { name: '上传图片' });
    await waitFor(() => expect(
      container.querySelector<HTMLInputElement>('input[type="file"]')?.accept,
    ).toBe('image/png,image/webp'));
  });

  it('persists one coherent Remote model selection when a debounced model and thinking change overlap', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { confirmDialog: vi.fn() },
    });
    const remote = source();
    render(<RemoteSessionComposer
      source={remote}
      adapterId="claude-code"
      sessionId="session-a"
    />);

    fireEvent.change(screen.getByLabelText('模型'), {
      target: { value: 'deepseek-v4-flash-next' },
    });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'HIGH' }));

    await waitFor(() => expect(remote.updateRuntime).toHaveBeenCalledWith({
      provider: 'deepseek',
      model: 'deepseek-v4-flash-next',
      thinking: 'high',
    }));
    expect(remote.updateRuntime).toHaveBeenCalledTimes(1);
  });
});
