import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  openCheckpointBackgroundSource,
  type CheckpointBackgroundWorkerLike,
} from '../checkpoint-background-worker-client';
import type {
  CheckpointBackgroundWorkerCommand,
  CheckpointBackgroundWorkerMessage,
} from '../checkpoint-background-worker-contract';
import type { BackgroundMaterializedMetadata } from '../checkpoint-background-materializer';

vi.mock('../checkpoint-background-worker?nodeWorker', () => ({ default: vi.fn() }));

class FakeWorker extends EventEmitter implements CheckpointBackgroundWorkerLike {
  readonly commands: CheckpointBackgroundWorkerCommand[] = [];
  terminate = vi.fn<() => Promise<number>>(() => Promise.resolve(0));

  postMessage(command: CheckpointBackgroundWorkerCommand): void {
    this.commands.push(command);
  }

  message(message: CheckpointBackgroundWorkerMessage): void {
    this.emit('message', message);
  }
}

const metadata: BackgroundMaterializedMetadata = {
  sessionId: 'source',
  captureRevision: 1,
  rebuildAfterRevision: 0,
  maxEventId: 1,
  runtimeFingerprint: 'runtime',
  checkpoint: null,
  checkpointThroughRevision: 0,
  materializedThroughRevision: 1,
  sourceRows: 1,
  sourceBytes: 100,
  groupCount: 1,
  normalizedEventCount: 1,
  truncatedBy: 'none',
};

function open(worker: FakeWorker, signal?: AbortSignal) {
  return openCheckpointBackgroundSource({
    dbPath: '/tmp/agent-deck-background.test.db',
    sessionId: 'source',
    deadlineAt: Date.now() + 60_000,
    ...(signal ? { signal } : {}),
    createWorker: () => worker,
  });
}

describe('background checkpoint worker client', () => {
  it('exchanges only bounded chunk DTOs and closes by awaiting termination', async () => {
    const worker = new FakeWorker();
    const opening = open(worker);
    worker.message({ type: 'ready', payloadJson: JSON.stringify({ metadata }) });
    const source = await opening;
    const chunkPromise = source.buildNextChunk({
      cursor: 0,
      coveredThroughRevision: 0,
      previous: null,
      budget: 96_000,
    });
    const command = worker.commands[0];
    expect(command).toMatchObject({ type: 'build-next-chunk', cursor: 0 });
    worker.message({
      type: 'chunk-result',
      requestId: command.requestId,
      payloadJson: JSON.stringify({
        chunk: {
          cursor: 0,
          nextCursor: 1,
          remainingAfter: false,
          consumedGroupCount: 1,
          firstRevision: 1,
          throughRevision: 1,
          prompt: 'bounded',
          normalized: [],
          currentEvidence: [],
          previousForFold: null,
          omittedPriorFacts: 0,
          requiresCoverageMarker: false,
          coverageMarker: null,
        },
      }),
    });
    await expect(chunkPromise).resolves.toMatchObject({ throughRevision: 1 });

    await source.close();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('rejects an oversized worker message before parsing it', async () => {
    const worker = new FakeWorker();
    const opening = openCheckpointBackgroundSource({
      dbPath: '/tmp/agent-deck-background.test.db',
      sessionId: 'source',
      deadlineAt: Date.now() + 60_000,
      maxWireBytes: 128,
      createWorker: () => worker,
    });
    worker.message({ type: 'ready', payloadJson: 'x'.repeat(129) });

    await expect(opening).rejects.toThrow(/wire guard/i);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('does not settle an abort until worker termination completes', async () => {
    const worker = new FakeWorker();
    let release!: (code: number) => void;
    worker.terminate = vi.fn(() => new Promise<number>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const opening = open(worker, controller.signal);
    controller.abort();
    let settled = false;
    void opening.catch(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    release(1);
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('never resolves from a late ready after abort starts termination', async () => {
    const worker = new FakeWorker();
    let release!: (code: number) => void;
    worker.terminate = vi.fn(() => new Promise<number>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const opening = open(worker, controller.signal);
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    void opening.then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );

    controller.abort();
    worker.message({ type: 'ready', payloadJson: JSON.stringify({ metadata }) });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(outcome).toBe('pending');
    expect(worker.terminate).toHaveBeenCalledOnce();
    release(1);
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(outcome).toBe('rejected');
  });

  it('keeps the source occupied after terminate rejects until worker exit is observed', async () => {
    const worker = new FakeWorker();
    worker.terminate = vi.fn(() => Promise.reject(new Error('terminate failed')));
    const opening = open(worker);
    worker.message({ type: 'ready', payloadJson: JSON.stringify({ metadata }) });
    const source = await opening;

    let settled = false;
    const closing = source.close().finally(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    worker.emit('exit', 1);
    await expect(closing).rejects.toThrow('terminate failed');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
