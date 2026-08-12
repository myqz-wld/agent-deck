import { Duplex } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { LengthPrefixedJsonDecoder } from '@protocol/frame';
import { normalizeDaemonConnectionLimits } from './connection-limits';
import { BoundedFrameWriter } from './frame-writer';
import { DEFAULT_DAEMON_CONNECTION_LIMITS } from './types';

class BackpressuredDuplex extends Duplex {
  readonly chunks: Uint8Array[] = [];
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
    this.chunks.push(new Uint8Array(_chunk));
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

  it('rejects limits that cannot retain one normal and two control frames', () => {
    expect(() => normalizeDaemonConnectionLimits({
      maxQueuedEvents: 2,
      maxQueuedFrames: 2,
    })).toThrow(
      /reserve 2 control frames/u,
    );
    expect(() => normalizeDaemonConnectionLimits({ maxQueuedBytes: 1_024 })).toThrow(
      /control-frame liveness/u,
    );
    expect(() => normalizeDaemonConnectionLimits({ maxFrameBytes: 128 })).toThrow(
      /maximum bounded control frame/u,
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

  it('writes a queued pong before unsent business results after drain', async () => {
    const stream = new BackpressuredDuplex();
    const writer = new BoundedFrameWriter(stream, DEFAULT_DAEMON_CONNECTION_LIMITS, {
      onFailure: vi.fn(),
    });
    writer.send({ type: 'result', requestId: 'r1', result: { ok: true }, revision: 1 });
    writer.send({ type: 'result', requestId: 'r2', result: { ok: true }, revision: 2 });
    writer.send({ type: 'pong', nonce: 'heartbeat' });

    stream.release();
    await waitFor(() => writer.queuedByteCount === 0);
    const decoder = new LengthPrefixedJsonDecoder();
    const messages = stream.chunks.flatMap((chunk) => decoder.push(chunk));
    expect(messages.map((message) =>
      'requestId' in (message as Record<string, unknown>)
        ? (message as { requestId: string }).requestId
        : (message as { type: string }).type,
    )).toEqual(['r1', 'pong', 'r2']);
  });

  it('reserves byte capacity for two bounded control frames', async () => {
    const stream = new BackpressuredDuplex();
    const onFailure = vi.fn();
    const writer = new BoundedFrameWriter(stream, {
      ...DEFAULT_DAEMON_CONNECTION_LIMITS,
      maxFrameBytes: 4096,
      maxQueuedBytes: 4096,
      maxQueuedFrames: 10,
    }, { onFailure });
    const nonce = '\\'.repeat(256);
    const result = {
      type: 'result' as const,
      requestId: 'normal',
      result: { payload: 'x'.repeat(1_800) },
      revision: 1,
    };

    writer.send(result);
    writer.send({ type: 'ping', nonce });
    writer.send({ type: 'pong', nonce });
    expect(onFailure).not.toHaveBeenCalled();
    writer.send({
      ...result,
      requestId: 'normal-overflow',
      result: { payload: 'x'.repeat(200) },
    });
    expect(onFailure).toHaveBeenCalledWith('outbound-byte-queue-overflow');
    onFailure.mockClear();

    stream.release();
    await waitFor(() => writer.queuedByteCount === 0);
    const messages = stream.chunks.flatMap((chunk) =>
      new LengthPrefixedJsonDecoder().push(chunk));
    expect(messages.map((message) => (message as { type?: string }).type))
      .toEqual(['result', 'ping', 'pong']);
    writer.dispose();
  });

  it('fails a stream that makes no bounded write progress', async () => {
    vi.useFakeTimers();
    const stream = new BackpressuredDuplex();
    const onFailure = vi.fn();
    const writer = new BoundedFrameWriter(stream, {
      ...DEFAULT_DAEMON_CONNECTION_LIMITS,
      writeProgressTimeoutMs: 25,
    }, { onFailure });
    writer.send({ type: 'result', requestId: 'stalled', result: null, revision: 1 });

    await vi.advanceTimersByTimeAsync(25);
    expect(onFailure).toHaveBeenCalledWith('outbound-write-stalled');
    writer.dispose();
    vi.useRealTimers();
  });
});
