import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  deleteUpload: vi.fn(),
  listPending: vi.fn(),
  removePending: vi.fn(),
}));

vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    list: () => [],
    get: () => ({
      id: 'codex-cli',
      capabilities: { canAcceptAttachments: true },
      sendMessage: vi.fn(),
      listPendingOutgoingMessages: mocks.listPending,
      removePendingOutgoingMessage: mocks.removePending,
    }),
  },
}));
vi.mock('@main/session/manager', () => ({ sessionManager: {} }));
vi.mock('@main/store/session-repo', () => ({ sessionRepo: {} }));
vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: {},
  TeamInvariantError: class TeamInvariantError extends Error {},
}));
vi.mock('@main/event-bus', () => ({ eventBus: {} }));
vi.mock('@main/plan-review/service', () => ({ planReviewService: {} }));
vi.mock('@main/diff-review/service', () => ({ diffReviewService: {} }));
vi.mock('@main/store/image-uploads', () => ({ deleteUploadIfExists: mocks.deleteUpload }));
vi.mock('../adapters-attachments', () => ({
  persistAdapterAttachments: vi.fn(async () => []),
}));
vi.mock('../adapters-session-model-options', () => ({
  registerSessionModelOptionsIpc: vi.fn(),
}));
vi.mock('../adapters-message-dispatch', () => ({
  dispatchAdapterMessageWithHandOffRedirect: mocks.dispatch,
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn(), error: vi.fn() }) },
}));

import { registerAdaptersIpc } from '../adapters';

function handler(channel: string): (...args: unknown[]) => unknown {
  const registered = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)?.[1];
  expect(registered).toBeTypeOf('function');
  return registered as unknown as (...args: unknown[]) => unknown;
}

describe('adapter outgoing queue IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dispatch.mockResolvedValue('successor');
    mocks.listPending.mockReturnValue([]);
    mocks.removePending.mockReturnValue(null);
    mocks.deleteUpload.mockResolvedValue(undefined);
    registerAdaptersIpc();
  });

  it('correlates an ordinary send with provider consumption and returns the actual owner', async () => {
    const result = await handler(IpcInvoke.AdapterSendMessage)(
      {},
      'codex-cli',
      'source',
      { text: 'queued input' },
    ) as { messageId: string; sessionId: string };

    expect(result.sessionId).toBe('successor');
    expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'source',
      text: 'queued input',
      attachments: [],
      sendOptions: {
        deferUserEventUntilTurnStart: true,
        turnCorrelationId: result.messageId,
      },
    }));
  });

  it('returns a safe pending snapshot and deletes queued uploads only after removal wins', async () => {
    const attachment = {
      kind: 'uploaded' as const,
      path: '/tmp/pending.png',
      mime: 'image/png',
      bytes: 5,
    };
    mocks.listPending.mockReturnValue([{
      id: 'pending-1',
      text: 'waiting',
      attachments: [attachment],
    }]);
    mocks.removePending.mockReturnValueOnce({
      id: 'pending-1',
      text: 'waiting',
      attachments: [attachment],
    }).mockReturnValueOnce(null);

    expect(handler(IpcInvoke.AdapterListPendingOutgoing)(
      {}, 'codex-cli', 'source',
    )).toEqual([{ id: 'pending-1', text: 'waiting', attachmentCount: 1 }]);
    await expect(handler(IpcInvoke.AdapterDeletePendingOutgoing)(
      {}, 'codex-cli', 'source', 'pending-1',
    )).resolves.toBe(true);
    expect(mocks.deleteUpload).toHaveBeenCalledWith('/tmp/pending.png');

    await expect(handler(IpcInvoke.AdapterDeletePendingOutgoing)(
      {}, 'codex-cli', 'source', 'pending-1',
    )).resolves.toBe(false);
    expect(mocks.deleteUpload).toHaveBeenCalledTimes(1);
  });

  it('keeps queue deletion successful when best-effort upload cleanup fails', async () => {
    const attachment = {
      kind: 'uploaded' as const,
      path: '/tmp/already-removed.png',
      mime: 'image/png',
      bytes: 5,
    };
    mocks.removePending.mockReturnValue({
      id: 'pending-cleanup-failure',
      text: 'remove me',
      attachments: [attachment],
    });
    mocks.deleteUpload.mockRejectedValue(new Error('filesystem unavailable'));

    await expect(handler(IpcInvoke.AdapterDeletePendingOutgoing)(
      {}, 'codex-cli', 'source', 'pending-cleanup-failure',
    )).resolves.toBe(true);
  });
});
