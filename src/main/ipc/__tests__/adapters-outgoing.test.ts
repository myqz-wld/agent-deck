import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  deleteUpload: vi.fn(),
  listPending: vi.fn(),
  removePending: vi.fn(),
  createSession: vi.fn(),
  restartWithGrokSandbox: vi.fn(),
  resolveCreationDefaults: vi.fn(),
}));

vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    list: () => [],
    get: () => ({
      id: 'codex-cli',
      capabilities: {
        canAcceptAttachments: true,
        canSetPermissionMode: false,
        canSetSessionMode: false,
        canRestartWithGrokSandbox: true,
      },
      createSession: mocks.createSession,
      sendMessage: vi.fn(),
      listPendingOutgoingMessages: mocks.listPending,
      removePendingOutgoingMessage: mocks.removePending,
      restartWithGrokSandbox: mocks.restartWithGrokSandbox,
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
vi.mock('@main/adapters/session-creation-defaults', () => ({
  resolveSessionCreationDefaults: mocks.resolveCreationDefaults,
}));
vi.mock('../adapters-message-dispatch', () => ({
  dispatchAdapterMessageWithHandOffRedirect: mocks.dispatch,
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn(), error: vi.fn() }) },
}));

import { registerAdaptersIpc } from '../adapters';
import { parseAdapterCreateRuntimeControls } from '../adapters-runtime-controls';

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
    mocks.createSession.mockResolvedValue('codex-created');
    mocks.restartWithGrokSandbox.mockResolvedValue('source');
    mocks.resolveCreationDefaults.mockResolvedValue({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      thinking: 'high',
      permissionMode: 'bypassPermissions',
      sessionMode: 'default',
      approvalPolicy: 'on-request',
      codexSandbox: 'workspace-write',
      claudeCodeSandbox: 'workspace-write',
      grokSandbox: 'workspace',
    });
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

  it('rejects create-session controls that belong to another adapter', async () => {
    await expect(handler(IpcInvoke.AdapterCreateSession)(
      {},
      'codex-cli',
      { cwd: '/repo', permissionMode: 'plan' },
    )).rejects.toThrow('opts.permissionMode');
    await expect(handler(IpcInvoke.AdapterCreateSession)(
      {},
      'claude-code',
      { cwd: '/repo', codexSandbox: 'read-only' },
    )).rejects.toThrow('opts.codexSandbox');
    await expect(handler(IpcInvoke.AdapterCreateSession)(
      {},
      'grok-build',
      { cwd: '/repo', claudeCodeSandbox: 'strict' },
    )).rejects.toThrow('opts.claudeCodeSandbox');
    await expect(handler(IpcInvoke.AdapterCreateSession)(
      {},
      'grok-build',
      { cwd: '/repo', extraAllowWrite: [] },
    )).rejects.toThrow('opts.extraAllowWrite');
    await expect(handler(IpcInvoke.AdapterCreateSession)(
      {},
      'codex-cli',
      { cwd: '/repo', grokSandbox: 'strict' },
    )).rejects.toThrow('opts.grokSandbox');
    await expect(handler(IpcInvoke.AdapterCreateSession)(
      {},
      'claude-code',
      { cwd: '/repo', approvalPolicy: 'never' },
    )).rejects.toThrow('opts.approvalPolicy');
  });

  it('validates and forwards a Codex thread approval policy', async () => {
    await expect(handler(IpcInvoke.AdapterCreateSession)(
      {},
      'codex-cli',
      { cwd: '/repo', approvalPolicy: 'on-request' },
    )).resolves.toBe('codex-created');
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'codex-cli',
        approvalPolicy: 'on-request',
      }),
    );
    expect(() => parseAdapterCreateRuntimeControls('codex-cli', {
      approvalPolicy: 'always',
    })).toThrow('approvalPolicy');
  });

  it('defaults approvalPolicy to never when a non-UI caller supplies no override', async () => {
    await expect(handler(IpcInvoke.AdapterCreateSession)(
      {},
      'codex-cli',
      { cwd: '/repo' },
    )).resolves.toBe('codex-created');
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ approvalPolicy: 'never' }),
    );
  });

  it('validates and resolves concrete new-session defaults at the IPC boundary', async () => {
    await expect(handler(IpcInvoke.AdapterSessionCreationDefaults)(
      {},
      'codex-cli',
      { cwd: ' /repo ', provider: ' openai ' },
    )).resolves.toMatchObject({
      model: 'gpt-5.6-sol',
      thinking: 'high',
    });
    expect(mocks.resolveCreationDefaults).toHaveBeenCalledWith('codex-cli', {
      cwd: '/repo',
      provider: 'openai',
    });

    await expect(handler(IpcInvoke.AdapterSessionCreationDefaults)(
      {},
      'unknown-adapter',
      {},
    )).rejects.toThrow('adapterId');
    await expect(handler(IpcInvoke.AdapterSessionCreationDefaults)(
      {},
      'codex-cli',
      [],
    )).rejects.toThrow('options');
  });

  it('normalizes built-in and custom Grok profiles at the IPC trust boundary', () => {
    expect(parseAdapterCreateRuntimeControls('grok-build', {
      grokSandbox: ' project-locked ',
    })).toMatchObject({ grokSandbox: 'project-locked' });
    expect(() => parseAdapterCreateRuntimeControls('grok-build', {
      grokSandbox: 'strict\nworkspace',
    })).toThrow('grokSandbox');
  });

  it('normalizes live Grok restart profiles and preserves null native delegation', async () => {
    await expect(handler(IpcInvoke.AdapterRestartWithGrokSandbox)(
      {},
      'grok-build',
      'source',
      ' project-locked ',
    )).resolves.toBe('source');
    expect(mocks.restartWithGrokSandbox).toHaveBeenLastCalledWith(
      'source',
      'project-locked',
    );

    await expect(handler(IpcInvoke.AdapterRestartWithGrokSandbox)(
      {},
      'grok-build',
      'source',
      null,
    )).resolves.toBe('source');
    expect(mocks.restartWithGrokSandbox).toHaveBeenLastCalledWith('source', null);
  });
});
