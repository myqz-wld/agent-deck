// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewSessionDialog } from '../NewSessionDialog';

let chooseDirectory: ReturnType<typeof vi.fn>;
let createAdapterSession: ReturnType<typeof vi.fn>;
let resolveChooseDirectory: (value: string | null) => void;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
            canAcceptAttachments: true,
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it('shows and forwards adapter-native Grok Build work modes', async () => {
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
    fireEvent.click(screen.getByLabelText('Grok Build 沙盒请求档位'));
    fireEvent.click(screen.getByRole('option', { name: '自定义配置…' }));
    fireEvent.change(screen.getByPlaceholderText('输入自定义 sandbox.toml 配置名称'), {
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
    expect(screen.queryByText(/只控制是否暂停询问/)).toBeNull();
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

describe('NewSessionDialog unified authoring and create lifecycle', () => {
  it('edits long text with two images in the expanded surface and layers image Escape', async () => {
    class ImmediateFileReader {
      result: string | ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      readAsDataURL(file: Blob): void {
        this.result = `data:${file.type};base64,aGVsbG8=`;
        queueMicrotask(() => this.onload?.());
      }
    }
    class ImmediateImage {
      width = 100;
      height = 100;
      onload: (() => void) | null = null;
      private value = '';
      set src(next: string) {
        this.value = next;
        queueMicrotask(() => this.onload?.());
      }
      get src(): string {
        return this.value;
      }
    }
    vi.stubGlobal('FileReader', ImmediateFileReader as unknown as typeof FileReader);
    vi.stubGlobal('Image', ImmediateImage as unknown as typeof Image);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      globalCompositeOperation: '',
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/jpeg;base64,dGh1bWI=');

    render(<NewSessionDialog open onClose={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByText('Claude');
    const longText = `完整任务\n${'长文本 '.repeat(180)}`;
    fireEvent.change(screen.getByLabelText('第一条消息'), {
      target: { value: longText },
    });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, {
      target: {
        files: [
          new File([new Uint8Array(32)], 'first.png', { type: 'image/png' }),
          new File([new Uint8Array(32)], 'second.png', { type: 'image/png' }),
        ],
      },
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '放大查看附件：first.png' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '放大查看附件：second.png' })).toBeTruthy();
    });

    const expand = screen.getByRole('button', { name: '展开编辑第一条消息' });
    expect(expand.className).toContain('right-1');
    expect(expand.className).toContain('top-1');
    expect(expand.className).toContain('h-6');
    expect(expand.className).toContain('w-6');
    expect(expand.className).not.toContain('h-11');
    expect(expand.className).not.toContain('w-11');
    expect(screen.getByLabelText('第一条消息').className).toContain('resize-none');
    expect(screen.getByLabelText('第一条消息').className).not.toContain('resize-y');
    fireEvent.click(expand);
    const editor = screen.getByRole('dialog', { name: '编辑第一条消息' });
    expect(editor.className).toContain('bg-[#141418]');
    expect(editor.querySelector('header')?.className).toContain('pl-[78px]');
    expect(
      (screen.getByLabelText('第一条消息（展开编辑）') as HTMLTextAreaElement).value,
    ).toBe(longText);
    expect(editor.textContent).toContain('first.png');
    expect(editor.textContent).toContain('second.png');

    fireEvent.click(screen.getByRole('button', {
      name: '放大查看附件：first.png',
    }));
    expect(screen.getByRole('dialog', { name: '图片预览' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '图片预览' })).toBeNull();
    });
    expect(screen.getByRole('dialog', { name: '编辑第一条消息' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '编辑第一条消息' })).toBeNull();
    });
  });

  it('locks create synchronously against double submission', async () => {
    const pending = deferred<string>();
    createAdapterSession.mockReturnValueOnce(pending.promise);
    render(<NewSessionDialog open onClose={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByText('Claude');
    fireEvent.change(screen.getByLabelText('第一条消息'), {
      target: { value: '只创建一次' },
    });
    const create = screen.getByRole('button', { name: '创建' });
    fireEvent.click(create);
    fireEvent.click(create);
    expect(createAdapterSession).toHaveBeenCalledTimes(1);
    pending.resolve('session-new');
  });

  it('freezes the compact image file control while create is in flight', async () => {
    const readAsDataUrl = vi.fn();
    class GuardedFileReader {
      result: string | ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      readAsDataURL(file: Blob): void {
        readAsDataUrl(file);
      }
    }
    vi.stubGlobal('FileReader', GuardedFileReader as unknown as typeof FileReader);
    const pending = deferred<string>();
    createAdapterSession.mockReturnValueOnce(pending.promise);
    render(<NewSessionDialog open onClose={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByText('Claude');
    const firstMessageLabel = screen.getByText('第一条消息（文字或图片至少一项）');
    expect(firstMessageLabel.parentElement?.parentElement?.className).toContain('gap-1.5');
    const addImageButton = screen.getByRole('button', { name: '添加图片' });
    const characterCount = screen.getByText('0 / 102,400');
    expect(addImageButton.parentElement).toBe(characterCount.parentElement);
    expect(addImageButton.parentElement?.parentElement?.className).toContain('space-y-1');
    expect(screen.getByLabelText('第一条消息').className).toContain('block');
    expect(
      firstMessageLabel.parentElement?.parentElement?.contains(
        addImageButton,
      ),
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('第一条消息'), {
      target: { value: '创建期间冻结附件' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    const fileInput = screen.getByLabelText('添加图片文件') as HTMLInputElement;
    expect(fileInput.disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: '添加图片' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(fileInput, {
      target: {
        files: [new File([new Uint8Array(16)], 'too-late.png', { type: 'image/png' })],
      },
    });
    await Promise.resolve();
    expect(readAsDataUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', {
      name: '放大查看附件：too-late.png',
    })).toBeNull();
    pending.resolve('session-new');
  });

  it('disables user close while creating and fences completion after an external close', async () => {
    const pending = deferred<string>();
    createAdapterSession.mockReturnValueOnce(pending.promise);
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const view = render(
      <NewSessionDialog open onClose={onClose} onCreated={onCreated} />,
    );
    await screen.findByText('Claude');
    fireEvent.change(screen.getByLabelText('第一条消息'), {
      target: { value: '旧草稿' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    const close = screen.getByRole('button', { name: '关闭新建会话' }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();

    view.rerender(<NewSessionDialog open={false} onClose={onClose} onCreated={onCreated} />);
    view.rerender(<NewSessionDialog open onClose={onClose} onCreated={onCreated} />);
    const prompt = await screen.findByLabelText('第一条消息') as HTMLTextAreaElement;
    expect(prompt.value).toBe('旧草稿');
    fireEvent.change(prompt, { target: { value: '重新打开后的草稿' } });

    pending.resolve('stale-session');
    await Promise.resolve();
    await Promise.resolve();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText('第一条消息') as HTMLTextAreaElement).value)
      .toBe('重新打开后的草稿');
  });
});
