import type { Duplex } from 'node:stream';

import type { JsonValue } from '@contracts/index';
import { encodeJsonFrame, type HostProtocolMessage } from '@protocol/index';
import {
  normalByteLimit,
  normalFrameLimit,
} from '@protocol/control-frame-budget';

import type { DaemonConnectionLimits } from './types';

/** Transport adapters emit this only after another bounded chunk is admitted downstream. */
export const DAEMON_WRITE_PROGRESS_EVENT = 'daemon-write-progress';

interface OutboundFrame {
  readonly bytes: Uint8Array;
  readonly control: boolean;
  readonly event: boolean;
}

function isControlFrame(message: HostProtocolMessage): boolean {
  return message.type === 'ping' || message.type === 'pong';
}

export interface BoundedFrameWriterCallbacks {
  readonly onFailure: (reason: string) => void;
}

/** Keeps host-side buffering bounded independently for every connected stream. */
export class BoundedFrameWriter {
  private readonly frames: OutboundFrame[] = [];
  private readonly controlFrames: OutboundFrame[] = [];
  private queuedEvents = 0;
  private outstandingFrames = 0;
  private outstandingEvents = 0;
  private queuedBytesValue = 0;
  private waitingForDrain = false;
  private disposed = false;
  private progressTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly stream: Duplex,
    private readonly limits: DaemonConnectionLimits,
    private readonly callbacks: BoundedFrameWriterCallbacks,
  ) {
    this.stream.on(DAEMON_WRITE_PROGRESS_EVENT, this.onWriteProgress);
  }

  get queuedFrameCount(): number {
    return this.controlFrames.length + this.frames.length + this.outstandingFrames;
  }

  get queuedByteCount(): number {
    return this.queuedBytesValue;
  }

  send(message: HostProtocolMessage, event = false): void {
    if (this.disposed) return;
    const control = isControlFrame(message);
    const frameLimit = control
      ? this.limits.maxQueuedFrames
      : normalFrameLimit(this.limits.maxQueuedFrames);
    const byteLimit = control
      ? this.limits.maxQueuedBytes
      : normalByteLimit(this.limits.maxQueuedBytes, this.limits.maxFrameBytes);
    if (
      this.queuedFrameCount >= frameLimit ||
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
    if (bytes.byteLength > byteLimit - this.queuedBytesValue) {
      this.callbacks.onFailure('outbound-byte-queue-overflow');
      return;
    }
    const frame = { bytes, control, event };
    if (control) this.controlFrames.push(frame);
    else this.frames.push(frame);
    this.queuedBytesValue += bytes.byteLength;
    if (event) this.queuedEvents += 1;
    this.pump();
    this.ensureProgressTimer();
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
    this.stream.off(DAEMON_WRITE_PROGRESS_EVENT, this.onWriteProgress);
    this.controlFrames.splice(0);
    this.frames.splice(0);
    this.queuedEvents = 0;
    this.outstandingFrames = 0;
    this.outstandingEvents = 0;
    this.queuedBytesValue = 0;
    this.waitingForDrain = false;
    this.clearProgressTimer();
  }

  private pump(): void {
    if (this.disposed || this.waitingForDrain) return;
    try {
      while (this.controlFrames.length > 0 || this.frames.length > 0) {
        const frame = this.controlFrames.shift() ?? this.frames.shift();
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
          else {
            this.recordProgress();
            if (!this.waitingForDrain) this.pump();
          }
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

  private readonly onWriteProgress = (): void => {
    if (!this.disposed && this.queuedBytesValue > 0) this.recordProgress();
  };

  private readonly onDrain = (): void => {
    this.waitingForDrain = false;
    this.recordProgress();
    this.pump();
  };

  private ensureProgressTimer(): void {
    if (this.disposed || this.queuedBytesValue === 0 || this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      if (!this.disposed && this.queuedBytesValue > 0) {
        this.callbacks.onFailure('outbound-write-stalled');
      }
    }, this.limits.writeProgressTimeoutMs);
    this.progressTimer.unref?.();
  }

  private recordProgress(): void {
    this.clearProgressTimer();
    this.ensureProgressTimer();
  }

  private clearProgressTimer(): void {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
  }
}
