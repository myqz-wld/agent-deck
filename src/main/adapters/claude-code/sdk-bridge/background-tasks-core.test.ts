import { describe, expect, it, vi } from 'vitest';
import { translateClaudeBackgroundTasksCore } from './background-tasks-core';
import { makeInternalSession } from './types';
import type { BackgroundTaskSnapshot } from '@shared/background-task';

function fixture() {
  const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
  internal.userTurnInFlight = false;
  const emit = vi.fn<(snapshot: BackgroundTaskSnapshot) => void>();
  const send = (subtype: string, fields: Record<string, unknown> = {}) =>
    translateClaudeBackgroundTasksCore({ type: 'system', subtype,
      task_id: 'build-task', run_id: 'run-2', ...fields }, internal, emit);
  const snapshots = () => emit.mock.calls.map(([state]) => state);
  return { internal, emit, send, snapshots };
}

describe('Claude native background tasks', () => {
  it('retains lifecycle, progress and output without owning the foreground turn', () => {
    const f = fixture();
    f.send('task_started', { task_type: 'local_bash', is_backgrounded: true,
      tool_use_id: 'bash-call', description: 'Run build checks', prompt: 'not a display field' });
    const progress = { description: 'Run build checks', last_tool_name: 'Bash',
      usage: { total_tokens: 120, tool_uses: 2, duration_ms: 5_000 } };
    f.send('task_progress', progress);
    f.send('task_progress', progress);
    expect(f.snapshots()).toHaveLength(2);
    f.send('task_updated', { patch: { status: 'completed' } });
    f.send('task_notification', { status: 'completed', summary: 'All checks passed',
      output_file: '/workspace/build.log' });
    f.send('background_tasks_changed', { tasks: [] });
    expect(f.snapshots()).toHaveLength(4);
    expect(f.snapshots().at(-1)).toMatchObject({
      taskId: 'build-task', runId: 'run-2', toolUseId: 'bash-call', taskType: 'local_bash',
      status: 'completed', description: 'Run build checks', summary: 'All checks passed',
      outputFile: '/workspace/build.log', totalTokens: 120, toolUses: 2, durationMs: 5_000,
      lastToolName: 'Bash', revision: 4,
    });
    expect(f.snapshots()[0]).toMatchObject({ status: 'running', revision: 1 });
    expect(f.snapshots()[0]).not.toHaveProperty('prompt');
    expect(f.internal.userTurnInFlight).toBe(false);
  });

  it('uses full membership snapshots to recover missing starts and clear stale running state', () => {
    const f = fixture();
    const task = { task_id: 'build-task', run_id: 'run-2', task_type: 'local_bash', description: 'Checks' };
    f.send('background_tasks_changed', { tasks: [task] });
    f.send('task_started', { ...task, is_backgrounded: true });
    expect(f.snapshots()).toHaveLength(1);
    f.send('background_tasks_changed', { tasks: [] });
    expect(f.snapshots().at(-1)?.status).toBe('unknown');
    f.send('background_tasks_changed', { tasks: [] });
    expect(f.snapshots()).toHaveLength(2);
    f.send('task_notification', { status: 'failed', summary: 'Checks failed' });
    expect(f.snapshots().at(-1)?.status).toBe('failed');
  });

  it('hides foreground and ambient tasks and reveals an explicit background transition', () => {
    const f = fixture();
    f.send('task_started', { is_backgrounded: false, description: 'Foreground agent' });
    f.send('task_progress', { usage: { tool_uses: 2 } });
    expect(f.emit).not.toHaveBeenCalled();
    f.send('task_updated', { patch: { is_backgrounded: true } });
    expect(f.snapshots().at(-1)).toMatchObject({ description: 'Foreground agent', hidden: false });
    f.send('background_tasks_changed', { tasks: [{ task_id: 'build-task', run_id: 'run-2', ambient: true }] });
    expect(f.snapshots().at(-1)?.hidden).toBe(true);
    const count = f.snapshots().length;
    f.send('task_progress', { usage: { tool_uses: 3 } });
    f.send('task_notification', { status: 'completed', skip_transcript: true });
    expect(f.snapshots()).toHaveLength(count);
  });

  it('suppresses housekeeping from the first event and ignores malformed frames', () => {
    const f = fixture();
    f.send('task_started', { ambient: true, is_backgrounded: true });
    f.send('task_progress', { description: 'Watcher tick' });
    f.send('task_notification', { status: 'completed', ambient: true });
    f.send('task_started', { task_id: 'x'.repeat(257) });
    f.send('task_notification', { task_id: 'other-task', status: 'invented' });
    f.send('background_tasks_changed', { tasks: null });
    expect(f.emit).not.toHaveBeenCalled();
  });

  it('never revives a terminal run or applies an older run to a resumed task', () => {
    const f = fixture();
    f.send('task_started', { description: 'Current run', is_backgrounded: true });
    f.send('task_notification', { run_id: 'run-1', status: 'failed', summary: 'Old run' });
    expect(f.snapshots()).toHaveLength(1);
    f.send('task_notification', { status: 'stopped' });
    f.send('task_progress', { description: 'Late progress' });
    f.send('background_tasks_changed', { tasks: [{ task_id: 'build-task', run_id: 'run-2' }] });
    expect(f.snapshots()).toHaveLength(2);
    f.send('task_started', { run_id: 'run-3', description: 'Resumed run', is_backgrounded: true });
    expect(f.snapshots().at(-1)).toMatchObject({ runId: 'run-3', status: 'running', revision: 1 });
    f.send('task_notification', { run_id: 'run-2', status: 'completed' });
    expect(f.snapshots()).toHaveLength(3);
  });

  it('retains pause, cancellation, error detail and independent task identities', () => {
    const f = fixture();
    f.send('task_started', { is_backgrounded: true });
    f.send('task_started', { task_id: 'other-task', is_backgrounded: true });
    f.send('task_updated', { patch: { status: 'paused' } });
    f.send('task_updated', { patch: { status: 'killed', error: 'Stopped by user' } });
    expect(f.snapshots().at(-1)).toMatchObject({ taskId: 'build-task', status: 'stopped', error: 'Stopped by user' });
    expect(f.internal.backgroundTasks?.get('other-task')?.snapshot.status).toBe('running');
  });

  it('bounds completed task retention while preserving active task identities', () => {
    const f = fixture();
    f.send('task_started', { is_backgrounded: true });
    for (let i = 0; i < 300; i++) {
      f.send('task_notification', { task_id: `finished-${i}`, status: 'completed' });
    }
    expect(f.internal.backgroundTasks?.size).toBe(256);
    expect(f.internal.backgroundTasks?.has('build-task')).toBe(true);
  });
});
