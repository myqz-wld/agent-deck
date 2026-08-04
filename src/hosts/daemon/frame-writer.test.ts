import { Duplex } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { normalizeDaemonConnectionLimits } from './connection-limits';
import { BoundedFrameWriter } from './frame-writer';
import { DEFAULT_DAEMON_CONNECTION_LIMITS } from './types';

class BackpressuredDuplex extends Duplex {
  private blocked = true;
  private readonly callbacks: Array<(error?: Error | null) => void> = [];

  constructor() {
    super({ writableHighWaterMark: 1 });
  }

  _read(): void {}

  _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.blocked) this.callbacks.push(callback);
    else callback();
  }

  release(): void {
    this.blocked = false;
    for (const callback of this.callbacks.splice(0)) callback();
  }

  block(): void {
    this.blocked = true;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for writer accounting');
}

describe('bounded frame writer byte accounting', () => {
  it('requires a positive maxQueuedBytes limit', () => {
    expect(() => normalizeDaemonConnectionLimits({ maxQueuedBytes: 0 })).toThrow(
      /maxQueuedBytes must be a positive safe integer/,
    );
  });

  it('counts the backpressured outstanding frame and resets on completion and dispose', async () => {
    const stream = new BackpressuredDuplex();
    const onFailure = vi.fn();
    const writer = new BoundedFrameWriter(stream, DEFAULT_DAEMON_CONNECTION_LIMITS, {
      onFailure,
    });

    writer.send({ type: 'pong', nonce: 'outstanding' });
    expect(writer.queuedFrameCount).toBe(1);
    expect(writer.queuedByteCount).toBeGreaterThan(0);

    stream.release();
    await waitFor(() => writer.queuedByteCount === 0);
    expect(writer.queuedFrameCount).toBe(0);
    expect(onFailure).not.toHaveBeenCalled();

    stream.block();
    writer.send({ type: 'pong', nonce: 'disposed' });
    expect(writer.queuedByteCount).toBeGreaterThan(0);
    writer.dispose();
    expect(writer.queuedByteCount).toBe(0);
    expect(writer.queuedFrameCount).toBe(0);
    stream.release();
  });
});
