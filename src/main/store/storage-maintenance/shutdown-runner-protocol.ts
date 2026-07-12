import type { StorageShutdownTaskResults } from './shutdown-tasks';
import type { StorageShutdownWorkerMessage } from './shutdown-contract';

export interface StorageShutdownWorkerLike {
  on(event: 'message', listener: (message: StorageShutdownWorkerMessage) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
}

/** Await a worker without terminating an in-flight synchronous SQLite transaction. */
export function awaitStorageShutdownWorker(
  worker: StorageShutdownWorkerLike,
): Promise<StorageShutdownTaskResults> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (results: StorageShutdownTaskResults): void => {
      if (settled) return;
      settled = true;
      resolve(results);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    worker.on('message', (message) => {
      if (message.type === 'task-start') return;
      if (message.type === 'result') succeed(message.results);
      else if (message.type === 'fatal') {
        fail(new Error(`storage shutdown worker failed: ${message.error}`));
      }
    });
    worker.on('error', (error) => fail(error));
    worker.on('exit', (code) => {
      if (!settled) fail(new Error(`storage shutdown worker exited before result (code=${code})`));
    });
  });
}
