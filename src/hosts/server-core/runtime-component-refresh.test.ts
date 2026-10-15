import { describe, expect, it, vi } from 'vitest';
import { runtimeCoreHarness, runtimeCoreInput } from './runtime-core.test-fixture';

describe('owning-host component action route', () => {
  it('rejects a handed-off source without following its successor', async () => {
    const refreshSessionComponents = vi.fn();
    const { runtime } = runtimeCoreHarness({ adapter: { refreshSessionComponents } as never,
      handOffSuccessor: () => 'successor' });
    await runtime.start();
    await expect(runtime.execute(runtimeCoreInput('session.components.refresh', { sessionId: 'session-a', action: 'refresh' })))
      .rejects.toThrow(/unavailable/);
    expect(refreshSessionComponents).not.toHaveBeenCalled();
  });
  it('dispatches a typed action exactly once with no message or model turn', async () => {
    const refreshSessionComponents = vi.fn(async () => ({ phase: 'queued', revision: 1, results: [] }));
    const { runtime, sendMessage } = runtimeCoreHarness({ adapter: { refreshSessionComponents } as never });
    await runtime.start();
    const input = runtimeCoreInput('session.components.refresh', { sessionId: 'session-a', action: 'refresh' }, { idempotencyKey: 'refresh-a' });
    const first = await runtime.execute(input);
    expect(await runtime.execute(input)).toEqual(first);
    expect(refreshSessionComponents).toHaveBeenCalledOnce();
    expect(refreshSessionComponents).toHaveBeenCalledWith('session-a', 'refresh');
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it('rejects command text through the ordinary message route and does not redirect stale targets', async () => {
    const refreshSessionComponents = vi.fn();
    const { runtime, sendMessage } = runtimeCoreHarness({ adapter: { refreshSessionComponents } as never });
    await runtime.start();
    await expect(runtime.execute(runtimeCoreInput('session.send', { sessionId: 'session-a', text: '/deck-refresh' })))
      .rejects.toThrow(/deck-refresh/);
    await expect(runtime.execute(runtimeCoreInput('session.components.refresh', { sessionId: 'missing', action: 'refresh' })))
      .rejects.toThrow();
    expect(refreshSessionComponents).not.toHaveBeenCalled(); expect(sendMessage).not.toHaveBeenCalled();
  });
});
