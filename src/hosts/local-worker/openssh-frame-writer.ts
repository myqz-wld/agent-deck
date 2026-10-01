import type { Writable } from 'node:stream';

export interface WorkerFrameWriterLimits {
  readonly maxQueuedBytes: number;
  readonly maxQueuedFrames: number;
  readonly progressTimeoutMs: number;
}

interface PendingWrite {
  readonly bytes: Uint8Array;
}

/** A false write result accepts that frame; only the next write must wait for drain. */
export class WorkerOpenSshFrameWriter {
  private readonly queue: PendingWrite[] = [];
  private readonly outstanding = new Set<PendingWrite>();
  private pendingBytes = 0;
  private blocked = false;
  private flushing = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly output: Writable,
    private readonly limits: WorkerFrameWriterLimits,
    private readonly onFailure: (error: Error) => void,
  ) {
    output.on('drain', this.onDrain);
  }

  enqueue(bytes: Uint8Array): void {
    if (this.closed) throw new Error('Worker attachment writer is closed');
    if (this.queue.length + this.outstanding.size >= this.limits.maxQueuedFrames ||
      this.pendingBytes + bytes.byteLength > this.limits.maxQueuedBytes) {
      throw new Error('Worker attachment write queue limit exceeded');
    }
    this.queue.push({ bytes: bytes.slice() });
    this.pendingBytes += bytes.byteLength;
    this.flush();
    this.armTimer();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.output.off('drain', this.onDrain);
    this.queue.splice(0);
    this.outstanding.clear();
    this.pendingBytes = 0;
    this.clearTimer();
  }

  private readonly onDrain = (): void => {
    if (this.closed) return;
    this.blocked = false;
    this.progress();
    this.flush();
  };

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (!this.closed && !this.blocked && this.queue.length > 0) {
        const write = this.queue.shift()!;
        this.outstanding.add(write);
        const accepted = this.output.write(write.bytes, (error) => {
          if (!this.outstanding.delete(write) || this.closed) return;
          this.pendingBytes -= write.bytes.byteLength;
          if (error) { this.fail(error); return; }
          this.progress();
          this.flush();
        });
        if (!accepted) this.blocked = true;
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Worker attachment write failed'));
    } finally {
      this.flushing = false;
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.close();
    this.onFailure(error);
  }

  private progress(): void {
    this.clearTimer();
    this.armTimer();
  }

  private armTimer(): void {
    if (this.closed || this.timer || this.pendingBytes === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fail(new Error('Worker attachment write made no progress before its deadline'));
    }, this.limits.progressTimeoutMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
