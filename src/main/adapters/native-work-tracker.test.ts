import { describe, expect, it, vi } from 'vitest';
import { NativeWorkTracker } from './native-work-tracker';
describe('native work observation ordering', () => {
  it('keeps tool associations opaque and publishes status-only detail changes', () => {
    const emit = vi.fn(); const tracker = new NativeWorkTracker('parent', 'codex-cli', emit, () => 10);
    tracker.observe({ taskId: 'child', workKind: 'subagent' });
    tracker.detail('child', 'start', 'tool-use-start', 'pwd', { toolUseId: 'native-call', toolStatus: 'inProgress' });
    tracker.detail('child', 'result', 'output', 'result', { toolUseId: 'native-call', toolStatus: 'inProgress' });
    tracker.detail('child', 'result', 'output', 'result', { toolUseId: 'native-call', toolStatus: 'completed', exitCode: 0 });
    const records = emit.mock.calls.map(([event]) => event).filter(event => event.kind === 'native-work-detail').map(event => event.payload);
    expect(records).toHaveLength(3);
    expect(records[0].toolUseId).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(records.map(record => record.toolUseId)).size).toBe(1);
    expect(records[2]).toMatchObject({ toolStatus: 'completed', exitCode: 0 });
    expect(records[2].recordRevision).toBeGreaterThan(records[1].recordRevision);
  });
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
    tracker.observe({ ...input, runId: 'z', description: 'Inspect project' }, true);
    tracker.observe({ ...input, runId: 'a' }, true);
    tracker.observe({ ...input, runId: 'z' }, true);
    expect(tracker.list()[0].runId).toBe('a');
    expect(tracker.list()[0].description).toBe('Inspect project');
  });
});
