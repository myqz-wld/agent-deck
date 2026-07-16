import type {
  CheckpointRefreshBacklogSnapshot,
  CheckpointRefreshTrigger,
} from './checkpoint-refresh-scheduler';

export const MAX_CHECKPOINT_REFRESH_FAILURE_RETRY_MS = 6 * 60 * 60 * 1_000;

export interface CheckpointRefreshErrorContext<
  Snapshot extends CheckpointRefreshBacklogSnapshot = CheckpointRefreshBacklogSnapshot,
> {
  sessionId: string;
  stage: 'snapshot' | 'refresh';
  trigger: CheckpointRefreshTrigger | null;
  snapshot: Readonly<Snapshot> | null;
  consecutiveFailures: number;
  retryDelayMs: number;
  retryAt: number;
}

function checkpointRevisionFromError(error: unknown): number | null {
  const raw =
    error && typeof error === 'object'
      ? (error as { checkpointThroughRevision?: unknown }).checkpointThroughRevision
      : null;
  return typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : null;
}

export function nextCheckpointRefreshFailureBackoff(input: {
  baseRetryMs: number;
  consecutiveFailures: number;
  lastFailureCheckpointRevision: number | null;
  snapshotCheckpointRevision: number;
  error: unknown;
}): {
  consecutiveFailures: number;
  checkpointRevision: number;
  retryDelayMs: number;
} {
  const checkpointRevision = Math.max(
    input.snapshotCheckpointRevision,
    checkpointRevisionFromError(input.error) ?? 0,
  );
  const madeProgress =
    input.lastFailureCheckpointRevision !== null &&
    checkpointRevision > input.lastFailureCheckpointRevision;
  const consecutiveFailures = madeProgress ? 1 : input.consecutiveFailures + 1;
  const exponent = Math.min(16, consecutiveFailures - 1);
  const retryDelayMs = Math.min(
    Math.max(input.baseRetryMs, MAX_CHECKPOINT_REFRESH_FAILURE_RETRY_MS),
    input.baseRetryMs * (2 ** exponent),
  );
  return { consecutiveFailures, checkpointRevision, retryDelayMs };
}
