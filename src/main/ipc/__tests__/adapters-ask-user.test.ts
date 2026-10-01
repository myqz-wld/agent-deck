import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';

const mocks = vi.hoisted(() => ({
  respond: vi.fn(), list: vi.fn(), listAll: vi.fn(), native: vi.fn(),
  adapter: {} as Record<string, unknown>,
}));
vi.mock('@main/adapters/registry', () => ({ adapterRegistry: { get: () => mocks.adapter } }));
vi.mock('@main/session/manager', () => ({ sessionManager: {} }));
vi.mock('@main/store/session-repo', () => ({ sessionRepo: {} }));
vi.mock('@main/event-bus', () => ({ eventBus: {} }));
vi.mock('@main/plan-review/service', () => ({ planReviewService: { listPending: () => [], listAllPending: () => ({}) } }));
vi.mock('@main/diff-review/service', () => ({ diffReviewService: { listPending: () => [], listAllPending: () => ({}) } }));
vi.mock('@main/ask-user/service', () => ({ getAskUserService: () => ({ respond: mocks.respond, listPending: mocks.list, listAllPending: mocks.listAll }) }));
vi.mock('../adapters-session-model-options', () => ({ registerSessionModelOptionsIpc: vi.fn() }));
vi.mock('../adapters-session-creation-defaults', () => ({ registerAdapterSessionCreationDefaultsIpc: vi.fn() }));
vi.mock('../adapters-outgoing', () => ({ registerAdapterOutgoingIpc: vi.fn() }));
vi.mock('../adapters-runtime-controls', () => ({ registerAdapterSandboxRestartIpc: vi.fn() }));
import { registerAdaptersIpc } from '../adapters';

function handler(channel: string) {
  return vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)![1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.respond.mockReturnValue(true);
  mocks.list.mockReturnValue([{ requestId: 'mcp-ask-1' }]);
  mocks.listAll.mockReturnValue({ 'session-a': [{ requestId: 'mcp-ask-1' }] });
  mocks.adapter = {};
  registerAdaptersIpc();
});

describe('MCP question IPC', () => {
  it.each(['claude-code', 'codex-cli', 'grok-build'])('routes %s answers without native question support', async (agentId) => {
    const answer = { answers: [{ question: 'Question?', selected: [], other: 'Answer' }] };
    await expect(handler(IpcInvoke.AdapterRespondAskUserQuestion)({} as Electron.IpcMainInvokeEvent, agentId, 'session-a', 'mcp-ask-1', answer)).resolves.toBe(true);
    expect(mocks.respond).toHaveBeenCalledWith('session-a', 'mcp-ask-1', answer);
  });

  it('hydrates per-session and all-session Pending even when the adapter has no pending API', () => {
    const event = {} as Electron.IpcMainInvokeEvent;
    expect(handler(IpcInvoke.AdapterListPending)(event, 'codex-cli', 'session-a')).toMatchObject({ askQuestions: [{ requestId: 'mcp-ask-1' }] });
    expect(handler(IpcInvoke.AdapterListPendingAll)(event, 'codex-cli')).toMatchObject({ 'session-a': { askQuestions: [{ requestId: 'mcp-ask-1' }] } });
    expect(mocks.listAll).toHaveBeenCalledWith('codex-cli');
  });

  it('preserves native fallback but rejects a stale MCP answer instead of silently accepting it', async () => {
    mocks.respond.mockReturnValue(false);
    mocks.adapter = { respondAskUserQuestion: mocks.native };
    const event = {} as Electron.IpcMainInvokeEvent;
    const respond = handler(IpcInvoke.AdapterRespondAskUserQuestion);
    await expect(respond(event, 'claude-code', 'session-a', 'mcp-ask-stale', {})).rejects.toThrow();
    expect(mocks.native).not.toHaveBeenCalled();
    await expect(respond(event, 'claude-code', 'session-a', 'native-1', {})).resolves.toBe(true);
    expect(mocks.native).toHaveBeenCalledWith('session-a', 'native-1', {});
  });
});
