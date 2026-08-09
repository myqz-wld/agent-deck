import type { Writable } from 'node:stream';

import type { JsonValue } from '@contracts/index';
import { encodeJsonFrame } from '@protocol/frame';

import { SshTransportError } from './errors';

export interface FrameWriterLimits {
  maxFrameBytes: number;
  maxQueuedBytes: number;
  maxQueuedFrames: number;
}

interface OutstandingWrite {
  readonly bytes: number;
  active: boolean;
}

export class BoundedFrameWriter {
  private readonly queue: Uint8Array[] = [];
  private readonly outstanding = new Set<OutstandingWrite>();
  private queuedBytes = 0;
  private outstandingBytes = 0;
  private blocked = false;
  private closed = false;
  private maxFrameBytes: number;

  constructor(
    private readonly writable: Writable,
    private readonly limits: FrameWriterLimits,
    private readonly onError: (error: Error) => void,
  ) {
    this.maxFrameBytes = limits.maxFrameBytes;
    try {
      writable.on('error', this.handleError);
      writable.on('close', this.handleClose);
    } catch (error) {
      this.closed = true;
      writable.off('error', this.handleError);
      writable.off('close', this.handleClose);
      throw error;
    }
  }

  setNegotiatedMaxFrameBytes(maxFrameBytes: number): void {
    this.maxFrameBytes = Math.min(this.limits.maxFrameBytes, maxFrameBytes);
  }

  enqueue(value: JsonValue): void {
    if (this.closed) {
      throw new SshTransportError('connection_closed', 'SSH write channel is closed');
    }
    const frame = encodeJsonFrame(value, this.maxFrameBytes);
    if (
      this.queue.length + this.outstanding.size >= this.limits.maxQueuedFrames ||
      this.queuedBytes + this.outstandingBytes + frame.byteLength > this.limits.maxQueuedBytes
    ) {
      throw new SshTransportError(
        'write_queue_limit',
        'SSH transport write queue limit reached',
        true,
      );
    }
    this.queue.push(frame);
    this.queuedBytes += frame.byteLength;
    this.flush();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.releaseOutstanding();
    this.blocked = false;
    this.writable.off('error', this.handleError);
    this.writable.off('close', this.handleClose);
    this.writable.off('drain', this.handleDrain);
  }

  private readonly handleError = (error: Error): void => {
    if (this.closed) return;
    this.fail(error);
  };

  private readonly handleClose = (): void => {
    if (this.closed) return;
    this.fail(new SshTransportError('connection_closed', 'SSH write channel closed'));
  };

  private readonly handleDrain = (): void => {
    if (this.closed) return;
    this.blocked = false;
    this.flush();
  };

  private flush(): void {
    while (!this.closed && !this.blocked && this.queue.length > 0) {
      const frame = this.queue.shift();
      if (!frame) return;
      this.queuedBytes -= frame.byteLength;
      const write: OutstandingWrite = { bytes: frame.byteLength, active: true };
      this.outstanding.add(write);
      this.outstandingBytes += write.bytes;
      try {
        const accepted = this.writable.write(frame, (error) => {
          if (error) {
            this.fail(error);
            return;
          }
          this.complete(write);
        });
        if (this.closed) return;
        if (!accepted) {
          this.blocked = true;
          this.writable.once('drain', this.handleDrain);
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private complete(write: OutstandingWrite): void {
    if (!write.active) return;
    write.active = false;
    if (!this.outstanding.delete(write)) return;
    this.outstandingBytes -= write.bytes;
    if (!this.closed && !this.blocked) this.flush();
  }

  private releaseOutstanding(): void {
    for (const write of this.outstanding) write.active = false;
    this.outstanding.clear();
    this.outstandingBytes = 0;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.releaseOutstanding();
    this.blocked = false;
    this.writable.off('error', this.handleError);
    this.writable.off('close', this.handleClose);
    this.writable.off('drain', this.handleDrain);
    this.onError(error);
  }
}
