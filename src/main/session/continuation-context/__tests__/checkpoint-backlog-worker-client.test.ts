import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  CheckpointBacklogWorkerClient,
  type CheckpointBacklogWorkerLike,
} from '../checkpoint-backlog-worker-client';
import type {
  CheckpointBacklogWorkerCommand,
  CheckpointBacklogWorkerMessage,
} from '../checkpoint-backlog-worker-contract';
import type { CheckpointBacklogEstimate } from '../checkpoint-backlog-estimator';

vi.mock('../checkpoint-backlog-worker?nodeWorker', () => ({ default: vi.fn() }));

class FakeWorker extends EventEmitter implements CheckpointBacklogWorkerLike {
  readonly commands: CheckpointBacklogWorkerCommand[] = [];
  private resolveTerminate!: (code: number) => void;
  private readonly termination = new Promise<number>((resolve) => {
    this.resolveTerminate = resolve;
  });
  readonly terminate = vi.fn(() => this.termination);

  postMessage(command: CheckpointBacklogWorkerCommand): void {
    this.commands.push({ ...command });
  }

  message(message: CheckpointBacklogWorkerMessage): void {
    this.emit('message', message);
  }

  finishTermination(code = 1): void {
    this.resolveTerminate(code);
  }
}

function estimate(sessionId: string, revision = 1): CheckpointBacklogEstimate {
  return {
    sessionId,
    captureRevision: revision,
    rebuildAfterRevision: 0,
    checkpointThroughRevision: 0,
    checkpointCreatedAt: null,
    estimatedTokens: 8_000,
    sourceRows: 1,
    saturated: false,
  };
}

function harness(options: {
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
} = {}): { client: CheckpointBacklogWorkerClient; worker: FakeWorker } {
  const worker = new FakeWorker();
  return {
    worker,
    client: new CheckpointBacklogWorkerClient('/tmp/agent-deck-backlog.test.db', {
      ...options,
      createWorker: () => worker,
    }),
  };
}

describe('checkpoint backlog worker client protocol', () => {
  it('crosses an asynchronous worker boundary and keeps only one estimate in flight', async () => {
    const { client, worker } = harness();
    const first = client.estimate('first', new AbortController().signal);
    const second = client.estimate('second', new AbortController().signal);
    expect(worker.commands).toEqual([]);

    worker.message({ type: 'ready' });
    expect(worker.commands).toHaveLength(1);
    expect(worker.commands[0]).toMatchObject({ type: 'estimate', sessionId: 'first' });

    const winner = await Promise.race([
      first.then(() => 'estimate' as const),
      new Promise<'event-loop'>((resolve) => setImmediate(() => resolve('event-loop'))),
    ]);
    expect(winner).toBe('event-loop');

    const firstCommand = worker.commands[0] as Extract<
      CheckpointBacklogWorkerCommand,
      { type: 'estimate' }
    >;
    worker.message({
      type: 'estimate-result',
      requestId: firstCommand.requestId,
      result: estimate('first'),
    });
    await expect(first).resolves.toMatchObject({ sessionId: 'first' });
    expect(worker.commands).toHaveLength(2);
    expect(worker.commands[1]).toMatchObject({ type: 'estimate', sessionId: 'second' });

    const secondCommand = worker.commands[1] as Extract<
      CheckpointBacklogWorkerCommand,
      { type: 'estimate' }
    >;
    worker.message({
      type: 'estimate-result',
      requestId: secondCommand.requestId,
      result: estimate('second', 2),
    });
    await expect(second).resolves.toMatchObject({ sessionId: 'second', captureRevision: 2 });

    const stopping = client.stop();
    const close = worker.commands.at(-1)!;
    expect(close.type).toBe('close');
    worker.message({ type: 'closed', requestId: close.requestId });
    worker.emit('exit', 0);
    await stopping;
  });

  it('settles abort promptly but drains the active synchronous request before dispatching next', async () => {
    const { client, worker } = harness();
    const firstController = new AbortController();
    const first = client.estimate('first', firstController.signal);
    const second = client.estimate('second', new AbortController().signal);
    worker.message({ type: 'ready' });
    const firstCommand = worker.commands[0] as Extract<
      CheckpointBacklogWorkerCommand,
      { type: 'estimate' }
    >;

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.commands).toHaveLength(1);

    worker.message({
      type: 'estimate-result',
      requestId: firstCommand.requestId,
      result: estimate('first'),
    });
    expect(worker.commands).toHaveLength(2);
    const secondCommand = worker.commands[1] as Extract<
      CheckpointBacklogWorkerCommand,
      { type: 'estimate' }
    >;
    worker.message({
      type: 'estimate-result',
      requestId: secondCommand.requestId,
      result: estimate('second'),
    });
    await expect(second).resolves.toMatchObject({ sessionId: 'second' });

    const stopping = client.stop();
    const close = worker.commands.at(-1)!;
    worker.message({ type: 'closed', requestId: close.requestId });
    worker.emit('exit', 0);
    await stopping;
  });

  it('rejects queued and active callers while graceful stop waits for worker close', async () => {
    const { client, worker } = harness();
    const active = client.estimate('active', new AbortController().signal);
    const queued = client.estimate('queued', new AbortController().signal);
    worker.message({ type: 'ready' });
    const estimateCommand = worker.commands[0] as Extract<
      CheckpointBacklogWorkerCommand,
      { type: 'estimate' }
    >;

    let stopped = false;
    const stopping = client.stop().then(() => {
      stopped = true;
    });
    await expect(active).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.commands.map((command) => command.type)).toEqual(['estimate', 'close']);
    expect(stopped).toBe(false);

    worker.message({
      type: 'estimate-result',
      requestId: estimateCommand.requestId,
      result: estimate('active'),
    });
    const close = worker.commands[1];
    worker.message({ type: 'closed', requestId: close.requestId });
    expect(stopped).toBe(false);
    worker.emit('exit', 0);
    await stopping;
    expect(stopped).toBe(true);
  });

  it('terminates a worker that never becomes ready and waits for termination before stop settles', async () => {
    vi.useFakeTimers();
    try {
      const { client, worker } = harness({ readyTimeoutMs: 100, stopTimeoutMs: 20 });
      const estimatePromise = client.estimate('starting', new AbortController().signal);
      let stopped = false;
      const stopping = client.stop().then(() => {
        stopped = true;
      });
      await expect(estimatePromise).rejects.toMatchObject({ name: 'AbortError' });
      vi.advanceTimersByTime(19);
      expect(worker.terminate).not.toHaveBeenCalled();
      expect(stopped).toBe(false);

      vi.advanceTimersByTime(1);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(stopped).toBe(false);
      worker.finishTermination();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates when close acknowledgement or exit does not arrive before the stop watchdog', async () => {
    vi.useFakeTimers();
    try {
      const { client, worker } = harness({ stopTimeoutMs: 20 });
      const pending = client.estimate('ready', new AbortController().signal);
      worker.message({ type: 'ready' });
      const command = worker.commands[0] as Extract<
        CheckpointBacklogWorkerCommand,
        { type: 'estimate' }
      >;
      worker.message({
        type: 'estimate-result',
        requestId: command.requestId,
        result: estimate('ready'),
      });
      await pending;

      let stopped = false;
      const stopping = client.stop().then(() => {
        stopped = true;
      });
      expect(worker.commands.at(-1)?.type).toBe('close');
      vi.advanceTimersByTime(20);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(stopped).toBe(false);
      worker.finishTermination();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires once after thread-level failures and ignores duplicate terminal signals', async () => {
    const { client, worker } = harness();
    const active = client.estimate('active', new AbortController().signal);
    const queued = client.estimate('queued', new AbortController().signal);
    worker.message({ type: 'ready' });

    worker.emit('messageerror', new Error('bad clone'));
    await expect(active).rejects.toThrow(/bad clone/);
    await expect(queued).rejects.toThrow(/bad clone/);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    worker.message({ type: 'fatal', error: 'late fatal' });
    worker.emit('error', new Error('late error'));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(client.estimate('replacement', new AbortController().signal)).rejects.toThrow(
      /bad clone|retiring/,
    );
    worker.finishTermination();
    await Promise.resolve();
  });

  it.each([
    ['fatal', (worker: FakeWorker) => worker.message({ type: 'fatal', error: 'fatal failure' })],
    ['error', (worker: FakeWorker) => worker.emit('error', new Error('thread failure'))],
  ])('terminates after a primary %s signal and settles active work', async (_label, fail) => {
    const { client, worker } = harness();
    const pending = client.estimate('active', new AbortController().signal);
    worker.message({ type: 'ready' });
    fail(worker);

    await expect(pending).rejects.toThrow(/failure/);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    worker.finishTermination();
    await Promise.resolve();
  });

  it('isolates stale generation events from a replacement worker', async () => {
    const workers: FakeWorker[] = [];
    const client = new CheckpointBacklogWorkerClient('/tmp/agent-deck-backlog.test.db', {
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const first = client.estimate('first', new AbortController().signal);
    const oldWorker = workers[0];
    oldWorker.message({ type: 'ready' });
    oldWorker.emit('exit', 7);
    await expect(first).rejects.toThrow(/exited unexpectedly/);
    expect(oldWorker.terminate).not.toHaveBeenCalled();

    const second = client.estimate('second', new AbortController().signal);
    const currentWorker = workers[1];
    currentWorker.message({ type: 'ready' });
    oldWorker.message({ type: 'ready' });
    oldWorker.emit('error', new Error('stale error'));
    oldWorker.emit('exit', 9);
    expect(currentWorker.terminate).not.toHaveBeenCalled();
    const command = currentWorker.commands[0] as Extract<
      CheckpointBacklogWorkerCommand,
      { type: 'estimate' }
    >;
    currentWorker.message({
      type: 'estimate-result',
      requestId: command.requestId,
      result: estimate('second'),
    });
    await expect(second).resolves.toMatchObject({ sessionId: 'second' });

    const stopping = client.stop();
    const close = currentWorker.commands.at(-1)!;
    currentWorker.message({ type: 'closed', requestId: close.requestId });
    currentWorker.emit('exit', 0);
    await stopping;
  });
});
