import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { encodeJsonFrame, LengthPrefixedJsonDecoder } from '@protocol/frame';
import { controlFrameByteReserve } from '@protocol/control-frame-budget';

import { BoundedFrameWriter } from './frame-writer';

class ControlledWritable extends EventEmitter {
  readonly writes: Uint8Array[] = [];
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  accepted = true;

  write(frame: Uint8Array, callback: (error?: Error | null) => void): boolean {
    this.writes.push(new Uint8Array(frame));
    this.callbacks.push(callback);
    return this.accepted;
  }

  completeNext(error?: Error): void {
    this.callbacks.shift()?.(error);
  }

  drain(): void {
    this.emit('drain');
  }
}

function writer(
  writable: ControlledWritable,
  limits: { maxQueuedBytes: number; maxQueuedFrames: number },
  onError = vi.fn(),
): BoundedFrameWriter {
  return new BoundedFrameWriter(
    writable as unknown as Writable,
    { maxFrameBytes: 1024, writeProgressTimeoutMs: 10_000, ...limits },
    onError,
  );
}

describe('BoundedFrameWriter exact outstanding bounds', () => {
  it('counts a write(true) frame until its callback completes', () => {
    const writable = new ControlledWritable();
    const subject = writer(writable, { maxQueuedBytes: 4096, maxQueuedFrames: 1 });
    subject.enqueue({ sequence: 1 });
    expect(() => subject.enqueue({ sequence: 2 })).toThrowError('write queue limit');
    writable.completeNext();
    expect(() => subject.enqueue({ sequence: 2 })).not.toThrow();
    expect(writable.writes).toHaveLength(2);
    subject.close();
  });

  it('keeps write(false) accounting independent of callback/drain order', () => {
    const writable = new ControlledWritable();
    writable.accepted = false;
    const subject = writer(writable, { maxQueuedBytes: 4096, maxQueuedFrames: 1 });
    subject.enqueue({ sequence: 1 });
    writable.drain();
    expect(() => subject.enqueue({ sequence: 2 })).toThrowError('write queue limit');

    writable.completeNext();
    expect(() => subject.enqueue({ sequence: 2 })).not.toThrow();
    expect(writable.writes).toHaveLength(2);
    writable.completeNext();
    writable.accepted = true;
    writable.drain();
    subject.close();
  });

  it('can release accounting before drain without writing the queued successor', () => {
    const writable = new ControlledWritable();
    writable.accepted = false;
    const subject = writer(writable, { maxQueuedBytes: 4096, maxQueuedFrames: 1 });
    subject.enqueue({ sequence: 1 });
    writable.completeNext();
    subject.enqueue({ sequence: 2 });
    expect(writable.writes).toHaveLength(1);
    writable.accepted = true;
    writable.drain();
    expect(writable.writes).toHaveLength(2);
    subject.close();
  });

  it('enforces the byte cap across accepted outstanding writes', () => {
    const writable = new ControlledWritable();
    const first = encodeJsonFrame({ payload: 'first' });
    const second = encodeJsonFrame({ payload: 'second' });
    const subject = writer(writable, {
      maxQueuedBytes: controlFrameByteReserve(1024) + first.byteLength + second.byteLength - 1,
      maxQueuedFrames: 8,
    });
    subject.enqueue({ payload: 'first' });
    expect(() => subject.enqueue({ payload: 'second' })).toThrowError('write queue limit');
    writable.completeNext();
    expect(() => subject.enqueue({ payload: 'second' })).not.toThrow();
    subject.close();
  });

  it('settles callbacks once across error, close, and late completion', () => {
    const writable = new ControlledWritable();
    const onError = vi.fn();
    const subject = writer(writable, { maxQueuedBytes: 4096, maxQueuedFrames: 2 }, onError);
    subject.enqueue({ sequence: 1 });
    writable.completeNext(new Error('write failed'));
    writable.on('error', () => undefined);
    writable.emit('error', new Error('duplicate stream error'));
    writable.emit('close');
    subject.close();
    expect(onError).toHaveBeenCalledOnce();
    expect(() => subject.enqueue({ sequence: 2 })).toThrowError('closed');

    const healthyWritable = new ControlledWritable();
    const healthyError = vi.fn();
    const healthy = writer(
      healthyWritable,
      { maxQueuedBytes: 4096, maxQueuedFrames: 1 },
      healthyError,
    );
    healthy.enqueue({ sequence: 1 });
    healthy.close();
    healthyWritable.completeNext();
    healthyWritable.emit('close');
    expect(healthyError).not.toHaveBeenCalled();
  });

  it('never writes queued frames after a write callback reports an error', () => {
    const writable = new ControlledWritable();
    writable.accepted = false;
    const onError = vi.fn();
    const subject = writer(
      writable,
      { maxQueuedBytes: 4096, maxQueuedFrames: 4 },
      onError,
    );
    subject.enqueue({ sequence: 1 });
    subject.enqueue({ sequence: 2 });
    expect(writable.writes).toHaveLength(1);

    writable.completeNext(new Error('terminal callback failure'));
    writable.accepted = true;
    writable.drain();
    expect(onError).toHaveBeenCalledOnce();
    expect(writable.writes).toHaveLength(1);
    expect(() => subject.enqueue({ sequence: 3 })).toThrowError('closed');
  });

  it('writes a queued pong before unsent business requests after drain', () => {
    const writable = new ControlledWritable();
    writable.accepted = false;
    const subject = writer(writable, { maxQueuedBytes: 4096, maxQueuedFrames: 8 });
    subject.enqueue({ type: 'request', requestId: 'r1' });
    subject.enqueue({ type: 'request', requestId: 'r2' });
    subject.enqueue({ type: 'pong', nonce: 'host-heartbeat' });
    expect(writable.writes).toHaveLength(1);

    writable.accepted = true;
    writable.drain();
    const decoder = new LengthPrefixedJsonDecoder();
    const messages = writable.writes.flatMap((frame) => decoder.push(frame));
    expect(messages.map((message) =>
      'requestId' in (message as Record<string, unknown>)
        ? (message as { requestId: string }).requestId
        : (message as { type: string }).type,
    )).toEqual(['r1', 'pong', 'r2']);
    subject.close();
  });

  it('reserves byte capacity for two bounded control frames', () => {
    const writable = new ControlledWritable();
    writable.accepted = false;
    const onError = vi.fn();
    const subject = new BoundedFrameWriter(
      writable as unknown as Writable,
      {
        maxFrameBytes: 4096,
        maxQueuedBytes: 4096,
        maxQueuedFrames: 10,
        writeProgressTimeoutMs: 10_000,
      },
      onError,
    );
    const normal = { type: 'request', requestId: 'normal', payload: 'x'.repeat(1_800) };
    const nonce = '\\'.repeat(256);

    subject.enqueue(normal);
    expect(() => subject.enqueue({ type: 'ping', nonce })).not.toThrow();
    expect(() => subject.enqueue({ type: 'pong', nonce })).not.toThrow();
    expect(() => subject.enqueue({
      type: 'request', requestId: 'normal-overflow', payload: 'x'.repeat(200),
    })).toThrowError('write queue limit');
    expect(onError).not.toHaveBeenCalled();

    writable.accepted = true;
    writable.drain();
    const messages = writable.writes.flatMap((frame) =>
      new LengthPrefixedJsonDecoder().push(frame));
    expect(messages.map((message) => (message as { type?: string }).type))
      .toEqual(['request', 'ping', 'pong']);
    subject.close();
  });

  it('fails when an accepted write makes no callback or drain progress', async () => {
    vi.useFakeTimers();
    try {
      const writable = new ControlledWritable();
      const onError = vi.fn();
      const subject = new BoundedFrameWriter(
        writable as unknown as Writable,
        {
          maxFrameBytes: 1024,
          maxQueuedBytes: 4096,
          maxQueuedFrames: 4,
          writeProgressTimeoutMs: 25,
        },
        onError,
      );
      subject.enqueue({ type: 'request', requestId: 'stalled' });
      await vi.advanceTimersByTimeAsync(25);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        code: 'write_progress_timeout',
      }));
      expect(() => subject.enqueue({ type: 'ping', nonce: 'late' })).toThrowError('closed');
    } finally {
      vi.useRealTimers();
    }
  });
});
