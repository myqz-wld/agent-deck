import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import {
  BACKGROUND_MATERIALIZE_MAX_ROWS,
  BACKGROUND_MATERIALIZE_MAX_SOURCE_BYTES,
  BACKGROUND_MATERIALIZE_MAX_WIRE_BYTES,
  createWorkerOwnedBackgroundFoldSource,
  materializeBackgroundCheckpointSource,
  type WorkerOwnedBackgroundFoldSource,
} from './checkpoint-background-materializer';
import {
  CHECKPOINT_BACKGROUND_WORKER_KIND,
  type CheckpointBackgroundChunkPayload,
  type CheckpointBackgroundReadyPayload,
  type CheckpointBackgroundWorkerCommand,
  type CheckpointBackgroundWorkerData,
  type CheckpointBackgroundWorkerMessage,
} from './checkpoint-background-worker-contract';
import { utf8ByteLength } from './token-estimator';

const MAX_WORKER_ERROR_CHARS = 512;

function boundedError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/\s+/g, ' ').slice(0, MAX_WORKER_ERROR_CHARS) || 'unknown error';
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validWorkerData(value: unknown): value is CheckpointBackgroundWorkerData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Partial<CheckpointBackgroundWorkerData>;
  return data.kind === CHECKPOINT_BACKGROUND_WORKER_KIND &&
    typeof data.dbPath === 'string' && data.dbPath.length > 0 &&
    typeof data.sessionId === 'string' && data.sessionId.length > 0 &&
    positiveSafeInteger(data.maxSourceBytes) &&
    positiveSafeInteger(data.maxRows) &&
    positiveSafeInteger(data.maxWireBytes);
}

function validBuildCommand(
  value: unknown,
): value is Extract<CheckpointBackgroundWorkerCommand, { type: 'build-next-chunk' }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Partial<
    Extract<CheckpointBackgroundWorkerCommand, { type: 'build-next-chunk' }>
  >;
  return command.type === 'build-next-chunk' &&
    positiveSafeInteger(command.requestId) &&
    nonNegativeSafeInteger(command.cursor) &&
    nonNegativeSafeInteger(command.coveredThroughRevision) &&
    positiveSafeInteger(command.budget) &&
    (command.previous === null ||
      (typeof command.previous === 'object' && !Array.isArray(command.previous)));
}

function encodeBounded(value: unknown, maxWireBytes: number): string {
  const json = JSON.stringify(value);
  if (utf8ByteLength(json) > maxWireBytes) {
    throw new Error(`Background checkpoint worker response exceeds ${maxWireBytes} bytes`);
  }
  return json;
}

function runWorker(data: CheckpointBackgroundWorkerData): void {
  if (!parentPort) return;
  const port = parentPort;
  let source: WorkerOwnedBackgroundFoldSource | null = null;
  try {
    const db = new Database(data.dbPath, { fileMustExist: true, readonly: true });
    try {
      db.pragma('busy_timeout = 5000');
      db.pragma('query_only = ON');
      db.pragma('trusted_schema = ON');
      const materialized = materializeBackgroundCheckpointSource(db, {
        sessionId: data.sessionId,
        maxSourceBytes: data.maxSourceBytes,
        maxRows: data.maxRows,
      });
      source = createWorkerOwnedBackgroundFoldSource(materialized, data.maxWireBytes);
    } finally {
      db.close();
    }
    const readyPayload = {
      metadata: source.metadata,
    } satisfies CheckpointBackgroundReadyPayload;
    port.postMessage({
      type: 'ready',
      payloadJson: encodeBounded(readyPayload, data.maxWireBytes),
    } satisfies CheckpointBackgroundWorkerMessage);
  } catch (cause) {
    port.postMessage({ type: 'fatal', error: boundedError(cause) } satisfies CheckpointBackgroundWorkerMessage);
    port.close();
    return;
  }

  port.on('message', async (command: unknown) => {
    const candidate = command && typeof command === 'object' && !Array.isArray(command)
      ? command as { type?: unknown; requestId?: unknown }
      : null;
    if (candidate?.type === 'close' && positiveSafeInteger(candidate.requestId)) {
      source = null;
      port.postMessage({
        type: 'closed',
        requestId: candidate.requestId,
      } satisfies CheckpointBackgroundWorkerMessage);
      port.close();
      return;
    }
    if (!validBuildCommand(command) || !source) {
      port.postMessage({
        type: 'chunk-error',
        requestId: positiveSafeInteger(candidate?.requestId) ? candidate.requestId : 0,
        error: 'invalid background checkpoint chunk command',
      } satisfies CheckpointBackgroundWorkerMessage);
      return;
    }
    try {
      const view = await source.buildNextChunk({
        cursor: command.cursor,
        coveredThroughRevision: command.coveredThroughRevision,
        previous: command.previous,
        budget: command.budget,
      });
      port.postMessage({
        type: 'chunk-result',
        requestId: command.requestId,
        payloadJson: encodeBounded(
          { chunk: view } satisfies CheckpointBackgroundChunkPayload,
          data.maxWireBytes,
        ),
      } satisfies CheckpointBackgroundWorkerMessage);
    } catch (cause) {
      port.postMessage({
        type: 'chunk-error',
        requestId: command.requestId,
        error: boundedError(cause),
      } satisfies CheckpointBackgroundWorkerMessage);
    }
  });
}

// Prevent Vitest's worker pool from running this module as the materializer entry point.
if (!isMainThread && parentPort && validWorkerData(workerData)) runWorker(workerData);

export const DEFAULT_BACKGROUND_WORKER_LIMITS = Object.freeze({
  maxSourceBytes: BACKGROUND_MATERIALIZE_MAX_SOURCE_BYTES,
  maxRows: BACKGROUND_MATERIALIZE_MAX_ROWS,
  maxWireBytes: BACKGROUND_MATERIALIZE_MAX_WIRE_BYTES,
});
