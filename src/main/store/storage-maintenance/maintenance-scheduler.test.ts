import { EventEmitter } from 'node:events';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StorageMaintenanceScheduler,
  type SchedulerOptions,
  type StorageMaintenanceSchedulerDependencies,
  type StorageMaintenanceWorkerLike,
} from './scheduler';
import type {
  StorageMaintenanceCheckpointResult,
  StorageMaintenanceWorkerCommand,
  StorageMaintenanceWorkerData,
  StorageMaintenanceWorkerMessage,
} from './maintenance-worker-contract';

vi.mock('./maintenance-worker?nodeWorker', () => ({ default: vi.fn() }));

const CHECKPOINT: StorageMaintenanceCheckpointResult = {
  busy: 0,
  log: 12,
  checkpointed: 12,
  durationMs: 1,
};

type MaintenanceTask = 'event-search-v1' | 'file-snapshot-blobs-v1';

class FakeDatabase {
  readonly name = '/tmp/agent-deck-maintenance-scheduler.test.db';
  readonly pragmaCalls: string[] = [];
  autoCheckpointPages: number;
  autoCheckpointReads = 0;
  failAutoCheckpointReadAt: number | null = null;
  phases: Record<MaintenanceTask, string>;

  constructor(
    autoCheckpointPages = 731,
    phases: Partial<Record<MaintenanceTask, string>> = {},
  ) {
    this.autoCheckpointPages = autoCheckpointPages;
    this.phases = {
      'event-search-v1': phases['event-search-v1'] ?? 'backfill',
      'file-snapshot-blobs-v1': phases['file-snapshot-blobs-v1'] ?? 'backfill',
    };
  }

  prepare(sql: string) {
    if (!sql.includes('FROM storage_maintenance_state')) {
      throw new Error(`unexpected SQL in scheduler controller test: ${sql}`);
    }
    return {
      get: (task: MaintenanceTask) => ({
        task,
        phase: this.phases[task],
        cursor: 0,
        upper_bound: 10,
        batch_size: 1,
        last_error: null,
        updated_at: 0,
      }),
    };
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    this.pragmaCalls.push(source);
    const normalized = source.trim();
    if (normalized === 'wal_autocheckpoint' && options?.simple) {
      this.autoCheckpointReads += 1;
      if (this.autoCheckpointReads === this.failAutoCheckpointReadAt) {
        throw new Error('injected wal_autocheckpoint readback failure');
      }
      return this.autoCheckpointPages;
    }
    const assignment = /^wal_autocheckpoint\s*=\s*(\d+)$/i.exec(normalized);
    if (assignment) {
      this.autoCheckpointPages = Number(assignment[1]);
      return [];
    }
    throw new Error(`unexpected PRAGMA in scheduler controller test: ${source}`);
  }
}

class FakeWorker extends EventEmitter {
  readonly commands: StorageMaintenanceWorkerCommand[] = [];
  readonly terminate = vi.fn();

  postMessage(command: StorageMaintenanceWorkerCommand): void {
    this.commands.push({ ...command });
  }

  message(message: StorageMaintenanceWorkerMessage): void {
    this.emit('message', message);
  }
}

interface Harness {
  db: FakeDatabase;
  scheduler: StorageMaintenanceScheduler;
  workers: FakeWorker[];
  workerData: StorageMaintenanceWorkerData[];
  advance(ms: number): void;
}

function createHarness(
  options: SchedulerOptions = {},
  db = new FakeDatabase(),
): Harness {
  let now = 0;
  const workers: FakeWorker[] = [];
  const workerData: StorageMaintenanceWorkerData[] = [];
  const dependencies: StorageMaintenanceSchedulerDependencies = {
    getDatabase: () => db as unknown as Database,
    createWorker: (data) => {
      const worker = new FakeWorker();
      workerData.push(data);
      workers.push(worker);
      return worker as unknown as StorageMaintenanceWorkerLike;
    },
    now: () => now,
  };
  return {
    db,
    workers,
    workerData,
    scheduler: new StorageMaintenanceScheduler(options, dependencies),
    advance(ms: number): void {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

function ready(worker: FakeWorker, autoCheckpointPages = 1_000): void {
  worker.message({ type: 'ready', autoCheckpointPages });
}

function sliceResult(worker: FakeWorker, requestId: number, nextDelayMs = 25): void {
  worker.message({
    type: 'slice-result',
    requestId,
    tick: null,
    checkpoint: null,
    pausedForCheckpoint: false,
    nextDelayMs,
  });
}

function checkpointResult(worker: FakeWorker, requestId: number): void {
  worker.message({ type: 'checkpoint-result', requestId, checkpoint: CHECKPOINT });
}

function closeResult(worker: FakeWorker, requestId: number): void {
  worker.message({ type: 'closed', requestId, checkpoint: CHECKPOINT });
}

function lastCommand(worker: FakeWorker): StorageMaintenanceWorkerCommand {
  const command = worker.commands.at(-1);
  if (!command) throw new Error('expected a worker command');
  return command;
}

describe('StorageMaintenanceScheduler main controller protocol', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leases main WAL checkpoints only after ready and restores them after graceful close', async () => {
    const harness = createHarness({ initialDelayMs: 1_000 });
    harness.scheduler.start();
    const worker = harness.workers[0];

    expect(harness.db.autoCheckpointPages).toBe(731);
    expect(harness.db.pragmaCalls).toEqual([]);

    ready(worker);
    expect(harness.db.autoCheckpointPages).toBe(0);
    expect(harness.db.pragmaCalls).toEqual([
      'wal_autocheckpoint',
      'wal_autocheckpoint = 0',
      'wal_autocheckpoint',
    ]);

    let stopped = false;
    const stop = harness.scheduler.stop().then(() => {
      stopped = true;
    });
    const close = lastCommand(worker);
    expect(close.type).toBe('close');
    expect(stopped).toBe(false);
    closeResult(worker, close.requestId);
    await stop;

    expect(stopped).toBe(true);
    expect(harness.db.autoCheckpointPages).toBe(731);
    expect(harness.db.pragmaCalls.at(-1)).toBe('wal_autocheckpoint = 731');
  });

  it.each([
    ['fatal message', (worker: FakeWorker) => worker.message({ type: 'fatal', error: 'boom' })],
    ['early exit', (worker: FakeWorker) => worker.emit('exit', 7)],
  ])('restores main WAL checkpoints after worker %s', async (_label, fail) => {
    const harness = createHarness({ initialDelayMs: 1_000, errorRetryMs: 50 });
    harness.scheduler.start();
    const worker = harness.workers[0];
    ready(worker);
    expect(harness.db.autoCheckpointPages).toBe(0);

    fail(worker);
    expect(harness.db.autoCheckpointPages).toBe(731);

    await harness.scheduler.stop();
    harness.advance(50);
    expect(harness.workers).toHaveLength(1);
  });

  it('passes the app-run restart eligibility snapshot unchanged across worker respawn', async () => {
    const db = new FakeDatabase(731, {
      'event-search-v1': 'awaiting-restart',
      'file-snapshot-blobs-v1': 'backfill',
    });
    const harness = createHarness({ initialDelayMs: 1_000, errorRetryMs: 50 }, db);
    harness.scheduler.start();
    const first = harness.workers[0];

    expect(harness.workerData[0].restartEligible).toEqual(['event-search-v1']);
    // Neither an external mutation of the first worker payload nor later DB phase changes may alter
    // the app-run snapshot retained by the controller for replacement workers.
    harness.workerData[0].restartEligible.push('file-snapshot-blobs-v1');
    db.phases['event-search-v1'] = 'complete';
    db.phases['file-snapshot-blobs-v1'] = 'awaiting-restart';

    ready(first);
    first.message({ type: 'fatal', error: 'replace me' });
    harness.advance(50);

    expect(harness.workers).toHaveLength(2);
    expect(harness.workerData[1].restartEligible).toEqual(['event-search-v1']);

    const stop = harness.scheduler.stop();
    harness.workers[1].emit('exit', 1);
    await stop;
  });

  it('keeps one correlated request in flight and ignores stale or mismatched responses', async () => {
    const harness = createHarness({ initialDelayMs: 0, checkpointIntervalMs: 100 });
    harness.scheduler.start();
    const worker = harness.workers[0];
    ready(worker);
    harness.advance(0);

    expect(worker.commands).toHaveLength(1);
    const first = worker.commands[0];
    expect(first.type).toBe('run-slice');

    harness.advance(1_000);
    expect(worker.commands).toHaveLength(1);

    sliceResult(worker, first.requestId + 100, 25);
    checkpointResult(worker, first.requestId);
    harness.advance(1_000);
    expect(worker.commands).toHaveLength(1);

    sliceResult(worker, first.requestId, 25);
    harness.advance(24);
    expect(worker.commands).toHaveLength(1);
    harness.advance(1);
    expect(worker.commands).toHaveLength(2);
    const second = worker.commands[1];
    expect(second).toMatchObject({ type: 'run-slice' });
    expect(second.requestId).not.toBe(first.requestId);

    sliceResult(worker, first.requestId, 25);
    expect(worker.commands).toHaveLength(2);
    sliceResult(worker, second.requestId, 25);

    const stop = harness.scheduler.stop();
    const close = lastCommand(worker);
    expect(close.type).toBe('close');
    closeResult(worker, close.requestId);
    await stop;
  });

  it('queues close behind an active request and settles when the active reply is lost', async () => {
    const harness = createHarness({ initialDelayMs: 0 });
    harness.scheduler.start();
    const worker = harness.workers[0];
    ready(worker);
    harness.advance(0);
    const active = worker.commands[0];
    expect(active.type).toBe('run-slice');

    let stopped = false;
    const stop = harness.scheduler.stop().then(() => {
      stopped = true;
    });
    expect(worker.commands).toHaveLength(2);
    const close = lastCommand(worker);
    expect(close.type).toBe('close');
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(stopped).toBe(false);

    // The worker serially completes `active`, but pretend its result message is lost. It then
    // consumes the queued close, whose independently correlated result must still settle stop().
    closeResult(worker, close.requestId);
    await stop;
    expect(stopped).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('uses idle timer turns for explicit worker checkpoints before maintenance begins', async () => {
    const harness = createHarness({
      initialDelayMs: 1_000,
      checkpointIntervalMs: 100,
    });
    harness.scheduler.start();
    const worker = harness.workers[0];
    ready(worker);

    harness.advance(99);
    expect(worker.commands).toEqual([]);
    harness.advance(1);
    expect(worker.commands).toHaveLength(1);
    const first = worker.commands[0];
    expect(first.type).toBe('checkpoint');

    checkpointResult(worker, first.requestId);
    harness.advance(100);
    expect(worker.commands).toHaveLength(2);
    const second = worker.commands[1];
    expect(second.type).toBe('checkpoint');

    const stop = harness.scheduler.stop();
    checkpointResult(worker, second.requestId);
    const close = lastCommand(worker);
    expect(close.type).toBe('close');
    closeResult(worker, close.requestId);
    await stop;
  });

  it('restores main checkpoint safety on request timeout and waits for close before respawn', async () => {
    const harness = createHarness({
      initialDelayMs: 0,
      requestTimeoutMs: 10,
      errorRetryMs: 5,
    });
    harness.scheduler.start();
    const firstWorker = harness.workers[0];
    ready(firstWorker);
    harness.advance(0);
    expect(lastCommand(firstWorker).type).toBe('run-slice');
    expect(harness.db.autoCheckpointPages).toBe(0);

    harness.advance(10);
    expect(harness.db.autoCheckpointPages).toBe(731);
    const close = lastCommand(firstWorker);
    expect(close.type).toBe('close');

    harness.advance(100);
    expect(harness.workers).toHaveLength(1);
    closeResult(firstWorker, close.requestId);
    harness.advance(4);
    expect(harness.workers).toHaveLength(1);
    harness.advance(1);
    expect(harness.workers).toHaveLength(2);

    const stop = harness.scheduler.stop();
    harness.workers[1].emit('exit', 1);
    await stop;
  });

  it('rolls back a partially acquired checkpoint lease before retiring the worker', async () => {
    const db = new FakeDatabase();
    db.failAutoCheckpointReadAt = 2;
    const harness = createHarness({ initialDelayMs: 1_000 }, db);
    harness.scheduler.start();
    const worker = harness.workers[0];

    ready(worker);
    expect(db.autoCheckpointPages).toBe(731);
    expect(db.pragmaCalls).toEqual([
      'wal_autocheckpoint',
      'wal_autocheckpoint = 0',
      'wal_autocheckpoint',
      'wal_autocheckpoint = 731',
    ]);
    const close = lastCommand(worker);
    expect(close.type).toBe('close');

    const stop = harness.scheduler.stop();
    closeResult(worker, close.requestId);
    await stop;
  });
});
