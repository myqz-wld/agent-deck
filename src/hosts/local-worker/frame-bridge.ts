import {
  assertRelayRouteFrame,
  emptyRoutePayload,
  type RelayResetCode,
  type RelayRouteFrame,
} from '@protocol/relay';

export interface CoreFrameOutput {
  data(payload: Uint8Array): void;
  close(): void;
  reset(code?: RelayResetCode): void;
}

export interface CoreFrameChannel {
  write(payload: Uint8Array): boolean;
  closeInput(): void;
  reset(code: RelayResetCode): void;
}

export interface CoreFrameChannelFactory {
  open(streamId: string, output: CoreFrameOutput): CoreFrameChannel;
}

export interface LocalWorkerFrameBridgeLimits {
  initialCreditBytes: number;
  maxCreditBytes: number;
  maxOutputQueueBytesPerStream: number;
  maxOutputQueueBytesTotal: number;
  maxOutputQueueFramesPerStream: number;
  maxOutputQueueFramesTotal: number;
  maxFrameBytes: number;
}

export const DEFAULT_LOCAL_WORKER_BRIDGE_LIMITS: LocalWorkerFrameBridgeLimits = {
  initialCreditBytes: 256 * 1024,
  maxCreditBytes: 1024 * 1024,
  maxOutputQueueBytesPerStream: 512 * 1024,
  maxOutputQueueBytesTotal: 4 * 1024 * 1024,
  maxOutputQueueFramesPerStream: 1024,
  maxOutputQueueFramesTotal: 8192,
  maxFrameBytes: 4 * 1024 * 1024,
};

interface BridgeStream {
  streamId: string;
  nextInboundSequence: number;
  nextOutboundSequence: number;
  inputCredit: number;
  inputClosed: boolean;
  outputCredit: number;
  outputQueue: Uint8Array[];
  outputQueueBytes: number;
  closePending: boolean;
  channel: CoreFrameChannel | null;
}

function assertLimits(limits: LocalWorkerFrameBridgeLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (limits.initialCreditBytes > limits.maxCreditBytes) {
    throw new RangeError('initialCreditBytes cannot exceed maxCreditBytes');
  }
  if (limits.maxOutputQueueBytesPerStream > limits.maxOutputQueueBytesTotal) {
    throw new RangeError('Per-stream output queue cannot exceed total output queue');
  }
  if (limits.maxOutputQueueFramesPerStream > limits.maxOutputQueueFramesTotal) {
    throw new RangeError('Per-stream output frames cannot exceed total output frames');
  }
}

export class LocalWorkerFrameBridge {
  private readonly streams = new Map<string, BridgeStream>();
  private totalOutputQueueBytes = 0;
  private totalOutputQueueFrames = 0;
  private disposed = false;

  constructor(
    readonly instanceId: string,
    readonly generation: number,
    private readonly channels: CoreFrameChannelFactory,
    private readonly emit: (frame: RelayRouteFrame) => void,
    readonly limits: LocalWorkerFrameBridgeLimits = DEFAULT_LOCAL_WORKER_BRIDGE_LIMITS,
  ) {
    assertLimits(limits);
  }

  accept(frame: RelayRouteFrame): void {
    if (this.disposed) throw new Error('Local Worker frame bridge is disposed');
    assertRelayRouteFrame(frame, {
      maxFrameBytes: this.limits.maxFrameBytes,
      maxCreditBytes: this.limits.maxCreditBytes,
    });
    if (
      frame.instanceId !== this.instanceId ||
      frame.generation !== this.generation ||
      frame.direction !== 'client-to-worker' ||
      frame.kind === 'heartbeat'
    ) {
      throw new Error('Relay frame does not belong to this local Worker bridge');
    }
    if (frame.kind === 'open') {
      this.open(frame);
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      throw new Error('Relay frame references an unknown local Worker stream');
    }
    if (frame.sequence !== stream.nextInboundSequence) {
      this.fail(stream, 'protocol_error');
      return;
    }
    stream.nextInboundSequence += 1;

    switch (frame.kind) {
      case 'data': {
        if (stream.inputClosed || frame.payload.byteLength > stream.inputCredit) {
          this.fail(stream, 'protocol_error');
          return;
        }
        stream.inputCredit -= frame.payload.byteLength;
        let accepted = false;
        try {
          accepted = stream.channel?.write(frame.payload) ?? false;
        } catch {
          this.fail(stream, 'protocol_error');
          return;
        }
        if (!accepted) {
          this.fail(stream, 'backpressure');
          return;
        }
        if (this.streams.get(stream.streamId) !== stream) return;
        stream.inputCredit += frame.payload.byteLength;
        this.emitControl(stream, 'credit', frame.payload.byteLength, null);
        return;
      }
      case 'credit':
        if (
          frame.creditBytes === null ||
          stream.outputCredit + frame.creditBytes > this.limits.maxCreditBytes
        ) {
          this.fail(stream, 'protocol_error');
          return;
        }
        stream.outputCredit += frame.creditBytes;
        this.flush(stream);
        return;
      case 'close':
        if (stream.inputClosed) {
          this.fail(stream, 'protocol_error');
          return;
        }
        stream.inputClosed = true;
        try {
          stream.channel?.closeInput();
        } catch {
          this.fail(stream, 'protocol_error');
        }
        return;
      case 'reset': {
        const channel = stream.channel;
        this.remove(stream);
        try {
          channel?.reset(frame.resetCode ?? 'cancelled');
        } catch {
          // Stream-local cleanup cannot take down the shared Worker attachment.
        }
        return;
      }
      default:
        this.fail(stream, 'protocol_error');
    }
  }

  private open(frame: RelayRouteFrame): void {
    const existing = this.streams.get(frame.streamId);
    if (existing) {
      this.fail(existing, 'protocol_error');
      return;
    }
    const stream: BridgeStream = {
      streamId: frame.streamId,
      nextInboundSequence: 1,
      nextOutboundSequence: 0,
      inputCredit: this.limits.initialCreditBytes,
      inputClosed: false,
      outputCredit: this.limits.initialCreditBytes,
      outputQueue: [],
      outputQueueBytes: 0,
      closePending: false,
      channel: null,
    };
    this.streams.set(stream.streamId, stream);
    try {
      const channel = this.channels.open(stream.streamId, {
        data: (payload) => this.onCoreData(stream, payload),
        close: () => this.onCoreClose(stream),
        reset: (code = 'protocol_error') => this.fail(stream, code),
      });
      if (this.streams.get(stream.streamId) !== stream) {
        try {
          channel.reset('protocol_error');
        } catch {
          // Synchronous output already terminated this stream.
        }
        return;
      }
      stream.channel = channel;
    } catch {
      this.fail(stream, 'protocol_error');
    }
  }

  private onCoreData(stream: BridgeStream, payload: Uint8Array): void {
    if (this.streams.get(stream.streamId) !== stream) return;
    if (!(payload instanceof Uint8Array) || payload.byteLength === 0) {
      this.fail(stream, 'protocol_error');
      return;
    }
    if (payload.byteLength > this.limits.maxFrameBytes) {
      this.fail(stream, 'protocol_error');
      return;
    }
    if (stream.outputQueue.length === 0 && payload.byteLength <= stream.outputCredit) {
      stream.outputCredit -= payload.byteLength;
      this.emitData(stream, payload);
      return;
    }
    const nextStreamBytes = stream.outputQueueBytes + payload.byteLength;
    const nextTotalBytes = this.totalOutputQueueBytes + payload.byteLength;
    const nextStreamFrames = stream.outputQueue.length + 1;
    const nextTotalFrames = this.totalOutputQueueFrames + 1;
    if (
      nextStreamBytes > this.limits.maxOutputQueueBytesPerStream ||
      nextTotalBytes > this.limits.maxOutputQueueBytesTotal ||
      nextStreamFrames > this.limits.maxOutputQueueFramesPerStream ||
      nextTotalFrames > this.limits.maxOutputQueueFramesTotal
    ) {
      this.fail(stream, 'backpressure');
      return;
    }
    const copy = payload.slice();
    stream.outputQueue.push(copy);
    stream.outputQueueBytes = nextStreamBytes;
    this.totalOutputQueueBytes = nextTotalBytes;
    this.totalOutputQueueFrames = nextTotalFrames;
  }

  private onCoreClose(stream: BridgeStream): void {
    if (this.streams.get(stream.streamId) !== stream) return;
    stream.closePending = true;
    this.flush(stream);
  }

  private flush(stream: BridgeStream): void {
    while (stream.outputQueue.length > 0) {
      const payload = stream.outputQueue[0];
      if (payload.byteLength > stream.outputCredit) break;
      stream.outputQueue.shift();
      stream.outputQueueBytes -= payload.byteLength;
      this.totalOutputQueueBytes -= payload.byteLength;
      this.totalOutputQueueFrames -= 1;
      stream.outputCredit -= payload.byteLength;
      if (!this.emitData(stream, payload)) return;
    }
    if (stream.closePending && stream.outputQueue.length === 0) {
      const closeFrame: RelayRouteFrame = {
        instanceId: this.instanceId,
        generation: this.generation,
        streamId: stream.streamId,
        direction: 'worker-to-client',
        sequence: stream.nextOutboundSequence,
        kind: 'close',
        payload: emptyRoutePayload(),
        creditBytes: null,
        resetCode: null,
      };
      this.remove(stream);
      try {
        this.emit(closeFrame);
      } catch {
        // The terminal stream was removed before invoking the transport callback.
      }
    }
  }

  private emitData(stream: BridgeStream, payload: Uint8Array): boolean {
    const delivered = this.emitFrame(stream, {
      instanceId: this.instanceId,
      generation: this.generation,
      streamId: stream.streamId,
      direction: 'worker-to-client',
      sequence: stream.nextOutboundSequence,
      kind: 'data',
      payload: payload.slice(),
      creditBytes: null,
      resetCode: null,
    });
    if (delivered) stream.nextOutboundSequence += 1;
    return delivered;
  }

  private emitControl(
    stream: BridgeStream,
    kind: 'close' | 'credit',
    creditBytes: number | null,
    resetCode: RelayResetCode | null,
  ): boolean {
    const delivered = this.emitFrame(stream, {
      instanceId: this.instanceId,
      generation: this.generation,
      streamId: stream.streamId,
      direction: 'worker-to-client',
      sequence: stream.nextOutboundSequence,
      kind,
      payload: emptyRoutePayload(),
      creditBytes,
      resetCode,
    });
    if (delivered) stream.nextOutboundSequence += 1;
    return delivered;
  }

  private fail(stream: BridgeStream, code: RelayResetCode): void {
    if (this.streams.get(stream.streamId) !== stream) return;
    const channel = stream.channel;
    const sequence = stream.nextOutboundSequence;
    this.remove(stream);
    try {
      this.emit({
        instanceId: this.instanceId,
        generation: this.generation,
        streamId: stream.streamId,
        direction: 'worker-to-client',
        sequence,
        kind: 'reset',
        payload: emptyRoutePayload(),
        creditBytes: null,
        resetCode: code,
      });
    } catch {
      // Transport callback failure is confined to this removed stream.
    }
    try {
      channel?.reset(code);
    } catch {
      // Stream-local cleanup cannot take down the shared Worker attachment.
    }
  }

  private emitFrame(stream: BridgeStream, frame: RelayRouteFrame): boolean {
    try {
      this.emit(frame);
      return true;
    } catch {
      this.fail(stream, 'protocol_error');
      return false;
    }
  }

  private remove(stream: BridgeStream): void {
    if (this.streams.get(stream.streamId) !== stream) return;
    this.totalOutputQueueBytes -= stream.outputQueueBytes;
    this.totalOutputQueueFrames -= stream.outputQueue.length;
    stream.outputQueue.length = 0;
    stream.outputQueueBytes = 0;
    this.streams.delete(stream.streamId);
  }

  dispose(code: RelayResetCode = 'worker_disconnected'): void {
    this.disposed = true;
    for (const stream of [...this.streams.values()]) {
      const channel = stream.channel;
      this.remove(stream);
      try {
        channel?.reset(code);
      } catch {
        // Continue fencing every remaining stream.
      }
    }
  }

  streamCount(): number {
    return this.streams.size;
  }

  queuedOutputBytes(): number {
    return this.totalOutputQueueBytes;
  }

  queuedOutputFrames(): number {
    return this.totalOutputQueueFrames;
  }
}
