// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type {
  AgentEvent,
  PendingOutgoingAttachmentLoadResult,
  PendingOutgoingMessage,
} from '@shared/types';
import { PendingOutgoingQueue } from '../composer-sdk/PendingOutgoingQueue';

let messages: PendingOutgoingMessage[];
let loadPendingOutgoingAttachment: ReturnType<typeof vi.fn>;
let listPendingOutgoingMessages: ReturnType<typeof vi.fn>;
let deletePendingOutgoingMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  messages = [];
  loadPendingOutgoingAttachment = vi.fn(
    (): Promise<PendingOutgoingAttachmentLoadResult> => Promise.resolve({
      ok: true,
      dataUrl: 'data:image/png;base64,c2FmZQ==',
      mime: 'image/png',
      bytes: 4,
    }),
  );
  listPendingOutgoingMessages = vi.fn(() => Promise.resolve(messages));
  deletePendingOutgoingMessage = vi.fn(() => Promise.resolve(true));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listPendingOutgoingMessages,
      loadPendingOutgoingAttachment,
      deletePendingOutgoingMessage,
      onAgentEvent: vi.fn((_listener: (event: AgentEvent) => void) => vi.fn()),
    } as unknown as Window['api'],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PendingOutgoingQueue authoritative detail', () => {
  it('shows complete text in ExpandableContent and closes it with Escape', async () => {
    messages = [{
      id: 'text-only',
      text: 'first line\nsecond line with complete content',
      attachments: [],
    }];
    render(
      <PendingOutgoingQueue agentId="codex-cli" sessionId="session-A" refreshVersion={0} />,
    );
    const expand = await screen.findByRole('button', { name: '展开等待消息' });
    const remove = screen.getByRole('button', { name: '删除等待消息' });
    expect(expand.className).toContain('h-11');
    expect(expand.className).toContain('w-11');
    expect(remove.className).toContain('h-11');
    expect(remove.className).toContain('w-11');
    fireEvent.click(expand);

    const dialog = screen.getByRole('dialog', { name: '等待消息详情' });
    expect(within(dialog).getByText(/second line with complete content/)).toBeTruthy();
    expect(within(dialog).getByText('这条等待消息没有附件。')).toBeTruthy();
    expect(loadPendingOutgoingAttachment).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', {
      name: '等待消息详情',
    })).toBeNull());
  });

  it('loads attachment-only multi-image content only after open and supports lightbox Escape', async () => {
    messages = [{
      id: 'attachments-only',
      text: '',
      attachments: [
        { id: '0', mime: 'image/png', bytes: 1024 },
        { id: '1', mime: 'image/jpeg', bytes: 2048 },
      ],
    }];
    render(
      <PendingOutgoingQueue agentId="claude-code" sessionId="session-A" refreshVersion={0} />,
    );
    expect(await screen.findByText(/\(仅附件\)/)).toBeTruthy();
    expect(loadPendingOutgoingAttachment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '展开等待消息' }));
    const detail = screen.getByRole('dialog', { name: '等待消息详情' });
    expect(within(detail).getByText('无文字（仅附件）')).toBeTruthy();
    expect(within(detail).getByText('image/png')).toBeTruthy();
    expect(within(detail).getByText('image/jpeg')).toBeTruthy();
    await waitFor(() => expect(loadPendingOutgoingAttachment).toHaveBeenCalledTimes(2));
    expect(loadPendingOutgoingAttachment).toHaveBeenNthCalledWith(
      1,
      'claude-code',
      'session-A',
      'attachments-only',
      '0',
    );

    const previewButton = await within(detail).findByRole('button', {
      name: '放大查看等待附件 1',
    });
    fireEvent.click(previewButton);
    expect(screen.getByRole('dialog', { name: '图片预览' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', {
      name: '图片预览',
    })).toBeNull());
    expect(screen.getByRole('dialog', { name: '等待消息详情' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', {
      name: '等待消息详情',
    })).toBeNull());
  });

  it('shows a useful state when provider consumption wins before preview loading', async () => {
    messages = [{
      id: 'consumed',
      text: '',
      attachments: [{ id: '0', mime: 'image/webp', bytes: 10 }],
    }];
    loadPendingOutgoingAttachment.mockResolvedValue({
      ok: false,
      reason: 'not_found',
    });
    render(
      <PendingOutgoingQueue agentId="grok-build" sessionId="session-A" refreshVersion={0} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '展开等待消息' }));
    expect(await screen.findByText('附件已被接收或删除，无法继续预览。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '放大查看等待附件 1' })).toBeNull();
  });

  it('drops the heavy detail when the logical session key changes', async () => {
    messages = [{
      id: 'pending-A',
      text: 'session A',
      attachments: [{ id: '0', mime: 'image/png', bytes: 4 }],
    }];
    const view = render(
      <PendingOutgoingQueue agentId="codex-cli" sessionId="session-A" refreshVersion={0} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '展开等待消息' }));
    expect(await screen.findByRole('img', { name: '等待附件 1' })).toBeTruthy();

    messages = [];
    view.rerender(
      <PendingOutgoingQueue agentId="codex-cli" sessionId="session-B" refreshVersion={0} />,
    );
    await waitFor(() => expect(screen.queryByRole('dialog', {
      name: '等待消息详情',
    })).toBeNull());
    expect(screen.queryByRole('img', { name: '等待附件 1' })).toBeNull();
  });

  it('does not let a delayed delete from A mutate or refresh B', async () => {
    const rowsBySession = new Map<string, PendingOutgoingMessage[]>([
      ['session-A', [{ id: 'shared-id', text: 'pending A', attachments: [] }]],
      ['session-B', [{ id: 'shared-id', text: 'pending B', attachments: [] }]],
    ]);
    listPendingOutgoingMessages.mockImplementation(
      (_agentId: string, targetSessionId: string) =>
        Promise.resolve(rowsBySession.get(targetSessionId) ?? []),
    );
    let resolveA!: (removed: boolean) => void;
    let resolveB!: (removed: boolean) => void;
    deletePendingOutgoingMessage.mockImplementation(
      (_agentId: string, targetSessionId: string) =>
        new Promise<boolean>((resolve) => {
          if (targetSessionId === 'session-A') resolveA = resolve;
          else resolveB = resolve;
        }),
    );

    const view = render(
      <PendingOutgoingQueue agentId="codex-cli" sessionId="session-A" refreshVersion={0} />,
    );
    expect(await screen.findByText('pending A')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除等待消息' }));

    view.rerender(
      <PendingOutgoingQueue agentId="codex-cli" sessionId="session-B" refreshVersion={0} />,
    );
    expect(await screen.findByText('pending B')).toBeTruthy();
    const deleteB = screen.getByRole('button', { name: '删除等待消息' });
    fireEvent.click(deleteB);
    expect(deleteB).toHaveProperty('disabled', true);
    const listCallsBeforeACompletes = listPendingOutgoingMessages.mock.calls.length;

    await act(async () => {
      resolveA(false);
      await Promise.resolve();
    });
    expect(listPendingOutgoingMessages).toHaveBeenCalledTimes(listCallsBeforeACompletes);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: '删除等待消息' }))
      .toHaveProperty('disabled', true);

    rowsBySession.set('session-B', []);
    await act(async () => {
      resolveB(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByText('pending B')).toBeNull());
  });
});
