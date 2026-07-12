import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { awaitStorageShutdownWorker, type StorageShutdownWorkerLike } from './shutdown-runner-protocol';
import type { StorageShutdownTaskResults } from './shutdown-tasks';

const RESULTS: StorageShutdownTaskResults = {
  snapshotIndexes: { ok: true, result: { prepared: true, durationMs: 12 } },
  eventSearchRetirement: {
    ok: true,
    result: { retired: true, durationMs: 34, freedPages: 56 },
  },
};

class FakeWorker extends EventEmitter {}

function awaitFakeWorker(worker: FakeWorker) {
  return awaitStorageShutdownWorker(worker as unknown as StorageShutdownWorkerLike);
}

describe('storage shutdown worker protocol', () => {
  it('ignores task-start and resolves the structured result', async () => {
    const worker = new FakeWorker();
    const pending = awaitFakeWorker(worker);
    worker.emit('message', { type: 'task-start' });
    worker.emit('message', { type: 'result', results: RESULTS });
    worker.emit('exit', 0);
    await expect(pending).resolves.toEqual(RESULTS);
  });

  it('rejects bounded worker fatal messages and process errors', async () => {
    const fatalWorker = new FakeWorker();
    const fatal = awaitFakeWorker(fatalWorker);
    fatalWorker.emit('message', { type: 'fatal', error: 'database locked' });
    await expect(fatal).rejects.toThrow(/database locked/);

    const errorWorker = new FakeWorker();
    const errored = awaitFakeWorker(errorWorker);
    errorWorker.emit('error', new Error('worker crashed'));
    await expect(errored).rejects.toThrow(/worker crashed/);
  });

  it('rejects an exit that arrives before a result', async () => {
    const worker = new FakeWorker();
    const pending = awaitFakeWorker(worker);
    worker.emit('exit', 7);
    await expect(pending).rejects.toThrow(/before result.*code=7/);
  });
});
