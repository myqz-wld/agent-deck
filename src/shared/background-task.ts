export type BackgroundTaskStatus =
  | 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'unknown';

/** Provider task state, separate from the foreground turn and the application's team tasks. */
export interface BackgroundTaskSnapshot {
  taskId: string;
  runId?: string;
  status: BackgroundTaskStatus;
  description: string;
  taskType?: string;
  toolUseId?: string;
  summary?: string;
  error?: string;
  outputFile?: string;
  lastToolName?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  hidden?: boolean;
  revision: number;
}

export function isTerminalBackgroundTask(status: BackgroundTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

/** History and Remote event payloads are unknown JSON; never pass unchecked fields to React. */
export function readBackgroundTaskSnapshot(value: unknown): BackgroundTaskSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.taskId !== 'string' || !row.taskId || row.taskId.length > 256) return null;
  const snapshot: BackgroundTaskSnapshot = {
    taskId: row.taskId, description: '', revision: 0,
    status: typeof row.status === 'string' &&
      ['pending', 'running', 'paused', 'completed', 'failed', 'stopped', 'unknown'].includes(row.status)
      ? row.status as BackgroundTaskStatus : 'unknown',
  };
  for (const key of ['runId', 'description', 'taskType', 'toolUseId', 'summary', 'error',
    'outputFile', 'lastToolName'] as const) {
    const field = row[key];
    if (typeof field === 'string') snapshot[key] = field;
  }
  for (const key of ['totalTokens', 'toolUses', 'durationMs', 'revision'] as const) {
    const field = row[key];
    if (typeof field === 'number' && Number.isFinite(field) && field >= 0) snapshot[key] = field;
  }
  if (row.hidden === true) snapshot.hidden = true;
  return snapshot;
}
