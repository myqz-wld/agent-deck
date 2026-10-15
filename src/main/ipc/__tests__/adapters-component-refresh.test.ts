import { ipcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcInvoke } from '@shared/ipc-channels';
const mocks = vi.hoisted(() => ({ refresh: vi.fn(), successor: vi.fn(), get: vi.fn(), dispatch: vi.fn() }));
vi.mock('@main/adapters/registry', () => ({ adapterRegistry: { get: () => ({
  id: 'codex-cli', capabilities: {}, refreshSessionComponents: mocks.refresh, sendMessage: vi.fn(),
}) } }));
vi.mock('@main/store/session-repo', () => ({ sessionRepo: { get: mocks.get } }));
vi.mock('@main/store/session-handoff-alias-repo', () => ({ findSessionHandOffSuccessor: mocks.successor }));
vi.mock('../adapters-message-dispatch', () => ({ dispatchAdapterMessageWithHandOffRedirect: mocks.dispatch }));
vi.mock('../adapters-attachments', () => ({ persistAdapterAttachments: async () => [] }));
import { registerAdapterOutgoingIpc } from '../adapters-outgoing';
function handler(channel: string) {
  return vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)![1] as (...args: unknown[]) => Promise<unknown>;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.successor.mockReturnValue(null);
  mocks.get.mockReturnValue({ id: 'source', agentId: 'codex-cli', lifecycle: 'active' });
  mocks.refresh.mockResolvedValue({ phase: 'queued', revision: 1, results: [] });
  registerAdapterOutgoingIpc();
});
describe('typed user component actions', () => {
  it('routes the exact session and rejects stale handoff sources', async () => {
    await handler(IpcInvoke.AdapterRefreshComponents)({}, 'codex-cli', 'source', 'refresh');
    expect(mocks.refresh).toHaveBeenCalledWith('source', 'refresh');
    mocks.successor.mockReturnValue('successor');
    await expect(handler(IpcInvoke.AdapterRefreshComponents)({}, 'codex-cli', 'source', 'cancel')).rejects.toThrow(/目标会话已变化/);
    expect(mocks.refresh).toHaveBeenCalledOnce(); expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it('rejects command text through ordinary IPC and keeps quoted mentions ordinary', async () => {
    await expect(handler(IpcInvoke.AdapterSendMessage)({}, 'codex-cli', 'source', '/deck-refresh')).rejects.toThrow(/用法/);
    await handler(IpcInvoke.AdapterSendMessage)({}, 'codex-cli', 'source', 'Explain `/deck-refresh`');
    expect(mocks.dispatch).toHaveBeenCalledOnce(); expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
