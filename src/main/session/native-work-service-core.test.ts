import { describe, expect, it, vi } from 'vitest';
import { createNativeWorkService } from './native-work-service-core';
import type { NativeWorkSnapshot } from '@shared/native-work';
import type { SessionRecord } from '@shared/types';
import type { AgentAdapter } from '@main/adapters/types';
const task: NativeWorkSnapshot = { native: { sessionId: 's', provider: 'codex-cli', nativeId: 'child', runId: 'run', runtimeId: 'runtime' },
  taskId: 'child', runId: 'run', workKind: 'subagent', status: 'running', description: 'Child', startedAt: 1, updatedAt: 1,
  revision: 1, canStop: true, detailStatus: 'available' };
function fixture() {
  const stop = vi.fn(async () => ({ status: 'accepted' as const }));
  const list = vi.fn(async () => [task]);
  const service = createNativeWorkService({ session: id => id === 's' ? { id, agentId: 'codex-cli', lifecycle: 'active' } as SessionRecord : null,
    adapter: () => ({ listNativeWork: list, stopNativeWork: stop }) as unknown as AgentAdapter,
    repository: { list: () => ({ tasks: [task], revision: 1, nextCursor: null }), details: () => ({ records: [], revision: 1, nextCursor: null }) }, stopTimeoutMs: 5 });
  return { service, stop, list };
}
describe('native work service ownership', () => {
  it('marks disconnected history unknown and never grants a stored stop handle', async () => {
    const { service, list, stop } = fixture(); list.mockResolvedValue([]);
    expect((await service.list({ sessionId: 's' })).tasks[0]).toMatchObject({ status: 'unknown', canStop: false });
    expect(await service.stop(task.native)).toEqual({ status: 'stale' });
    expect(stop).not.toHaveBeenCalled();
  });
  it('rejects cross-session, provider, attempt and runtime references', async () => {
    const { service, stop } = fixture();
    for (const patch of [{ provider: 'grok-build' as const }, { runId: 'old' }, { runtimeId: 'old' }, { nativeId: 'other' }]) {
      expect(await service.stop({ ...task.native, ...patch })).toEqual({ status: 'stale' });
    }
    await expect(service.stop({ ...task.native, sessionId: 'missing' })).rejects.toThrow();
    expect(stop).not.toHaveBeenCalled();
  });
  it('coalesces duplicate gestures and returns a bounded timeout without asserting success', async () => {
    const { service, stop } = fixture(); stop.mockImplementation(() => new Promise(() => {}));
    expect(await Promise.all([service.stop(task.native), service.stop(task.native)]))
      .toEqual([{ status: 'timed-out' }, { status: 'timed-out' }]);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
