import type { AgentEvent } from '@shared/types';
import { isTerminalBackgroundTask, readBackgroundTaskSnapshot, type BackgroundTaskSnapshot } from '@shared/background-task';

function snapshot(event: AgentEvent): BackgroundTaskSnapshot | null {
  return event.kind === 'background-task' ? readBackgroundTaskSnapshot(event.payload) : null;
}

function key(event: AgentEvent, task: BackgroundTaskSnapshot): string {
  return JSON.stringify([event.sessionId, event.agentId, task.taskId]);
}

export function backgroundTaskIdentity(event: AgentEvent): string | null {
  const task = snapshot(event);
  return task ? key(event, task) : null;
}

function isNewer(candidate: AgentEvent, previous: AgentEvent): boolean {
  const next = snapshot(candidate)!;
  const before = snapshot(previous)!;
  if (next.runId && before.runId && next.runId !== before.runId) return next.runId > before.runId;
  if (candidate.ts !== previous.ts) return candidate.ts > previous.ts;
  if (next.revision !== before.revision) return next.revision > before.revision;
  return false;
}

/** Display the current state of each native task, keeping raw lifecycle events in history. */
export function presentBackgroundTasks(events: readonly AgentEvent[]): AgentEvent[] {
  const latest = new Map<string, AgentEvent>();
  const boundaries = new Map<string, number>();
  for (const event of events) {
    if (event.kind === 'session-start' || event.kind === 'session-end') {
      boundaries.set(event.sessionId, Math.max(boundaries.get(event.sessionId) ?? 0, event.ts));
    }
    const task = snapshot(event);
    if (!task) continue;
    const identity = key(event, task);
    const previous = latest.get(identity);
    if (!previous || isNewer(event, previous)) latest.set(identity, event);
  }
  return events.flatMap((event) => {
    const task = snapshot(event);
    if (!task) return [event];
    if (latest.get(key(event, task)) !== event || task.hidden) return [];
    return !isTerminalBackgroundTask(task.status) && event.ts <= (boundaries.get(event.sessionId) ?? -1)
      ? [{ ...event, payload: { ...task, status: 'unknown',
          summary: '会话已结束或重新启动，任务状态待确认。' } }]
      : [event];
  });
}
