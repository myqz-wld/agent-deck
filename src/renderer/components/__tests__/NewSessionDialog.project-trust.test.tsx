// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ProjectTrustDescriptor,
  SessionCreationConfiguration,
} from '@shared/types';
import { NewSessionDialog } from '../NewSessionDialog';

let createAdapterSession: ReturnType<typeof vi.fn>;

function configuration(
  projectTrust: Partial<ProjectTrustDescriptor> = {},
): SessionCreationConfiguration {
  return {
    provider: '', model: '', thinking: 'high', permissionMode: 'bypassPermissions',
    sessionMode: 'default', approvalPolicy: 'on-request', codexSandbox: 'workspace-write',
    claudeCodeSandbox: 'workspace-write', grokSandbox: 'workspace',
    projectTrust: {
      status: 'untrusted', canGrant: true, reasonCode: null,
      revision: `sha256:${'b'.repeat(64)}`,
      ...projectTrust,
    },
  };
}

beforeEach(() => {
  createAdapterSession = vi.fn().mockResolvedValue('session-new');
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listAdapters: vi.fn().mockResolvedValue([{
        id: 'claude-code', displayName: 'Claude',
        capabilities: {
          canCreateSession: true, canSetPermissionMode: true, canAcceptAttachments: true,
        },
      }]),
      getAdapterSessionCreationDefaults: vi.fn().mockResolvedValue(configuration()),
      listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
      listCodexGatewayProfiles: vi.fn().mockResolvedValue([]),
      chooseDirectory: vi.fn(),
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

describe('NewSessionDialog project trust', () => {
  it.each([
    ['claude-code', 'Claude', '让 Claude 记住你信任这个项目'],
    ['codex-cli', 'Codex', '新增或修改过的 hooks 仍需单独授权'],
    ['grok-build', 'Grok Build', '加载项目中的 MCP、LSP、hooks 和其他代码'],
  ])('shows unchecked provider-specific consent for %s', async (
    adapterId, displayName, expectedHelp,
  ) => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        listAdapters: vi.fn().mockResolvedValue([{
          id: adapterId,
          displayName,
          capabilities: {
            canCreateSession: true,
            canSetPermissionMode: adapterId === 'claude-code',
            canSetSessionMode: adapterId === 'grok-build',
            canAcceptAttachments: adapterId !== 'grok-build',
          },
          ...(adapterId === 'grok-build' ? { sessionModes: ['default', 'plan', 'ask'] } : {}),
        }]),
      },
    });
    render(<NewSessionDialog open onClose={vi.fn()} onCreated={vi.fn()} />);

    const trust = await screen.findByRole('checkbox', { name: '信任此项目' });
    expect((trust as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(expectedHelp, { exact: false })).toBeTruthy();
    const sandboxLabel = screen.getAllByText('沙盒')[0]!;
    expect(sandboxLabel.compareDocumentPosition(trust) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('submits the current trust revision only after explicit consent', async () => {
    render(<NewSessionDialog open onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: '信任此项目' }));
    fireEvent.change(screen.getByLabelText('第一条消息'), {
      target: { value: '读取项目配置' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(createAdapterSession).toHaveBeenCalledWith(
      'claude-code',
      expect.objectContaining({
        projectTrust: { revision: `sha256:${'b'.repeat(64)}`, grant: true },
      }),
    ));
  });

  it('clears consent immediately while retaining the prior adapter projection', async () => {
    window.api.listAdapters = vi.fn().mockResolvedValue([
      {
        id: 'claude-code', displayName: 'Claude',
        capabilities: { canCreateSession: true, canSetPermissionMode: true },
      },
      {
        id: 'codex-cli', displayName: 'Codex',
        capabilities: { canCreateSession: true, canSetPermissionMode: false },
      },
    ]);
    window.api.getAdapterSessionCreationDefaults = vi.fn()
      .mockResolvedValueOnce(configuration())
      .mockReturnValueOnce(new Promise(() => undefined));
    render(<NewSessionDialog open onClose={vi.fn()} onCreated={vi.fn()} />);
    const trust = await screen.findByRole('checkbox', { name: '信任此项目' });
    fireEvent.click(trust);
    expect((trust as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '助手' }));
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }));
    const retained = screen.getByRole('checkbox', { name: '信任此项目' }) as HTMLInputElement;
    expect(retained.checked).toBe(false);
    expect(retained.disabled).toBe(true);
  });

  it('shows a diagnostic without a checkbox and still allows native creation', async () => {
    window.api.getAdapterSessionCreationDefaults = vi.fn().mockResolvedValue(configuration({
      status: 'unknown', canGrant: false, reasonCode: 'state-unreadable',
      revision: `sha256:${'c'.repeat(64)}`,
    }));
    render(<NewSessionDialog open onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(await screen.findByText(
      '无法确认此项目是否已受信任。Agent Deck 不会替你授权，将使用助手自身的安全设置创建会话。',
    )).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: '信任此项目' })).toBeNull();
    fireEvent.change(screen.getByLabelText('第一条消息'), {
      target: { value: '继续创建' },
    });
    const create = screen.getByRole('button', { name: '创建' }) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(createAdapterSession).toHaveBeenCalledWith(
      'claude-code',
      expect.objectContaining({
        projectTrust: { revision: `sha256:${'c'.repeat(64)}`, grant: false },
      }),
    ));
  });

  it('preserves trust consent, prompt, and images after grant/create failure', async () => {
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
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('FileReader', ImmediateFileReader as unknown as typeof FileReader);
    vi.stubGlobal('Image', ImmediateImage as unknown as typeof Image);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn(), globalCompositeOperation: '',
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/jpeg;base64,dGh1bWI=');
    createAdapterSession.mockRejectedValueOnce(new Error('无法保存并验证项目 trust'));
    render(<NewSessionDialog open onClose={vi.fn()} onCreated={vi.fn()} />);
    const trust = await screen.findByRole('checkbox', { name: '信任此项目' });
    fireEvent.click(trust);
    fireEvent.change(screen.getByLabelText('第一条消息'), {
      target: { value: '保留这份草稿' },
    });
    fireEvent.change(screen.getByLabelText('添加图片文件'), {
      target: { files: [new File([new Uint8Array(16)], 'evidence.png', { type: 'image/png' })] },
    });
    await screen.findByRole('button', { name: '放大查看附件：evidence.png' });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    expect(await screen.findByText('无法保存并验证项目 trust')).toBeTruthy();
    expect((screen.getByLabelText('第一条消息') as HTMLTextAreaElement).value)
      .toBe('保留这份草稿');
    expect(screen.getByRole('button', { name: '放大查看附件：evidence.png' })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: '信任此项目' }) as HTMLInputElement).checked)
      .toBe(true);
  });
});
