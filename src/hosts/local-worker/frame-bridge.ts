import {
  assertRelayRouteFrame,
  emptyRoutePayload,
  type RelayResetCode,
  type RelayRouteFrame,
} from '@protocol/relay';
import { resolveRelayOutputChunkBytes } from './frame-bridge-chunking';
import {
  assertLimits,
  DEFAULT_LOCAL_WORKER_BRIDGE_LIMITS,
  type BridgeStream,
  type CoreFrameChannelFactory,
  type LocalWorkerFrameBridgeLimits,
} from './frame-bridge-types';
export { DEFAULT_LOCAL_WORKER_BRIDGE_LIMITS } from './frame-bridge-types';
export type {
  CoreFrameAccessContext, CoreFrameChannel, CoreFrameChannelFactory, CoreFrameOutput,
  LocalWorkerFrameBridgeLimits,
} from './frame-bridge-types';

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
    if (
      frame.connectionScope === null || frame.accessSurface === null || frame.accessGrant === null
    ) {
      throw new Error('Relay open frame is missing its authenticated client context');
    }
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
      outputChunkBytes: Math.min(this.limits.maxOutputQueueBytesPerStream, resolveRelayOutputChunkBytes({
        instanceId: this.instanceId,
        generation: this.generation,
        streamId: frame.streamId,
        initialCreditBytes: this.limits.initialCreditBytes,
        maxCreditBytes: this.limits.maxCreditBytes,
        maxFrameBytes: this.limits.maxFrameBytes,
      })),
      outputQueue: [],
      outputQueueBytes: 0,
      closePending: false,
      outputWaiter: null,
      channel: null,
    };
    this.streams.set(stream.streamId, stream);
    try {
      const channel = this.channels.open(stream.streamId, {
        maxChunkBytes: stream.outputChunkBytes,
        data: (payload) => this.onCoreData(stream, payload),
        close: () => this.onCoreClose(stream),
        reset: (code = 'protocol_error') => this.fail(stream, code),
      }, {
        connectionScope: frame.connectionScope,
        surface: frame.accessSurface,
        grant: frame.accessGrant,
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

  private async onCoreData(stream: BridgeStream, payload: Uint8Array): Promise<boolean> {
    if (this.streams.get(stream.streamId) !== stream) return false;
    if (
      !(payload instanceof Uint8Array) || payload.byteLength === 0 ||
      payload.byteLength > stream.outputChunkBytes || stream.closePending
    ) {
      this.fail(stream, 'protocol_error');
      return false;
    }
    // One bounded chunk may wait per stream. Producers must await its admission.
    if (stream.outputWaiter) {
      this.fail(stream, 'backpressure');
      return false;
    }
    try {
      while (this.streams.get(stream.streamId) === stream) {
        if (stream.outputQueue.length === 0 && payload.byteLength <= stream.outputCredit) {
          stream.outputCredit -= payload.byteLength;
          return this.emitData(stream, payload);
        }
        if (
          stream.outputQueueBytes + payload.byteLength <= this.limits.maxOutputQueueBytesPerStream &&
          this.totalOutputQueueBytes + payload.byteLength <= this.limits.maxOutputQueueBytesTotal &&
          stream.outputQueue.length < this.limits.maxOutputQueueFramesPerStream &&
          this.totalOutputQueueFrames < this.limits.maxOutputQueueFramesTotal
        ) {
          stream.outputQueue.push(payload.slice());
          stream.outputQueueBytes += payload.byteLength;
          this.totalOutputQueueBytes += payload.byteLength;
          this.totalOutputQueueFrames += 1;
          return true;
        }
        await new Promise<void>((resolve) => { stream.outputWaiter = resolve; });
        stream.outputWaiter = null;
      }
      return false;
    } finally {
      if (stream.closePending && this.streams.get(stream.streamId) === stream) this.flush(stream);
    }
  }

  private wakeOutputWriters(): void {
    for (const stream of this.streams.values()) stream.outputWaiter?.();
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
    this.wakeOutputWriters();
    if (stream.closePending && !stream.outputWaiter && stream.outputQueue.length === 0) {
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
        connectionScope: null,
        accessSurface: null,
        accessGrant: null,
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
      connectionScope: null,
      accessSurface: null,
      accessGrant: null,
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
      connectionScope: null,
      accessSurface: null,
      accessGrant: null,
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
        connectionScope: null,
        accessSurface: null,
        accessGrant: null,
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
    stream.outputWaiter?.();
    this.wakeOutputWriters();
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
