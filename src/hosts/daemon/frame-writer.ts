import type { Duplex } from 'node:stream';

import type { JsonValue } from '@contracts/index';
import { encodeJsonFrame, type HostProtocolMessage } from '@protocol/index';

import type { DaemonConnectionLimits } from './types';

interface OutboundFrame {
  readonly bytes: Uint8Array;
  readonly event: boolean;
}

export interface BoundedFrameWriterCallbacks {
  readonly onFailure: (reason: string) => void;
}

/** Keeps host-side buffering bounded independently for every connected stream. */
export class BoundedFrameWriter {
  private readonly frames: OutboundFrame[] = [];
  private queuedEvents = 0;
  private outstandingFrames = 0;
  private outstandingEvents = 0;
  private queuedBytesValue = 0;
  private waitingForDrain = false;
  private disposed = false;

  constructor(
    private readonly stream: Duplex,
    private readonly limits: DaemonConnectionLimits,
    private readonly callbacks: BoundedFrameWriterCallbacks,
  ) {}

  get queuedFrameCount(): number {
    return this.frames.length + this.outstandingFrames;
  }

  get queuedByteCount(): number {
    return this.queuedBytesValue;
  }

  send(message: HostProtocolMessage, event = false): void {
    if (this.disposed) return;
    if (
      this.queuedFrameCount >= this.limits.maxQueuedFrames ||
      (event && this.queuedEvents + this.outstandingEvents >= this.limits.maxQueuedEvents)
    ) {
      this.callbacks.onFailure('outbound-queue-overflow');
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = encodeJsonFrame(message as unknown as JsonValue, this.limits.maxFrameBytes);
    } catch {
      this.callbacks.onFailure('outbound-frame-invalid');
      return;
    }
    if (bytes.byteLength > this.limits.maxQueuedBytes - this.queuedBytesValue) {
      this.callbacks.onFailure('outbound-byte-queue-overflow');
      return;
    }
    this.frames.push({ bytes, event });
    this.queuedBytesValue += bytes.byteLength;
    if (event) this.queuedEvents += 1;
    this.pump();
  }

  /** Resolves once this writer's own queue is empty; it does not claim remote acknowledgement. */
  async flushed(): Promise<void> {
    while (!this.disposed && this.queuedBytesValue > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stream.off('drain', this.onDrain);
    this.frames.splice(0);
    this.queuedEvents = 0;
    this.outstandingFrames = 0;
    this.outstandingEvents = 0;
    this.queuedBytesValue = 0;
    this.waitingForDrain = false;
  }

  private pump(): void {
    if (this.disposed || this.waitingForDrain) return;
    try {
      while (this.frames.length > 0) {
        const frame = this.frames.shift();
        if (!frame) break;
        if (frame.event) this.queuedEvents -= 1;
        this.outstandingFrames += 1;
        if (frame.event) this.outstandingEvents += 1;
        let completed = false;
        const complete = (error?: Error | null): void => {
          if (completed) return;
          completed = true;
          if (this.disposed) return;
          this.outstandingFrames -= 1;
          if (frame.event) this.outstandingEvents -= 1;
          this.queuedBytesValue -= frame.bytes.byteLength;
          if (error) this.callbacks.onFailure('transport-write-failed');
          else if (!this.waitingForDrain) this.pump();
        };
        if (!this.stream.write(frame.bytes, complete)) {
          this.waitingForDrain = true;
          this.stream.once('drain', this.onDrain);
          return;
        }
      }
    } catch {
      this.callbacks.onFailure('transport-write-failed');
    }
  }

  private readonly onDrain = (): void => {
    this.waitingForDrain = false;
    this.pump();
  };
}
