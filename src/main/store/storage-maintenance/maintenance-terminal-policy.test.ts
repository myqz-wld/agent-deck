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
  StorageMaintenanceWorkerCommand,
  StorageMaintenanceWorkerMessage,
} from './maintenance-worker-contract';

class FakeDatabase {
  readonly name = '/tmp/agent-deck-maintenance-terminal-policy.test.db';
  readonly pragmaCalls: string[] = [];
  autoCheckpointPages = 731;

  prepare(): { get: (task: string) => Record<string, unknown> } {
    return {
      get: (task) => ({
        task,
        phase: 'backfill',
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
    if (source === 'wal_autocheckpoint' && options?.simple) {
      return this.autoCheckpointPages;
    }
    const assignment = /^wal_autocheckpoint\s*=\s*(\d+)$/.exec(source);
    if (!assignment) throw new Error(`unexpected pragma: ${source}`);
    this.autoCheckpointPages = Number(assignment[1]);
    return [];
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

function createHarness(options: SchedulerOptions = {}) {
  let now = 0;
  const db = new FakeDatabase();
  const workers: FakeWorker[] = [];
  const dependencies: StorageMaintenanceSchedulerDependencies = {
    getDatabase: () => db as unknown as Database,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as StorageMaintenanceWorkerLike;
    },
    now: () => now,
  };
  return {
    db,
    workers,
    scheduler: new StorageMaintenanceScheduler(options, dependencies),
    advance(ms: number): void {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

function ready(worker: FakeWorker): void {
  worker.message({ type: 'ready', autoCheckpointPages: 1_000 });
}

function closeResult(worker: FakeWorker, requestId: number): void {
  worker.message({
    type: 'closed',
    requestId,
    checkpoint: { busy: 0, log: 0, checkpointed: 0, durationMs: 1 },
  });
}

function lastCommand(worker: FakeWorker): StorageMaintenanceWorkerCommand {
  const command = worker.commands.at(-1);
  if (!command) throw new Error('expected worker command');
  return command;
}

describe('storage maintenance terminal timeout policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      label: 'run-slice',
      options: { initialDelayMs: 0, checkpointIntervalMs: 100 },
      firstDelayMs: 0,
      expectedType: 'run-slice',
    },
    {
      label: 'checkpoint',
      options: { initialDelayMs: 1_000, checkpointIntervalMs: 5 },
      firstDelayMs: 5,
      expectedType: 'checkpoint',
    },
  ] as const)(
    'disables maintenance until restart after a $label timeout',
    async ({ options, firstDelayMs, expectedType }) => {
      const harness = createHarness({ ...options, requestTimeoutMs: 10, errorRetryMs: 5 });
      harness.scheduler.start();
      const worker = harness.workers[0];
      ready(worker);
      harness.advance(firstDelayMs);
      const active = lastCommand(worker);
      expect(active.type).toBe(expectedType);
      expect(harness.db.autoCheckpointPages).toBe(0);

      harness.advance(10);
      expect(harness.db.autoCheckpointPages).toBe(731);
      expect(
        harness.db.pragmaCalls.filter((call) => call === 'wal_autocheckpoint = 731'),
      ).toHaveLength(1);
      expect(worker.commands.map(({ type }) => type)).toEqual([expectedType, 'close']);
      expect(worker.terminate).not.toHaveBeenCalled();

      if (active.type === 'run-slice') {
        worker.message({
          type: 'slice-result',
          requestId: active.requestId,
          tick: null,
          checkpoint: null,
          pausedForCheckpoint: false,
          nextDelayMs: 1,
        });
      } else {
        worker.message({
          type: 'checkpoint-result',
          requestId: active.requestId,
          checkpoint: { busy: 0, log: 0, checkpointed: 0, durationMs: 1 },
        });
      }
      harness.advance(1_000);
      expect(worker.commands).toHaveLength(2);

      let stopped = false;
      const stop = harness.scheduler.stop().then(() => {
        stopped = true;
      });
      closeResult(worker, lastCommand(worker).requestId + 100);
      await Promise.resolve();
      expect(stopped).toBe(true);
      harness.advance(5);
      expect(harness.workers).toHaveLength(1);
      await stop;
    },
  );

  it('does not queue a second close when the close request itself times out', async () => {
    const harness = createHarness({
      initialDelayMs: 1_000,
      requestTimeoutMs: 10,
      errorRetryMs: 5,
    });
    harness.scheduler.start();
    const worker = harness.workers[0];
    ready(worker);

    const stop = harness.scheduler.stop();
    const close = lastCommand(worker);
    expect(worker.commands.map(({ type }) => type)).toEqual(['close']);

    harness.advance(10);
    expect(worker.commands.map(({ type }) => type)).toEqual(['close']);
    expect(harness.db.autoCheckpointPages).toBe(731);
    expect(worker.terminate).not.toHaveBeenCalled();

    closeResult(worker, close.requestId);
    await stop;
    harness.advance(100);
    expect(harness.workers).toHaveLength(1);
  });

  it.each(['fatal', 'exit', 'error-then-exit'] as const)(
    'does not respawn after a late worker %s',
    async (outcome) => {
      const harness = createHarness({
        initialDelayMs: 0,
        requestTimeoutMs: 10,
        errorRetryMs: 5,
      });
      harness.scheduler.start();
      const worker = harness.workers[0];
      ready(worker);
      harness.advance(0);
      harness.advance(10);

      if (outcome === 'fatal') worker.message({ type: 'fatal', error: 'late fatal' });
      if (outcome === 'exit') worker.emit('exit', 1);
      if (outcome === 'error-then-exit') {
        worker.emit('error', new Error('late error'));
        worker.emit('exit', 1);
      }
      harness.advance(100);

      expect(harness.workers).toHaveLength(1);
      expect(worker.terminate).not.toHaveBeenCalled();
      await harness.scheduler.stop();
    },
  );

  it('allows only a fresh scheduler instance to start maintenance again', async () => {
    const first = createHarness({ initialDelayMs: 0, requestTimeoutMs: 10 });
    first.scheduler.start();
    ready(first.workers[0]);
    first.advance(0);
    first.advance(10);
    closeResult(first.workers[0], lastCommand(first.workers[0]).requestId);
    await first.scheduler.stop();

    first.scheduler.start();
    expect(first.workers).toHaveLength(1);

    const fresh = createHarness();
    fresh.scheduler.start();
    expect(fresh.workers).toHaveLength(1);
    fresh.workers[0].emit('exit', 0);
    await fresh.scheduler.stop();
  });
});
