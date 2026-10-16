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
  it('retains translated child tool identity and native outcome for conversation rows', () => {
    const { work, spawn, emit } = fixture(); spawn();
    work.child({ sessionId: 'child', update: { sessionUpdate: 'tool_call', toolCallId: 'call',
      title: 'Bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'pwd' } } });
    work.child({ sessionId: 'child', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call',
      status: 'completed', rawOutput: 'result' } });
    const records = emit.mock.calls.map(([event]) => event).filter(event => event.kind === 'native-work-detail').map(event => event.payload);
    expect(records).toHaveLength(2);
    expect(records[0].toolUseId).toMatch(/^[a-f0-9]{64}$/);
    expect(records[1]).toMatchObject({ toolUseId: records[0].toolUseId, toolStatus: 'completed' });
  });
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
  it('keeps an explicit command association only within the same native task attempt', () => {
    const { work } = fixture();
    const update = { sessionUpdate: 'task_backgrounded', task_id: 'shell', tool_call_id: 'call',
      command: 'sleep 5', started_at: '2026-01-01T00:00:00Z' };
    work.extension({ sessionId: 'native-parent', update });
    const first = work.tracker.list()[0];
    expect(first.toolUseId).toBe('call');
    expect(first.toolUseKey).toMatch(/^[a-f0-9]{64}$/);
    work.extension({ sessionId: 'native-parent', update: { ...update, tool_call_id: undefined } });
    expect(work.tracker.list()[0].toolUseId).toBe('call');
    work.extension({ sessionId: 'native-parent', update: { ...update, tool_call_id: undefined, started_at: '2026-01-01T00:01:00Z' } });
    expect(work.tracker.list()[0].runId).not.toBe(first.runId);
    expect(work.tracker.list()[0].toolUseId).toBeUndefined();
    expect(work.tracker.list()[0].toolUseKey).toBeUndefined();
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
