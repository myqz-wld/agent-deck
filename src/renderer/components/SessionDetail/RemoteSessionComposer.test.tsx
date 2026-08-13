// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { RemoteSessionComposer } from './RemoteSessionComposer';

const ACTIVE_IMAGE_POLICY = {
  disabledReason: null,
  enabled: true,
  maxBytesEach: 2 * 1024 * 1024,
  maxBytesTotal: 2 * 1024 * 1024,
  maxCount: 4,
  mimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
};

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

  it('routes active-turn Codex text and images through Remote steer', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { confirmDialog: vi.fn() },
    });
    const remote = source({
      capabilities: new Set([
        'sessions.write',
        'sessions.runtime.write',
        'session-console.read',
        'sessions.input.read',
      ]),
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
      inputCapabilities: {
        adapterId: 'codex-cli',
        activeTurn: { mode: 'steer', attachments: ACTIVE_IMAGE_POLICY },
        revision: 6,
      },
    });
    const { container } = render(<RemoteSessionComposer
      source={remote}
      adapterId="codex-cli"
      sessionId="session-a"
    />);

    expect(await screen.findByPlaceholderText(/修正当前 Remote Codex CLI 轮次/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '上传图片' })).toBeTruthy();
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeTruthy();
    fireEvent.change(fileInput!, {
      target: { files: [new File([new Uint8Array([97])], 'steer.gif', { type: 'image/gif' })] },
    });
    await screen.findByAltText('steer.gif');
    fireEvent.change(screen.getByPlaceholderText(/修正当前 Remote Codex CLI 轮次/), {
      target: { value: 'focus on the failing test' },
    });
    fireEvent.click(screen.getByRole('button', { name: '修正' }));
    await waitFor(() => expect(remote.steer).toHaveBeenCalledWith(
      'focus on the failing test',
      [{ kind: 'image', base64: 'YQ==', mime: 'image/gif', bytes: 1 }],
    ));
    expect(remote.send).not.toHaveBeenCalled();
  });

  it('queues active-turn Claude images through Remote send instead of steer', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { confirmDialog: vi.fn() },
    });
    const remote = source({
      capabilities: new Set([
        'sessions.write',
        'sessions.runtime.write',
        'session-console.read',
        'sessions.input.read',
      ]),
      selectedSession: {
        id: 'session-a', adapterId: 'claude-code', title: 'Remote Claude',
        status: 'active-working', createdAt: 1, updatedAt: 2,
      },
      inputCapabilities: {
        adapterId: 'claude-code',
        activeTurn: { mode: 'queue', attachments: ACTIVE_IMAGE_POLICY },
        revision: 6,
      },
    });
    const { container } = render(<RemoteSessionComposer
      source={remote}
      adapterId="claude-code"
      sessionId="session-a"
    />);

    const input = await screen.findByPlaceholderText(/排队发送给当前 Remote Claude Code 轮次/);
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(fileInput!, {
      target: { files: [new File([new Uint8Array([98])], 'queued.gif', { type: 'image/gif' })] },
    });
    await screen.findByAltText('queued.gif');
    fireEvent.change(input, { target: { value: 'consider this image next' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(remote.send).toHaveBeenCalledWith(
      'consider this image next',
      [{ kind: 'image', base64: 'Yg==', mime: 'image/gif', bytes: 1 }],
    ));
    expect(remote.steer).not.toHaveBeenCalled();
  });

  it('keeps legacy active-turn steering text-only without the negotiated input capability', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { confirmDialog: vi.fn() },
    });
    const remote = source({
      selectedSession: {
        id: 'session-a', adapterId: 'codex-cli', title: 'Legacy Remote Codex',
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

    const input = await screen.findByPlaceholderText(/修正当前 Remote Codex CLI 轮次/);
    expect(screen.queryByRole('button', { name: '上传图片' })).toBeNull();
    fireEvent.change(input, { target: { value: 'text only' } });
    fireEvent.click(screen.getByRole('button', { name: '修正' }));
    await waitFor(() => expect(remote.steer).toHaveBeenCalledWith('text only', []));
  });

  it('keeps next-turn runtime controls editable while a provider turn is working', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { confirmDialog: vi.fn() },
    });
    const remote = source({
      capabilities: new Set([
        'sessions.write', 'sessions.runtime.write', 'sessions.handoff', 'session-console.read',
      ]),
      selectedSession: {
        id: 'session-a', adapterId: 'codex-cli', title: 'Remote Codex',
        status: 'active-working', createdAt: 1, updatedAt: 2,
      },
      runtime: {
        adapterId: 'codex-cli',
        values: {
          model: 'gpt-5.6-sol', approvalPolicy: 'on-request',
          codexSandbox: 'workspace-write',
        },
        revision: 5,
      },
    });
    render(<RemoteSessionComposer source={remote} adapterId="codex-cli" sessionId="session-a" />);

    expect((screen.getByRole('button', { name: '接力' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('模型') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('审批') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText('沙盒') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByLabelText('审批'));
    fireEvent.click(screen.getByRole('option', { name: '从不询问' }));
    await waitFor(() => expect(remote.updateRuntime).toHaveBeenCalledWith({
      approvalPolicy: 'never',
    }));
  });

  it('shows provider-default runtime values instead of inventing concrete policies', () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { confirmDialog: vi.fn() },
    });
    const remote = source({
      selectedSession: {
        id: 'session-a', adapterId: 'codex-cli', title: 'Remote Codex',
        status: 'active-idle', createdAt: 1, updatedAt: 2,
      },
      runtime: {
        adapterId: 'codex-cli',
        values: { model: 'gpt-5.6-sol', approvalPolicy: null, codexSandbox: null },
        revision: 5,
      },
    });
    render(<RemoteSessionComposer source={remote} adapterId="codex-cli" sessionId="session-a" />);

    expect(screen.getAllByText('由提供方默认值决定（未记录权威值）')).toHaveLength(2);
    expect(screen.queryByText('NEVER')).toBeNull();
    expect(screen.queryByText('工作区可写')).toBeNull();
  });

  it('renders and removes the Remote provider waiting queue without exposing attachment paths', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { confirmDialog: vi.fn() },
    });
    const listOutgoing = vi.fn().mockResolvedValue({
      sessionId: 'session-a', adapterId: 'claude-code', revision: 7,
      messages: [{
        id: 'queued-1', text: '等待下一轮处理',
        attachments: [{ id: 'queued-1:0', mime: 'image/png', bytes: 12 }],
      }],
    });
    const removeOutgoing = vi.fn().mockResolvedValue(true);
    const remote = source({
      capabilities: new Set([
        'sessions.write', 'sessions.runtime.write', 'session-console.read',
        'sessions.outgoing.read', 'sessions.outgoing.write',
      ]),
      listOutgoing,
      removeOutgoing,
    });
    render(<RemoteSessionComposer source={remote} adapterId="claude-code" sessionId="session-a" />);

    await screen.findByText(/等待下一轮处理/);
    expect(screen.getByText(/1 个附件/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('/private/');
    fireEvent.click(screen.getByRole('button', { name: '删除等待消息' }));
    await waitFor(() => expect(removeOutgoing).toHaveBeenCalledWith('queued-1'));
    expect(listOutgoing).toHaveBeenCalled();
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
