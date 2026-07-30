// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type {
  AgentEvent,
  PendingOutgoingMessage,
} from '@shared/types';
import { PendingOutgoingQueue } from '../composer-sdk/PendingOutgoingQueue';

let messages: PendingOutgoingMessage[];
let loadPendingOutgoingAttachment: ReturnType<typeof vi.fn>;
let listPendingOutgoingMessages: ReturnType<typeof vi.fn>;
let deletePendingOutgoingMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  messages = [];
  loadPendingOutgoingAttachment = vi.fn();
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

describe('PendingOutgoingQueue original compact rows', () => {
  it('shows complete text inline with the original compact delete action', async () => {
    messages = [{
      id: 'text-only',
      text: 'first line\nsecond line with complete content',
      attachments: [],
    }];
    render(
      <PendingOutgoingQueue agentId="codex-cli" sessionId="session-A" refreshVersion={0} />,
    );
    expect(await screen.findByText(/second line with complete content/)).toBeTruthy();
    const remove = screen.getByRole('button', { name: '删除等待消息' });
    expect(remove.className).toContain('h-5');
    expect(remove.className).toContain('w-5');
    expect(screen.queryByRole('button', { name: '展开等待消息' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(loadPendingOutgoingAttachment).not.toHaveBeenCalled();
  });

  it('keeps attachment-only rows as their original inline summary', async () => {
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
    const row = await screen.findByRole('listitem');
    expect(row.textContent).toContain('(仅附件)  · 2 个附件');
    expect(screen.queryByRole('button', { name: '展开等待消息' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(loadPendingOutgoingAttachment).not.toHaveBeenCalled();
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
