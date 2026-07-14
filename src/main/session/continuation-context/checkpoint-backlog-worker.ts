import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import {
  estimateCheckpointBacklog,
  type EstimateCheckpointBacklogInput,
  type CheckpointBacklogEstimate,
} from './checkpoint-backlog-estimator';
import {
  CHECKPOINT_BACKLOG_WORKER_KIND,
  type CheckpointBacklogWorkerCommand,
  type CheckpointBacklogWorkerData,
  type CheckpointBacklogWorkerMessage,
} from './checkpoint-backlog-worker-contract';

const MAX_WORKER_ERROR_CHARS = 512;

function boundedWorkerError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/\s+/g, ' ').slice(0, MAX_WORKER_ERROR_CHARS) || 'unknown error';
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isWorkerData(value: unknown): value is CheckpointBacklogWorkerData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return data.kind === CHECKPOINT_BACKLOG_WORKER_KIND &&
    typeof data.dbPath === 'string' && data.dbPath.length > 0;
}

function isEstimateCommand(
  command: unknown,
): command is Extract<CheckpointBacklogWorkerCommand, { type: 'estimate' }> {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return false;
  const value = command as Partial<Extract<CheckpointBacklogWorkerCommand, { type: 'estimate' }>>;
  return value.type === 'estimate' &&
    isPositiveSafeInteger(value.requestId) &&
    typeof value.sessionId === 'string' && value.sessionId.length > 0 &&
    isPositiveSafeInteger(value.saturationTokens) &&
    isPositiveSafeInteger(value.maxSourceBytes) &&
    isPositiveSafeInteger(value.maxRows);
}

/** Execute one estimate against a single WAL snapshot owned by the worker connection. */
export function estimateCheckpointBacklogTransactionally(
  db: Database.Database,
  input: Omit<EstimateCheckpointBacklogInput, 'db'>,
): CheckpointBacklogEstimate | null {
  return db.transaction(() => estimateCheckpointBacklog({ db, ...input }))();
}

function runWorker(data: CheckpointBacklogWorkerData): void {
  if (!parentPort) return;
  const port = parentPort;
  const db = new Database(data.dbPath, { fileMustExist: true, readonly: true });
  let closed = false;

  const closeDatabase = (): void => {
    if (closed) return;
    db.close();
    closed = true;
  };

  port.on('close', () => {
    try {
      closeDatabase();
    } catch {
      // Thread teardown remains the final native connection boundary.
    }
  });

  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('query_only = ON');
    db.pragma('trusted_schema = ON');
    port.on('message', (command: unknown) => {
      if (closed) return;
      const candidate = command && typeof command === 'object' && !Array.isArray(command)
        ? command as { type?: unknown; requestId?: unknown }
        : null;
      if (candidate?.type === 'close' && isPositiveSafeInteger(candidate.requestId)) {
        try {
          closeDatabase();
          port.postMessage({
            type: 'closed',
            requestId: candidate.requestId,
          } satisfies CheckpointBacklogWorkerMessage);
        } catch (cause) {
          port.postMessage({
            type: 'fatal',
            error: boundedWorkerError(cause),
          } satisfies CheckpointBacklogWorkerMessage);
        } finally {
          port.close();
        }
        return;
      }
      if (!isEstimateCommand(command)) {
        port.postMessage({
          type: 'estimate-error',
          requestId: isPositiveSafeInteger(candidate?.requestId) ? candidate.requestId : 0,
          error: 'invalid checkpoint backlog estimate command',
        } satisfies CheckpointBacklogWorkerMessage);
        return;
      }
      try {
        const result = estimateCheckpointBacklogTransactionally(db, {
          sessionId: command.sessionId,
          saturationTokens: command.saturationTokens,
          maxSourceBytes: command.maxSourceBytes,
          maxRows: command.maxRows,
        });
        port.postMessage({
          type: 'estimate-result',
          requestId: command.requestId,
          result,
        } satisfies CheckpointBacklogWorkerMessage);
      } catch (cause) {
        port.postMessage({
          type: 'estimate-error',
          requestId: command.requestId,
          error: boundedWorkerError(cause),
        } satisfies CheckpointBacklogWorkerMessage);
      }
    });
    port.postMessage({ type: 'ready' } satisfies CheckpointBacklogWorkerMessage);
  } catch (cause) {
    try {
      closeDatabase();
    } catch {
      // The worker is already terminal; the thread exit remains the final connection boundary.
    }
    port.postMessage({
      type: 'fatal',
      error: boundedWorkerError(cause),
    } satisfies CheckpointBacklogWorkerMessage);
    port.close();
  }
}

// Prevent Vitest's own worker pool from executing this entry as a checkpoint worker.
if (!isMainThread && parentPort && isWorkerData(workerData)) runWorker(workerData);
