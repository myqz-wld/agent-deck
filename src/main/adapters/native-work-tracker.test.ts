import { describe, expect, it, vi } from 'vitest';
import { NativeWorkTracker } from './native-work-tracker';
describe('native work observation ordering', () => {
  it('does not rewrite unchanged polls but refreshes detail revisions', () => {
    const emit = vi.fn(); let now = 10;
    const tracker = new NativeWorkTracker('parent', 'codex-cli', emit, () => now++);
    const input = { taskId: 'child', workKind: 'subagent' as const, runId: 'run-z', status: 'running' as const };
    tracker.observe(input); tracker.observe(input);
    expect(emit).toHaveBeenCalledTimes(1);
    tracker.detail('child', 'message', 'message', 'first');
    const revision = tracker.list()[0].revision;
    tracker.detail('child', 'message', 'message', 'first second');
    expect(tracker.list()[0].revision).toBeGreaterThan(revision);
    const count = emit.mock.calls.length;
    tracker.detail('child', 'message', 'message', 'first second');
    expect(emit).toHaveBeenCalledTimes(count);
  });
  it('rejects replay of an old attempt without ordering arbitrary provider IDs', () => {
    const tracker = new NativeWorkTracker('parent', 'grok-build', vi.fn(), () => 10);
    const input = { taskId: 'child', workKind: 'subagent' as const };
    tracker.observe({ ...input, runId: 'z' }, true);
    tracker.observe({ ...input, runId: 'a' }, true);
    tracker.observe({ ...input, runId: 'z' }, true);
    expect(tracker.list()[0].runId).toBe('a');
  });
});
