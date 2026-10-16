import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokNativeWork } from './native-work';
import { createGrokRuntime } from './runtime-factory';
import type { GrokAcpSession } from './acp-process';
const instances: GrokNativeWork[] = [];
afterEach(() => { instances.forEach(work => work.dispose()); instances.length = 0; });
function fixture() {
  const runtime = createGrokRuntime('parent', { cwd: '/repo' }, null);
  const snapshot = { subagentId: 'agent', parentSessionId: 'native-parent', childSessionId: 'child', startedAtEpochMs: 1, status: 'running' };
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method.endsWith('/get')) return { result: { snapshot } };
    if (method.endsWith('/cancel')) return { result: { subagentId: 'agent', cancelled: true, outcome: { kind: 'cancelled' } } };
    return { result: {} };
  });
  const process = { connection: { agent: { request } }, isStopping: false } as unknown as GrokAcpSession;
  runtime.process = process; runtime.ready = true; runtime.nativeSessionId = 'native-parent';
  const emit = vi.fn();
  const work = new GrokNativeWork(runtime, process, emit, false); instances.push(work);
  const spawn = (attempt = 'attempt-z') => work.extension({ sessionId: 'native-parent', update: {
    sessionUpdate: 'subagent_spawned', subagent_id: 'agent', parent_session_id: 'native-parent',
    child_session_id: 'child', attempt_id: attempt, description: 'Inspect' } });
  return { runtime, snapshot, request, work, emit, spawn };
}
describe('Grok native work', () => {
  it('isolates child translation and ignores its context tokens and late attempts', async () => {
    const { work, emit, spawn, runtime } = fixture(); spawn();
    work.child({ sessionId: 'child', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '# Child result' } } });
    expect(runtime.translation.currentAssistantText).toBe('');
    expect(emit.mock.calls.some(([event]) => event.kind === 'native-work-detail')).toBe(true);
    expect(emit.mock.calls.every(([event]) => !['token-usage', 'context-usage', 'message'].includes(event.kind))).toBe(true);
    spawn('attempt-a');
    spawn('attempt-z'); // Replayed old spawn must not replace the child translation owner.
    work.extension({ sessionId: 'native-parent', update: { sessionUpdate: 'subagent_finished',
      subagent_id: 'agent', child_session_id: 'child', attempt_id: 'attempt-z', status: 'completed' } });
    expect(work.tracker.list()[0]).toMatchObject({ runId: 'attempt-a', status: 'running' });
    work.extension({ sessionId: 'native-parent', update: { sessionUpdate: 'subagent_finished',
      subagent_id: 'agent', child_session_id: 'child', attempt_id: 'attempt-a', status: 'completed' } });
    expect(work.tracker.list()[0].status).toBe('completed');
  });
  it('retains missing membership in a truncated snapshot and does not infer completion', () => {
    const { work } = fixture();
    work.extension({ sessionId: 'native-parent', update: { sessionUpdate: 'task_backgrounded', task_id: 'shell', tool_call_id: 'call', command: 'sleep 5' } });
    work.extension({ sessionId: 'native-parent', update: { sessionUpdate: 'background_tasks', tasks: [], truncated: true } });
    expect(work.tracker.list()[0].status).toBe('running');
    work.extension({ sessionId: 'native-parent', update: { sessionUpdate: 'background_tasks', tasks: [], truncated: false } });
    expect(work.tracker.list()[0].status).toBe('unknown');
  });
  it('requires matching current ownership and epoch before cancellation', async () => {
    const { work, spawn, snapshot, request, runtime } = fixture(); spawn(); await work.refresh();
    const ref = work.tracker.list()[0].native;
    snapshot.parentSessionId = 'unrelated';
    expect(await work.stop(ref)).toEqual({ status: 'stale' });
    snapshot.parentSessionId = 'native-parent'; snapshot.startedAtEpochMs = 2;
    expect(await work.stop(ref)).toEqual({ status: 'stale' });
    expect(request.mock.calls.some(([method]) => method.endsWith('/cancel'))).toBe(false);
    snapshot.startedAtEpochMs = 1;
    expect(await work.stop(ref)).toEqual({ status: 'accepted' });
    expect(work.tracker.list()[0].status).toBe('running');
    runtime.process = null;
    expect(await work.stop(ref)).toEqual({ status: 'stale' });
  });
  it('distinguishes not-found from already-finished and never substitutes parent cancel', async () => {
    const { work, spawn, request } = fixture(); spawn(); await work.refresh();
    const ref = work.tracker.list()[0].native;
    const base = request.getMockImplementation()!;
    request.mockImplementation(async method => method.endsWith('/cancel')
      ? { result: { subagentId: 'agent', cancelled: false, outcome: { kind: 'not_found' } } } : base(method));
    expect(await work.stop(ref)).toEqual({ status: 'stale' });
    request.mockImplementation(async method => method.endsWith('/cancel')
      ? { result: { subagentId: 'agent', cancelled: false, outcome: { kind: 'already_finished', status: 'completed' } } } : base(method));
    expect(await work.stop(ref)).toEqual({ status: 'already-terminal' });
    expect(work.tracker.list()[0].status).toBe('completed');
    expect(request.mock.calls.some(([method]) => method === 'session/cancel')).toBe(false);
  });
});
