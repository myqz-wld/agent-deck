import { describe, expect, it, vi } from 'vitest';
import { issueRemoteOwnerGrantClaim, type AuthenticatedClientAccessContext, type JsonObject, type CoreMethod } from '@contracts/index';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import type { SessionRecord } from '@shared/types';
import { ServerCoreNativeWorkRuntime } from './native-work-runtime';
const access: AuthenticatedClientAccessContext = { kind: 'authenticated-client', topology: 'full', instanceId: 'instance',
  clientId: 'desktop', transport: 'ssh', connectionScope: 'credential', authority: 'owner-equivalent', surface: 'desktop', grant: issueRemoteOwnerGrantClaim('desktop') };
function fixture() {
  const list = vi.fn(async () => ({ tasks: [], nextCursor: null, revision: 1 }));
  const stop = vi.fn(async () => ({ status: 'accepted' as const }));
  const session = { id: 's', agentId: 'codex-cli', cwd: '/workspace/repo' } as SessionRecord;
  const runtime = new ServerCoreNativeWorkRuntime({ supportedMethods: [], currentRevision: () => 1 } as unknown as DaemonCoreRuntime, {
    workspaceRoot: '/workspace', privateRoots: ['/state'], session: id => id === 's' ? session : null,
    canonicalizePath: value => value,
    service: { list, details: async () => ({ records: [], nextCursor: null, revision: 1 }), stop },
  });
  const execute = (method: CoreMethod, params: JsonObject, patch = {}) => runtime.execute({ method, params, access,
    requestId: 'request', idempotencyKey: null, expectedRevision: null, deadlineAt: null,
    signal: new AbortController().signal, ...patch } as DaemonRequestInput);
  return { runtime, session, list, stop, execute };
}
describe('Core native work transport', () => {
  it('requires the existing read/write grants and a session inside the workspace', async () => {
    const { execute, list, session } = fixture();
    expect(await execute('session.native-work.list', { sessionId: 's' })).toMatchObject({ result: { tasks: [] } });
    session.cwd = '/outside/repo';
    await expect(execute('session.native-work.list', { sessionId: 's' })).rejects.toThrow('outside');
    expect(list).toHaveBeenCalledTimes(1);
    await expect(execute('session.native-work.list', { sessionId: 's' }, { access: { ...access, surface: 'feishu', grant: issueRemoteOwnerGrantClaim('feishu') } })).rejects.toThrow();
  });
  it('rejects malformed paths/commands in place of typed references and aborted requests', async () => {
    const { execute, stop } = fixture();
    await expect(execute('session.native-work.stop', { sessionId: 's', pid: 123 })).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(execute('session.native-work.list', { sessionId: 's' }, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(stop).not.toHaveBeenCalled();
  });
});
