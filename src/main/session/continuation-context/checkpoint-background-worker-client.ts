import createCheckpointBackgroundWorker from './checkpoint-background-worker?nodeWorker';
import {
  BACKGROUND_MATERIALIZE_MAX_ROWS,
  BACKGROUND_MATERIALIZE_MAX_SOURCE_BYTES,
  BACKGROUND_MATERIALIZE_MAX_WIRE_BYTES,
  type BackgroundMaterializedMetadata,
} from './checkpoint-background-materializer';
import {
  CHECKPOINT_BACKGROUND_WORKER_KIND,
  type CheckpointBackgroundChunkPayload,
  type CheckpointBackgroundReadyPayload,
  type CheckpointBackgroundWorkerCommand,
  type CheckpointBackgroundWorkerData,
  type CheckpointBackgroundWorkerMessage,
} from './checkpoint-background-worker-contract';
import type {
  AsyncFoldChunkSource,
  BuildFoldChunkViewInput,
  FoldChunkView,
} from './checkpoint-fold-chunk';
import { utf8ByteLength } from './token-estimator';

export interface CheckpointBackgroundWorkerLike {
  postMessage(command: CheckpointBackgroundWorkerCommand): void;
  on(event: 'message', listener: (message: CheckpointBackgroundWorkerMessage) => void): this;
  on(event: 'messageerror', listener: (error: Error) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

export interface OpenCheckpointBackgroundSourceInput {
  dbPath: string;
  sessionId: string;
  deadlineAt: number;
  signal?: AbortSignal;
  maxSourceBytes?: number;
  maxRows?: number;
  maxWireBytes?: number;
  createWorker?: (data: CheckpointBackgroundWorkerData) => CheckpointBackgroundWorkerLike;
}

export interface CheckpointBackgroundChunkSource extends AsyncFoldChunkSource {
  readonly metadata: BackgroundMaterializedMetadata;
  close(): Promise<void>;
}

interface PendingChunk {
  requestId: number;
  resolve: (chunk: FoldChunkView | null) => void;
  reject: (error: Error) => void;
}

function abortError(): Error {
  const error = new Error('Background checkpoint worker aborted');
  error.name = 'AbortError';
  return error;
}

function parseBoundedJson<T>(json: string, maxWireBytes: number, label: string): T {
  if (utf8ByteLength(json) > maxWireBytes) throw new Error(`${label} exceeds worker wire guard`);
  return JSON.parse(json) as T;
}

function safeNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateMetadata(
  payload: CheckpointBackgroundReadyPayload,
  sessionId: string,
): BackgroundMaterializedMetadata {
  const value = payload?.metadata;
  if (!value || value.sessionId !== sessionId) throw new Error('Worker metadata session mismatch');
  for (const [field, candidate] of Object.entries({
    captureRevision: value.captureRevision,
    rebuildAfterRevision: value.rebuildAfterRevision,
    checkpointThroughRevision: value.checkpointThroughRevision,
    materializedThroughRevision: value.materializedThroughRevision,
    sourceRows: value.sourceRows,
    sourceBytes: value.sourceBytes,
    groupCount: value.groupCount,
    normalizedEventCount: value.normalizedEventCount,
  })) {
    if (!safeNonNegative(candidate)) throw new Error(`Worker metadata ${field} is invalid`);
  }
  if (
    value.checkpointThroughRevision > value.materializedThroughRevision ||
    value.materializedThroughRevision > value.captureRevision
  ) throw new Error('Worker metadata revision range is invalid');
  if (typeof value.runtimeFingerprint !== 'string' || !value.runtimeFingerprint) {
    throw new Error('Worker runtime fingerprint is invalid');
  }
  return value;
}

function validateChunk(payload: CheckpointBackgroundChunkPayload): FoldChunkView | null {
  const chunk = payload?.chunk;
  if (chunk === null) return null;
  if (!chunk || !safeNonNegative(chunk.cursor) || !safeNonNegative(chunk.nextCursor)) {
    throw new Error('Worker chunk cursor is invalid');
  }
  if (
    chunk.nextCursor <= chunk.cursor ||
    chunk.consumedGroupCount !== chunk.nextCursor - chunk.cursor ||
    !safeNonNegative(chunk.firstRevision) ||
    !safeNonNegative(chunk.throughRevision) ||
    chunk.throughRevision < chunk.firstRevision ||
    typeof chunk.prompt !== 'string' ||
    !Array.isArray(chunk.normalized) ||
    !Array.isArray(chunk.currentEvidence) ||
    typeof chunk.remainingAfter !== 'boolean' ||
    typeof chunk.requiresCoverageMarker !== 'boolean'
  ) throw new Error('Worker chunk payload is invalid');
  return chunk;
}

class WorkerChunkSource implements CheckpointBackgroundChunkSource {
  readonly metadata: BackgroundMaterializedMetadata;
  private requestId = 0;
  private pending: PendingChunk | null = null;
  private closing: Promise<void> | null = null;
  private terminal = false;

  constructor(
    metadata: BackgroundMaterializedMetadata,
    private readonly worker: CheckpointBackgroundWorkerLike,
    private readonly maxWireBytes: number,
    private readonly terminateWorker: (error?: Error) => Promise<void>,
  ) {
    this.metadata = metadata;
  }

  buildNextChunk(input: BuildFoldChunkViewInput): Promise<FoldChunkView | null> {
    if (this.terminal || this.closing) return Promise.reject(new Error('Background worker is closed'));
    if (this.pending) return Promise.reject(new Error('Background worker already has an active chunk request'));
    return new Promise((resolve, reject) => {
      const pending: PendingChunk = {
        requestId: ++this.requestId,
        resolve,
        reject,
      };
      this.pending = pending;
      try {
        this.worker.postMessage({
          type: 'build-next-chunk',
          requestId: pending.requestId,
          cursor: input.cursor,
          coveredThroughRevision: input.coveredThroughRevision,
          previous: input.previous,
          budget: input.budget,
        });
      } catch (cause) {
        this.pending = null;
        reject(cause instanceof Error ? cause : new Error(String(cause)));
        void this.fail(cause).catch(() => undefined);
      }
    });
  }

  accept(message: CheckpointBackgroundWorkerMessage): void {
    const pending = this.pending;
    if (!pending || !('requestId' in message) || message.requestId !== pending.requestId) return;
    if (message.type !== 'chunk-result' && message.type !== 'chunk-error') return;
    this.pending = null;
    if (message.type === 'chunk-error') {
      pending.reject(new Error(`Background checkpoint chunk failed: ${message.error}`));
      return;
    }
    try {
      const payload = parseBoundedJson<CheckpointBackgroundChunkPayload>(
        message.payloadJson,
        this.maxWireBytes,
        'Background checkpoint chunk',
      );
      pending.resolve(validateChunk(payload));
    } catch (cause) {
      pending.reject(cause instanceof Error ? cause : new Error(String(cause)));
      void this.fail(cause).catch(() => undefined);
    }
  }

  stopAccepting(error: Error): void {
    this.terminal = true;
    this.pending?.reject(error);
    this.pending = null;
  }

  fail(cause: unknown): Promise<void> {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.stopAccepting(error);
    return this.terminateWorker(error);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopAccepting(abortError());
    this.closing = this.terminateWorker();
    return this.closing;
  }
}

/** Spawn after the job reaches the global provider slot; resolve only after the WAL capture closes. */
export function openCheckpointBackgroundSource(
  input: OpenCheckpointBackgroundSourceInput,
): Promise<CheckpointBackgroundChunkSource> {
  if (!input.dbPath.trim() || input.dbPath === ':memory:') {
    return Promise.reject(new Error('Background checkpoint worker requires a file-backed database'));
  }
  if (!input.sessionId.trim()) return Promise.reject(new Error('sessionId must not be empty'));
  if (input.signal?.aborted) return Promise.reject(abortError());
  const maxWireBytes = input.maxWireBytes ?? BACKGROUND_MATERIALIZE_MAX_WIRE_BYTES;
  const data: CheckpointBackgroundWorkerData = {
    kind: CHECKPOINT_BACKGROUND_WORKER_KIND,
    dbPath: input.dbPath,
    sessionId: input.sessionId,
    maxSourceBytes: input.maxSourceBytes ?? BACKGROUND_MATERIALIZE_MAX_SOURCE_BYTES,
    maxRows: input.maxRows ?? BACKGROUND_MATERIALIZE_MAX_ROWS,
    maxWireBytes,
  };
  const createWorker = input.createWorker ?? ((workerData) => {
    if (typeof createCheckpointBackgroundWorker !== 'function') {
      throw new Error('Bundled background checkpoint worker is unavailable');
    }
    return createCheckpointBackgroundWorker({
      name: 'agent-deck-checkpoint-background',
      workerData,
    });
  });

  return new Promise((resolve, reject) => {
    let worker!: CheckpointBackgroundWorkerLike;
    let source: WorkerChunkSource | null = null;
    let settled = false;
    let terminal = false;
    let termination: Promise<void> | null = null;
    let workerExited = false;
    let resolveWorkerExit!: () => void;
    const workerExit = new Promise<void>((resolve) => { resolveWorkerExit = resolve; });
    const timeoutMs = Math.max(1, input.deadlineAt - Date.now());
    const timer = setTimeout(() => {
      void terminate(new Error('Background checkpoint worker timed out')).catch(() => undefined);
    }, timeoutMs);
    timer.unref?.();

    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const terminate = (error?: Error): Promise<void> => {
      if (termination) return termination;
      terminal = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      source?.stopAccepting(error ?? new Error('Background checkpoint worker closed'));
      let resolveTermination!: () => void;
      let rejectTermination!: (error: Error) => void;
      termination = new Promise<void>((resolve, reject) => {
        resolveTermination = resolve;
        rejectTermination = reject;
      });
      if (workerExited) {
        if (error) settleReject(error);
        resolveTermination();
        return termination;
      }
      let terminateAttempt: Promise<number>;
      try {
        terminateAttempt = Promise.resolve(worker.terminate());
      } catch (cause) {
        terminateAttempt = Promise.reject(cause);
      }
      void terminateAttempt.then(
        () => {
          if (error) settleReject(error);
          resolveTermination();
        },
        async (cause) => {
          // A rejected terminate call does not prove the thread is gone. Keep this source and the
          // global refresh slot occupied until the exit event provides that boundary.
          if (!workerExited) await workerExit;
          const terminationError = cause instanceof Error ? cause : new Error(String(cause));
          settleReject(terminationError);
          rejectTermination(terminationError);
        },
      );
      return termination;
    };
    const onAbort = (): void => { void terminate(abortError()).catch(() => undefined); };

    try {
      worker = createWorker(data);
    } catch (cause) {
      clearTimeout(timer);
      settleReject(cause instanceof Error ? cause : new Error(String(cause)));
      return;
    }
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    worker.on('message', (message) => {
      if (terminal) return;
      if (message.type === 'ready' && !source) {
        try {
          const payload = parseBoundedJson<CheckpointBackgroundReadyPayload>(
            message.payloadJson,
            maxWireBytes,
            'Background checkpoint metadata',
          );
          const metadata = validateMetadata(payload, input.sessionId);
          const terminateWorker = (error?: Error) => terminate(error);
          source = new WorkerChunkSource(metadata, worker, maxWireBytes, terminateWorker);
          if (!settled) {
            settled = true;
            resolve(source);
          }
        } catch (cause) {
          void terminate(cause instanceof Error ? cause : new Error(String(cause)))
            .catch(() => undefined);
        }
        return;
      }
      if (message.type === 'fatal') {
        const error = new Error(`Background checkpoint worker failed: ${message.error}`);
        void (source ? source.fail(error) : terminate(error)).catch(() => undefined);
        return;
      }
      source?.accept(message);
    });
    worker.on('messageerror', (error) => { void terminate(error).catch(() => undefined); });
    worker.on('error', (error) => { void terminate(error).catch(() => undefined); });
    worker.on('exit', (code) => {
      workerExited = true;
      resolveWorkerExit();
      terminal = true;
      const error = new Error(`Background checkpoint worker exited (code=${code})`);
      source?.stopAccepting(error);
      if (!termination) {
        void terminate(error).catch(() => undefined);
      }
    });
  });
}
