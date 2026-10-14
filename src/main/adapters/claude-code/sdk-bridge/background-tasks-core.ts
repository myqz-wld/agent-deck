import {
  isTerminalBackgroundTask,
  type BackgroundTaskSnapshot,
  type BackgroundTaskStatus,
} from '@shared/background-task';
import type { InternalSession } from './types';

export interface ClaudeBackgroundTaskState {
  snapshot: BackgroundTaskSnapshot;
  background: boolean;
  hidden: boolean;
}

const SUBTYPES = new Set([
  'task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed',
]);
const MAX_RETAINED_TASKS = 256;
type Frame = { type: string; [key: string]: unknown };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown, max = 8_000): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function identity(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
}

function status(value: unknown): BackgroundTaskStatus | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'killed') return 'stopped';
  return ['pending', 'running', 'paused', 'completed', 'failed', 'stopped'].includes(value)
    ? value as BackgroundTaskStatus : undefined;
}

/** Translate SDK task snapshots without treating them as main-turn starts or completions. */
export function translateClaudeBackgroundTasksCore(
  frame: Frame,
  internal: InternalSession,
  emit: (snapshot: BackgroundTaskSnapshot) => void,
): boolean {
  const subtype = frame.subtype;
  if (frame.type !== 'system' || typeof subtype !== 'string' || !SUBTYPES.has(subtype)) return false;
  if (internal.expectedClose) return true;
  const tasks = internal.backgroundTasks ??= new Map();

  const publish = (state: ClaudeBackgroundTaskState, previous?: ClaudeBackgroundTaskState): void => {
    const hidden = state.hidden || !state.background;
    if (hidden && (!previous || previous.hidden || !previous.background)) return;
    state.snapshot = { ...state.snapshot, hidden };
    if (previous && !previous.hidden && previous.background &&
      JSON.stringify(state.snapshot) === JSON.stringify(previous.snapshot)) return;
    state.snapshot = { ...state.snapshot, revision: (previous?.snapshot.revision ?? 0) + 1 };
    emit({ ...state.snapshot });
  };

  const update = (input: Record<string, unknown>, subtype: string): void => {
    const taskId = identity(input.task_id);
    if (!taskId) return;
    const runId = identity(input.run_id);
    const existing = tasks.get(taskId);
    if (existing?.snapshot.runId && runId && runId < existing.snapshot.runId) return;
    const previous = existing && (!runId || !existing.snapshot.runId || runId === existing.snapshot.runId)
      ? existing : undefined;
    const patch = subtype === 'task_updated' ? record(input.patch) : input;
    const nextStatus = status(patch.status);
    if (subtype === 'task_notification' && (!nextStatus || !isTerminalBackgroundTask(nextStatus))) return;
    // Level snapshots and late progress cannot revive a run after its terminal bookend.
    if (previous && isTerminalBackgroundTask(previous.snapshot.status) &&
      (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'level' ||
        (nextStatus && !isTerminalBackgroundTask(nextStatus)))) return;
    const snapshot: BackgroundTaskSnapshot = previous ? { ...previous.snapshot } : {
      taskId, ...(runId ? { runId } : {}), status: 'running', description: '', revision: 0,
    };
    if (runId) snapshot.runId = runId;
    if (nextStatus) snapshot.status = nextStatus;
    if (subtype === 'level' && snapshot.status === 'unknown') snapshot.status = 'running';
    const strings = {
      description: text(patch.description), taskType: text(input.task_type, 128),
      toolUseId: text(input.tool_use_id, 256), summary: text(input.summary),
      error: text(patch.error), outputFile: text(input.output_file, 4_096),
      lastToolName: text(input.last_tool_name, 256),
    };
    for (const key of Object.keys(strings) as Array<keyof typeof strings>) {
      if (strings[key] !== undefined) snapshot[key] = strings[key];
    }
    const usage = record(input.usage);
    const metrics = { totalTokens: number(usage.total_tokens), toolUses: number(usage.tool_uses),
      durationMs: number(usage.duration_ms) };
    for (const key of Object.keys(metrics) as Array<keyof typeof metrics>) {
      if (metrics[key] !== undefined) snapshot[key] = Math.max(snapshot[key] ?? 0, metrics[key]);
    }
    const state: ClaudeBackgroundTaskState = {
      snapshot,
      background: subtype === 'level' || (typeof patch.is_backgrounded === 'boolean'
        ? patch.is_backgrounded : previous?.background ?? true),
      hidden: typeof input.ambient === 'boolean' || typeof input.skip_transcript === 'boolean'
        ? input.ambient === true || input.skip_transcript === true : previous?.hidden ?? false,
    };
    tasks.set(taskId, state);
    publish(state, previous);
  };

  if (frame.subtype === 'background_tasks_changed') {
    if (!Array.isArray(frame.tasks)) return true;
    const live = new Set<string>();
    for (const item of frame.tasks) {
      const row = record(item);
      const id = identity(row.task_id);
      if (id) live.add(id);
      update(row, 'level');
    }
    for (const [id, previous] of tasks) {
      if (live.has(id) || !previous.background || isTerminalBackgroundTask(previous.snapshot.status)) continue;
      // Removal proves that the task is no longer live in the background, not that it succeeded.
      const state = { ...previous, snapshot: { ...previous.snapshot, status: 'unknown' as const } };
      tasks.set(id, state);
      publish(state, previous);
    }
  } else update(frame, subtype);

  // Bound retained history; active task identities must remain available for later updates.
  for (const [id, state] of tasks) {
    if (tasks.size <= MAX_RETAINED_TASKS) break;
    if (isTerminalBackgroundTask(state.snapshot.status) || state.snapshot.status === 'unknown') tasks.delete(id);
  }
  return true;
}
