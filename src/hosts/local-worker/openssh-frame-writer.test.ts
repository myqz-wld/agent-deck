import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerOpenSshFrameWriter } from './openssh-frame-writer';

function harness(limits = { maxQueuedBytes: 8, maxQueuedFrames: 3, progressTimeoutMs: 100 }) {
  const received: Buffer[] = [];
  const callbacks: Array<(error?: Error | null) => void> = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) {
    received.push(Buffer.from(chunk)); callbacks.push(done);
  } });
  output.on('error', () => undefined);
  const failed = vi.fn();
  const writer = new WorkerOpenSshFrameWriter(output, limits, failed);
  return { output, writer, received, callbacks, failed };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(() => vi.useRealTimers());

describe('Worker OpenSSH outbound bounds', () => {
  it('counts both the accepted write and queued frames against the byte bound', async () => {
    const t = harness();
    try {
      t.writer.enqueue(new Uint8Array(4));
      t.writer.enqueue(new Uint8Array(4));
      expect(() => t.writer.enqueue(new Uint8Array(1))).toThrow('queue limit');
      t.callbacks.shift()!(); await tick();
      expect(() => t.writer.enqueue(new Uint8Array(4))).not.toThrow();
      expect(t.failed).not.toHaveBeenCalled();
    } finally { t.writer.close(); }
  });

  it('bounds frame count even for tiny writes', () => {
    const t = harness();
    try {
      for (let index = 0; index < 3; index += 1) t.writer.enqueue(new Uint8Array(1));
      expect(() => t.writer.enqueue(new Uint8Array(1))).toThrow('queue limit');
      expect(t.received).toHaveLength(1);
    } finally { t.writer.close(); }
  });

  it('discards queued frames on close and ignores late callbacks and drain', async () => {
    const t = harness();
    t.writer.enqueue(new Uint8Array(2)); t.writer.enqueue(new Uint8Array(2));
    t.writer.close();
    t.callbacks.shift()!(); await tick();
    t.output.emit('drain');
    expect(t.received).toHaveLength(1);
    expect(t.failed).not.toHaveBeenCalled();
    expect(() => t.writer.enqueue(new Uint8Array(1))).toThrow('closed');
  });

  it('closes once when an accepted write fails', async () => {
    const t = harness();
    t.writer.enqueue(new Uint8Array(2)); t.writer.enqueue(new Uint8Array(2));
    t.callbacks.shift()!(new Error('pipe failed')); await tick();
    expect(t.failed).toHaveBeenCalledOnce();
    expect(t.received).toHaveLength(1);
    expect(() => t.writer.enqueue(new Uint8Array(1))).toThrow('closed');
    t.writer.close();
  });

  it('times out only after writes stop progressing and cancels the timer on close', async () => {
    vi.useFakeTimers();
    const t = harness();
    t.writer.enqueue(new Uint8Array(2)); t.writer.enqueue(new Uint8Array(2));
    await vi.advanceTimersByTimeAsync(99);
    expect(t.failed).not.toHaveBeenCalled();
    t.callbacks.shift()!();
    await vi.advanceTimersByTimeAsync(99);
    expect(t.failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.failed).toHaveBeenCalledOnce();
    expect(t.failed.mock.calls[0][0].message).toContain('no progress');
    t.writer.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
