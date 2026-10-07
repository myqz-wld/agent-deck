// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { setLastAdapter, setLastDefaults } from '@renderer/hooks/useLastSessionDefaults';
import { NewSessionDialog } from '../NewSessionDialog';

vi.mock('@renderer/hooks/image-attachments/processing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/hooks/image-attachments/processing')>()),
  processImageFile: async (file: File) => ({
    thumbnailDataUrl: 'data:image/png;base64,YWJj', base64: 'YWJj', bytes: 3,
    mime: 'image/png', name: file.name,
  }),
}));
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'api'); });

it('retains the Gateway, text and image and re-enables retry after an upload timeout', async () => {
  setLastAdapter('codex-cli');
  setLastDefaults('codex-cli', { provider: '', model: '', thinking: '' });
  let reject!: (error: Error) => void;
  const pending = new Promise<string>((_resolve, fail) => { reject = fail; });
  const create = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce('retried');
  const onCreated = vi.fn();
  const onClose = vi.fn();
  Object.defineProperty(window, 'api', { configurable: true, value: {
    listAdapters: vi.fn().mockResolvedValue([{
      id: 'codex-cli', displayName: 'Codex', capabilities: { canCreateSession: true, canAcceptAttachments: true },
    }]),
    getAdapterSessionCreationDefaults: vi.fn(async (_id, options) => ({
      provider: options?.provider ?? '', model: 'synthetic-model', thinking: 'high',
      permissionMode: 'bypassPermissions', sessionMode: 'default', approvalPolicy: 'never',
      codexSandbox: 'workspace-write', claudeCodeSandbox: 'workspace-write', grokSandbox: 'workspace',
      projectTrust: { status: 'trusted', canGrant: false, reasonCode: null, revision: `sha256:${'a'.repeat(64)}` },
    })),
    listCodexGatewayProfiles: vi.fn().mockResolvedValue([{ id: 'gateway-test' }]),
    createAdapterSession: create,
  } });
  render(<NewSessionDialog open onClose={onClose} onCreated={onCreated} />);
  fireEvent.click(await screen.findByText('模型配置'));
  fireEvent.click(await screen.findByLabelText('模型网关'));
  fireEvent.click(screen.getByRole('option', { name: 'gateway-test' }));
  fireEvent.change(screen.getByLabelText('第一条消息'), { target: { value: 'inspect the image' } });
  fireEvent.change(screen.getByLabelText('添加图片文件'), {
    target: { files: [new File(['abc'], 'synthetic.png', { type: 'image/png' })] },
  });
  await screen.findByRole('button', { name: '放大查看附件：synthetic.png' });
  await waitFor(() => expect((screen.getByRole('button', { name: '创建' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '创建' }));
  expect(create).toHaveBeenCalledOnce();
  const message = '图片保存超时，请重试。消息尚未发送，文字和图片已保留。';
  await act(async () => reject(new Error(message)));
  expect(await screen.findByText(message)).toBeTruthy();
  expect((screen.getByLabelText('第一条消息') as HTMLTextAreaElement).value).toBe('inspect the image');
  expect(screen.getByRole('button', { name: '放大查看附件：synthetic.png' })).toBeTruthy();
  expect(onCreated).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: '创建' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '创建' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith('retried'));
  const first = create.mock.calls[0][1];
  const second = create.mock.calls[1][1];
  expect(second).toMatchObject({ provider: 'gateway-test', prompt: first.prompt, attachments: first.attachments });
  expect(second.attachments).toHaveLength(1);
});
