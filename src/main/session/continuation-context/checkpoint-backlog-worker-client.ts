import createCheckpointBacklogWorker from './checkpoint-backlog-worker?nodeWorker';
import {
  DEFAULT_CHECKPOINT_BACKLOG_MAX_ROWS,
  DEFAULT_CHECKPOINT_BACKLOG_MAX_SOURCE_BYTES,
  type CheckpointBacklogEstimate,
} from './checkpoint-backlog-estimator';
import {
  CHECKPOINT_BACKLOG_WORKER_KIND,
  type CheckpointBacklogWorkerCommand,
  type CheckpointBacklogWorkerData,
  type CheckpointBacklogWorkerMessage,
} from './checkpoint-backlog-worker-contract';

const DEFAULT_SATURATION_TOKENS = 48_000;
export const DEFAULT_CHECKPOINT_BACKLOG_WORKER_READY_TIMEOUT_MS = 5_000;
export const DEFAULT_CHECKPOINT_BACKLOG_WORKER_STOP_TIMEOUT_MS = 2_000;

export interface CheckpointBacklogEstimator {
  estimate(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<CheckpointBacklogEstimate | null>;
  stop(): Promise<void>;
}

export interface CheckpointBacklogWorkerLike {
  postMessage(command: CheckpointBacklogWorkerCommand): void;
  terminate(): Promise<number>;
  on(event: 'message', listener: (message: CheckpointBacklogWorkerMessage) => void): this;
  on(event: 'messageerror', listener: (error: Error) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
}

export interface CheckpointBacklogWorkerClientOptions {
  saturationTokens?: number;
  maxSourceBytes?: number;
  maxRows?: number;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  createWorker?: (data: CheckpointBacklogWorkerData) => CheckpointBacklogWorkerLike;
}

interface PendingEstimate {
  requestId: number;
  sessionId: string;
  signal: AbortSignal;
  cancelled: boolean;
  settled: boolean;
  resolve: (result: CheckpointBacklogEstimate | null) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}

type WorkerPhase = 'starting' | 'ready' | 'closing' | 'terminating';

interface ActiveWorker {
  generation: number;
  instance: CheckpointBacklogWorkerLike;
  phase: WorkerPhase;
  closeRequestId: number | null;
  termination: Promise<number> | null;
  failure: Error | null;
  forcedByStop: boolean;
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be positive`);
  return value;
}

function abortError(): Error {
  const error = new Error('Checkpoint backlog estimate cancelled');
  error.name = 'AbortError';
  return error;
}

/** Main-thread RPC controller. All SQLite and normalization work remains inside one worker. */
export class CheckpointBacklogWorkerClient implements CheckpointBacklogEstimator {
  private readonly saturationTokens: number;
  private readonly maxSourceBytes: number;
  private readonly maxRows: number;
  private readonly readyTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly setTimer: NonNullable<CheckpointBacklogWorkerClientOptions['setTimer']>;
  private readonly clearTimer: NonNullable<CheckpointBacklogWorkerClientOptions['clearTimer']>;
  private readonly createWorker: NonNullable<CheckpointBacklogWorkerClientOptions['createWorker']>;
  private readonly queue: PendingEstimate[] = [];
  private worker: ActiveWorker | null = null;
  private active: PendingEstimate | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private workerGeneration = 0;
  private requestId = 0;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;
  private rejectStop: ((error: Error) => void) | null = null;

  constructor(
    private readonly dbPath: string,
    options: CheckpointBacklogWorkerClientOptions = {},
  ) {
    if (!dbPath.trim()) throw new Error('dbPath must not be empty');
    this.saturationTokens = positiveSafeInteger(
      options.saturationTokens ?? DEFAULT_SATURATION_TOKENS,
      'saturationTokens',
    );
    this.maxSourceBytes = positiveSafeInteger(
      options.maxSourceBytes ?? DEFAULT_CHECKPOINT_BACKLOG_MAX_SOURCE_BYTES,
      'maxSourceBytes',
    );
    this.maxRows = positiveSafeInteger(
      options.maxRows ?? DEFAULT_CHECKPOINT_BACKLOG_MAX_ROWS,
      'maxRows',
    );
    this.readyTimeoutMs = positiveSafeInteger(
      options.readyTimeoutMs ?? DEFAULT_CHECKPOINT_BACKLOG_WORKER_READY_TIMEOUT_MS,
      'readyTimeoutMs',
    );
    this.stopTimeoutMs = positiveSafeInteger(
      options.stopTimeoutMs ?? DEFAULT_CHECKPOINT_BACKLOG_WORKER_STOP_TIMEOUT_MS,
      'stopTimeoutMs',
    );
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.createWorker = options.createWorker ?? ((data) => createCheckpointBacklogWorker({
      name: 'agent-deck-checkpoint-backlog',
      workerData: data,
    }));
  }

  estimate(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<CheckpointBacklogEstimate | null> {
    if (this.stopping) return Promise.reject(new Error('Checkpoint backlog worker is stopping'));
    if (this.worker?.phase === 'terminating') {
      return Promise.reject(this.worker.failure ?? new Error('Checkpoint backlog worker is retiring'));
    }
    if (!sessionId.trim()) return Promise.reject(new Error('sessionId must not be empty'));
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const pending: PendingEstimate = {
        requestId: ++this.requestId,
        sessionId,
        signal,
        cancelled: false,
        settled: false,
        resolve,
        reject,
        onAbort: () => this.cancel(pending),
      };
      signal.addEventListener('abort', pending.onAbort, { once: true });
      this.queue.push(pending);
      this.ensureWorker();
      this.dispatch();
    });
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = new Promise<void>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
    this.rejectAll(abortError());
    this.clearReadyTimer();
    if (!this.worker) {
      this.finishStop();
      return this.stopPromise;
    }
    this.startStopTimer(this.worker.generation);
    if (this.worker.phase === 'ready') this.sendClose(this.worker.generation);
    return this.stopPromise;
  }

  private ensureWorker(): void {
    if (this.worker || this.stopping) return;
    const generation = ++this.workerGeneration;
    const data: CheckpointBacklogWorkerData = {
      kind: CHECKPOINT_BACKLOG_WORKER_KIND,
      dbPath: this.dbPath,
    };
    try {
      const instance = this.createWorker(data);
      this.worker = {
        generation,
        instance,
        phase: 'starting',
        closeRequestId: null,
        termination: null,
        failure: null,
        forcedByStop: false,
      };
      instance.on('message', (message) => this.onMessage(generation, message));
      instance.on('messageerror', (error) => this.retireWorker(generation, error));
      instance.on('error', (error) => this.retireWorker(generation, error));
      instance.on('exit', (code) => this.onExit(generation, code));
      this.startReadyTimer(generation);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.rejectAll(error);
    }
  }

  private onMessage(generation: number, message: CheckpointBacklogWorkerMessage): void {
    const worker = this.worker;
    if (!worker || worker.generation !== generation) return;
    if (message.type === 'ready') {
      if (worker.phase !== 'starting') return;
      this.clearReadyTimer();
      worker.phase = 'ready';
      if (this.stopping) this.sendClose(generation);
      else this.dispatch();
      return;
    }
    if (message.type === 'fatal') {
      this.retireWorker(generation, new Error(`Checkpoint backlog worker failed: ${message.error}`));
      return;
    }
    if (message.type === 'closed') {
      if (
        worker.phase !== 'closing' ||
        worker.closeRequestId === null ||
        message.requestId !== worker.closeRequestId
      ) return;
      return;
    }
    const pending = this.active;
    if (!pending || message.requestId !== pending.requestId) return;
    this.active = null;
    if (message.type === 'estimate-result') this.resolvePending(pending, message.result);
    else this.rejectPending(pending, new Error(`Checkpoint backlog estimate failed: ${message.error}`));
    if (!this.stopping && worker.phase === 'ready') this.dispatch();
  }

  private onExit(generation: number, code: number): void {
    const worker = this.worker;
    if (!worker || worker.generation !== generation) return;
    if (worker.phase !== 'terminating' && worker.phase !== 'closing' && worker.failure === null) {
      worker.failure = new Error(`Checkpoint backlog worker exited unexpectedly (code=${code})`);
    } else if (code !== 0 && worker.failure === null && !worker.forcedByStop) {
      worker.failure = new Error(`Checkpoint backlog worker exited with code ${code}`);
    }
    this.finalizeWorker(generation);
  }

  private dispatch(): void {
    if (this.stopping || this.worker?.phase !== 'ready' || this.active) return;
    let pending: PendingEstimate | undefined;
    while ((pending = this.queue.shift())) {
      if (!pending.cancelled && !pending.settled) break;
      pending = undefined;
    }
    if (!pending) return;
    this.active = pending;
    try {
      this.worker.instance.postMessage({
        type: 'estimate',
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        saturationTokens: this.saturationTokens,
        maxSourceBytes: this.maxSourceBytes,
        maxRows: this.maxRows,
      });
    } catch (cause) {
      this.retireWorker(this.worker.generation, cause);
    }
  }

  private cancel(pending: PendingEstimate): void {
    if (pending.cancelled) return;
    pending.cancelled = true;
    this.rejectPending(pending, abortError());
    // A normal caller cancellation never terminates a synchronous read. Drain and discard the
    // active result before another request enters this single worker.
    if (this.active !== pending) this.dispatch();
  }

  private sendClose(generation: number): void {
    const worker = this.worker;
    if (!worker || worker.generation !== generation || worker.phase !== 'ready') return;
    worker.phase = 'closing';
    worker.closeRequestId = ++this.requestId;
    try {
      worker.instance.postMessage({ type: 'close', requestId: worker.closeRequestId });
    } catch (cause) {
      this.retireWorker(generation, cause);
    }
  }

  private retireWorker(generation: number, cause: unknown, forcedByStop = false): void {
    const worker = this.worker;
    if (!worker || worker.generation !== generation) return;
    if (forcedByStop && worker.failure === null) worker.forcedByStop = true;
    if (!forcedByStop && worker.failure === null) {
      worker.failure = cause instanceof Error ? cause : new Error(String(cause));
    }
    this.rejectAll(worker.failure ?? abortError());
    if (worker.phase === 'terminating') return;
    worker.phase = 'terminating';
    this.clearReadyTimer();
    this.clearStopTimer();
    try {
      const termination = worker.instance.terminate();
      worker.termination = termination;
      void termination.then(
        () => this.finalizeWorker(generation),
        (error) => {
          const current = this.worker;
          if (current?.generation === generation && current.failure === null) {
            current.failure = error instanceof Error ? error : new Error(String(error));
          }
          // A rejected terminate call does not prove the thread is gone; wait for its exit event.
        },
      );
    } catch (error) {
      if (worker.failure === null) {
        worker.failure = error instanceof Error ? error : new Error(String(error));
      }
      // Synchronous termination failure also waits for exit or the app's outer shutdown bound.
    }
  }

  private finalizeWorker(generation: number): void {
    const worker = this.worker;
    if (!worker || worker.generation !== generation) return;
    this.clearReadyTimer();
    this.clearStopTimer();
    this.worker = null;
    this.rejectAll(worker.failure ?? abortError());
    this.active = null;
    if (this.stopping) {
      if (worker.failure && !worker.forcedByStop) this.failStop(worker.failure);
      else this.finishStop();
    }
  }

  private startReadyTimer(generation: number): void {
    this.clearReadyTimer();
    this.readyTimer = this.setTimer(() => {
      this.readyTimer = null;
      this.retireWorker(
        generation,
        new Error(`Checkpoint backlog worker was not ready within ${this.readyTimeoutMs}ms`),
      );
    }, this.readyTimeoutMs);
    this.readyTimer.unref?.();
  }

  private startStopTimer(generation: number): void {
    this.clearStopTimer();
    this.stopTimer = this.setTimer(() => {
      this.stopTimer = null;
      this.retireWorker(generation, new Error('Checkpoint backlog worker stop timed out'), true);
    }, this.stopTimeoutMs);
    this.stopTimer.unref?.();
  }

  private clearReadyTimer(): void {
    if (!this.readyTimer) return;
    this.clearTimer(this.readyTimer);
    this.readyTimer = null;
  }

  private clearStopTimer(): void {
    if (!this.stopTimer) return;
    this.clearTimer(this.stopTimer);
    this.stopTimer = null;
  }

  private resolvePending(
    pending: PendingEstimate,
    result: CheckpointBacklogEstimate | null,
  ): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.signal.removeEventListener('abort', pending.onAbort);
    pending.resolve(result);
  }

  private rejectPending(pending: PendingEstimate, error: Error): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.signal.removeEventListener('abort', pending.onAbort);
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    if (this.active) this.rejectPending(this.active, error);
    for (const pending of this.queue) this.rejectPending(pending, error);
    this.queue.length = 0;
  }

  private finishStop(): void {
    const resolve = this.resolveStop;
    this.resolveStop = null;
    this.rejectStop = null;
    resolve?.();
  }

  private failStop(error: Error): void {
    const reject = this.rejectStop;
    this.resolveStop = null;
    this.rejectStop = null;
    reject?.(error);
  }
}
