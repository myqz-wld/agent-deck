// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewSessionDialog } from '../NewSessionDialog';

let chooseDirectory: ReturnType<typeof vi.fn>;
let createAdapterSession: ReturnType<typeof vi.fn>;
let resolveChooseDirectory: (value: string | null) => void;

function sessionCreationDefaults(
  approvalPolicy: 'untrusted' | 'on-request' | 'never' = 'on-request',
) {
  return {
    provider: '',
    model: '',
    thinking: 'high' as const,
    permissionMode: 'bypassPermissions' as const,
    sessionMode: 'default' as const,
    approvalPolicy,
    codexSandbox: 'workspace-write' as const,
    claudeCodeSandbox: 'workspace-write' as const,
    grokSandbox: 'workspace',
  };
}

beforeEach(() => {
  chooseDirectory = vi.fn(
    () =>
      new Promise<string | null>((resolve) => {
        resolveChooseDirectory = resolve;
      }),
  );
  createAdapterSession = vi.fn().mockResolvedValue('session-new');
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listAdapters: vi.fn().mockResolvedValue([
        {
          id: 'claude-code',
          displayName: 'Claude',
          capabilities: {
            canCreateSession: true,
            canSetPermissionMode: true,
          },
        },
      ]),
      getAdapterSessionCreationDefaults: vi.fn().mockResolvedValue(sessionCreationDefaults()),
      listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
      listCodexModelProviders: vi.fn().mockResolvedValue([]),
      chooseDirectory,
      createAdapterSession,
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('NewSessionDialog directory picker', () => {
  it('dedupes repeated directory picker clicks while the native dialog is open', async () => {
    render(<NewSessionDialog open={true} onClose={vi.fn()} onCreated={vi.fn()} />);

    const chooseButton = (await screen.findByText('选择…')) as HTMLButtonElement;
    fireEvent.click(chooseButton);
    fireEvent.click(chooseButton);

    expect(chooseDirectory).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      const pendingButton = screen.getByText('选择中…') as HTMLButtonElement;
      expect(pendingButton.disabled).toBe(true);
    });

    await act(async () => {
      resolveChooseDirectory('/tmp/agent-deck');
    });

    await waitFor(() => {
      const cwdInput = screen.getByPlaceholderText('留空则使用主目录（~）') as HTMLInputElement;
      expect(cwdInput.value).toBe('/tmp/agent-deck');
    });
    const readyButton = screen.getByText('选择…') as HTMLButtonElement;
    expect(readyButton.disabled).toBe(false);
  });
});

describe('NewSessionDialog model options', () => {
  it('显示配置文件的具体模型与思考值，清空模型后仍交给配置文件决定', async () => {
    const defaultsReader = vi.fn().mockResolvedValue({
      ...sessionCreationDefaults(),
      model: 'claude-config-model',
      thinking: 'max',
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        getAdapterSessionCreationDefaults: defaultsReader,
      },
    });
    render(<NewSessionDialog open={true} onClose={vi.fn()} onCreated={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/模型：claude-config-model/)).toBeTruthy();
      expect(screen.getByText(/思考：MAX/)).toBeTruthy();
    });
    fireEvent.click(screen.getByText('模型配置'));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText(/输入任务或问题/), {
      target: { value: '使用配置模型' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(createAdapterSession).toHaveBeenCalledWith(
        'claude-code',
        expect.objectContaining({ thinking: 'max' }),
      );
    });
    expect(createAdapterSession.mock.calls[0]?.[1]).not.toHaveProperty('model');
  });

  it('把 Gateway、自由文本模型与 adapter-aware 思考程度透传给创建 IPC', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<NewSessionDialog open={true} onClose={onClose} onCreated={onCreated} />);

    const disclosure = (await screen.findByText('模型配置')).closest('details');
    expect(disclosure?.open).toBe(false);
    fireEvent.click(screen.getByText('模型配置'));
    expect(disclosure?.open).toBe(true);
    fireEvent.change(await screen.findByLabelText('Gateway'), {
      target: { value: 'deepseek' },
    });
    fireEvent.change(await screen.findByLabelText('模型'), {
      target: { value: 'claude-custom-preview' },
    });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'XHIGH' }));
    fireEvent.change(screen.getByPlaceholderText(/输入任务或问题/), {
      target: { value: '完成这个任务' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(createAdapterSession).toHaveBeenCalledWith(
        'claude-code',
        expect.objectContaining({
          prompt: '完成这个任务',
          provider: 'deepseek',
          model: 'claude-custom-preview',
          thinking: 'xhigh',
        }),
      );
    });
    expect(onCreated).toHaveBeenCalledWith('session-new');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows and forwards adapter-native Grok work modes', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listAdapters: vi.fn().mockResolvedValue([
          {
            id: 'grok-build',
            displayName: 'Grok Build',
            capabilities: {
              canCreateSession: true,
              canSetSessionMode: true,
              canAcceptAttachments: false,
            },
            sessionModes: ['default', 'plan', 'ask'],
          },
        ]),
        getAdapterSessionCreationDefaults: vi.fn().mockResolvedValue(sessionCreationDefaults()),
        listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
        listCodexModelProviders: vi.fn().mockResolvedValue([]),
        chooseDirectory,
        createAdapterSession,
      },
    });
    render(<NewSessionDialog open={true} onClose={vi.fn()} onCreated={vi.fn()} />);

    const workMode = await screen.findByLabelText('工作模式');
    expect(workMode.textContent).toContain('可执行');
    expect(workMode.textContent).not.toContain('默认');
    fireEvent.click(workMode);
    fireEvent.click(screen.getByRole('option', { name: '计划模式' }));
    fireEvent.click(screen.getByLabelText('Grok 沙盒请求档位'));
    fireEvent.click(screen.getByRole('option', { name: '自定义 profile…' }));
    fireEvent.change(screen.getByLabelText('Grok 自定义沙盒 profile'), {
      target: { value: 'project-locked' },
    });
    fireEvent.change(screen.getByPlaceholderText(/输入任务或问题/), {
      target: { value: '先制定计划' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(createAdapterSession).toHaveBeenCalledWith(
        'grok-build',
        expect.objectContaining({
          sessionMode: 'plan',
          grokSandbox: 'project-locked',
        }),
      );
    });
  });

  it('把 Codex 会话级审批策略透传给创建 IPC', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listAdapters: vi.fn().mockResolvedValue([
          {
            id: 'codex-cli',
            displayName: 'Codex',
            capabilities: {
              canCreateSession: true,
              canSetPermissionMode: false,
              canAcceptAttachments: true,
            },
          },
        ]),
        getAdapterSessionCreationDefaults: vi.fn().mockResolvedValue(
          sessionCreationDefaults('untrusted'),
        ),
        listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
        listCodexModelProviders: vi.fn().mockResolvedValue([]),
        chooseDirectory,
        createAdapterSession,
      },
    });
    render(<NewSessionDialog open={true} onClose={vi.fn()} onCreated={vi.fn()} />);

    const approvalPicker = await screen.findByLabelText('审批策略');
    await waitFor(() => {
      expect(approvalPicker.textContent).toContain('非可信命令前询问');
    });
    fireEvent.click(approvalPicker);
    fireEvent.click(screen.getByRole('option', { name: '从不询问' }));
    fireEvent.change(screen.getByPlaceholderText(/输入任务或问题/), {
      target: { value: '检查审批策略' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(createAdapterSession).toHaveBeenCalledWith(
        'codex-cli',
        expect.objectContaining({ approvalPolicy: 'never' }),
      );
    });
  });
});
