import { describe, expect, it, vi } from 'vitest';
import { ClaudeNativeWork } from './native-work-core';
import { makeInternalSession } from './types';
import { translateClaudeBackgroundTasksCore } from './background-tasks-core';

describe('Claude owned native work', () => {
  it('retains child roles and pairs native tool input with its result', () => {
    const { work, send, emit } = fixture(); send();
    work.child({ type: 'assistant', uuid: 'assistant', parent_tool_use_id: 'spawn', message: {
      content: [{ type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'pwd' } }] } });
    work.child({ type: 'user', uuid: 'user', parent_tool_use_id: 'spawn', message: {
      content: [{ type: 'text', text: 'Check the result' }, { type: 'tool_result', tool_use_id: 'call', content: 'failed', is_error: true }] } });
    const records = emit.mock.calls.map(([event]) => event).filter(event => event.kind === 'native-work-detail').map(event => event.payload);
    expect(records[1]).toMatchObject({ role: 'user' });
    expect(records[0].toolUseId).toBe(records[2].toolUseId);
    expect(records[2].toolStatus).toBe('failed');
  });
  it('does not attach an old invocation\'s late child message to a resumed run', () => {
    const { work, send, emit } = fixture(); send();
    send({ run_id: 'run-2', tool_use_id: 'spawn-2' });
    const count = emit.mock.calls.length;
    work.child({ type: 'assistant', uuid: 'old-message', parent_tool_use_id: 'spawn',
      message: { content: [{ type: 'text', text: 'old output' }] } });
    expect(emit).toHaveBeenCalledTimes(count);
  });
  function fixture() {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'parent' });
    const stopTask = vi.fn(async () => {});
    internal.query = { stopTask } as unknown as typeof internal.query;
    const emit = vi.fn();
    const work = new ClaudeNativeWork(internal, 'parent', emit, () => 10);
    const frame = { type: 'system', subtype: 'task_started', task_id: 'child', run_id: 'run-1',
      tool_use_id: 'spawn', task_type: 'local_agent', is_backgrounded: false, description: 'Inspect' };
    const send = (patch = {}) => translateClaudeBackgroundTasksCore({ ...frame, ...patch }, internal,
      snapshot => work.snapshot(snapshot, { ...frame, ...patch }));
    return { internal, stopTask, work, emit, send };
  }
  it('shows foreground agents and buffers only bounded, explicitly owned child content', () => {
    const { work, send, emit } = fixture();
    work.child({ type: 'assistant', uuid: 'message', parent_tool_use_id: 'spawn', message: {
      content: [{ type: 'tool_use', id: 'same-id', name: 'Bash', input: { command: 'pwd' } }] } });
    expect(emit).not.toHaveBeenCalled();
    send();
    expect(work.tracker.list()).toMatchObject([{ workKind: 'subagent', status: 'running' }]);
    expect(emit.mock.calls.filter(([event]) => event.kind === 'native-work-detail')).toHaveLength(1);
    expect(emit.mock.calls.every(([event]) => ['background-task', 'native-work-detail'].includes(event.kind))).toBe(true);
  });
  it('binds stop to the exact run and runtime and waits for native terminal notification', async () => {
    const { work, send, stopTask } = fixture(); send();
    const ref = work.tracker.list()[0].native;
    expect(await work.stop({ ...ref, sessionId: 'other' })).toEqual({ status: 'stale' });
    expect(await work.stop({ ...ref, runtimeId: 'old' })).toEqual({ status: 'stale' });
    expect(stopTask).not.toHaveBeenCalled();
    expect(await work.stop(ref)).toEqual({ status: 'accepted' });
    expect(work.tracker.list()[0].status).toBe('running');
    send({ subtype: 'task_notification', status: 'stopped' });
    expect(await work.stop(ref)).toEqual({ status: 'already-terminal' });
    send({ run_id: 'run-2' });
    expect(await work.stop(ref)).toEqual({ status: 'stale' });
    expect(stopTask).toHaveBeenCalledTimes(1);
    expect(stopTask).toHaveBeenCalledWith('child');
    work.dispose();
    expect(work.tracker.list()[0]).toMatchObject({ status: 'unknown', canStop: false });
  });
});
