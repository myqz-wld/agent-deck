import {
  assertRelayRouteFrame,
  emptyRoutePayload,
  type RelayResetCode,
  type RelayRouteFrame,
} from './route-frame';

export interface RelayClientStreamListener {
  data(payload: Uint8Array): void;
  close(): void;
  reset(code: RelayResetCode): void;
}

export interface RelayClientStream {
  readonly streamId: string;
  send(payload: Uint8Array): void;
  close(): void;
  cancel(): void;
}

export interface RelayClientBridgeLimits {
  initialCreditBytes: number;
  maxCreditBytes: number;
  maxQueueBytesPerStream: number;
  maxQueueBytesPerClient: number;
  maxQueueFramesPerStream: number;
  maxQueueFramesPerClient: number;
  maxFrameBytes: number;
}

export const DEFAULT_RELAY_CLIENT_BRIDGE_LIMITS: RelayClientBridgeLimits = {
  initialCreditBytes: 256 * 1024,
  maxCreditBytes: 1024 * 1024,
  maxQueueBytesPerStream: 512 * 1024,
  maxQueueBytesPerClient: 2 * 1024 * 1024,
  maxQueueFramesPerStream: 1024,
  maxQueueFramesPerClient: 4096,
  maxFrameBytes: 4 * 1024 * 1024,
};

interface ClientStreamState {
  streamId: string;
  listener: RelayClientStreamListener;
  nextOutboundSequence: number;
  nextInboundSequence: number;
  sendCredit: number;
  receiveCredit: number;
  queue: Uint8Array[];
  queueBytes: number;
  closePending: boolean;
  closeSent: boolean;
}

export class RelayClientBridgeError extends Error {
  constructor(readonly code: RelayResetCode | 'protocol_error', message: string) {
    super(message);
    this.name = 'RelayClientBridgeError';
  }
}

function assertLimits(limits: RelayClientBridgeLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (limits.initialCreditBytes > limits.maxCreditBytes) {
    throw new RangeError('initialCreditBytes cannot exceed maxCreditBytes');
  }
  if (limits.maxQueueBytesPerStream > limits.maxQueueBytesPerClient) {
    throw new RangeError('Per-stream queue cannot exceed per-client queue');
  }
  if (limits.maxQueueFramesPerStream > limits.maxQueueFramesPerClient) {
    throw new RangeError('Per-stream frame queue cannot exceed per-client frame queue');
  }
}

/** Bounded generic byte-stream adapter; ordinary Core frames remain opaque to the Relay layer. */
export class RelayClientFrameBridge {
  private readonly streams = new Map<string, ClientStreamState>();
  private queuedBytes = 0;
  private queuedFrames = 0;

  constructor(
    readonly instanceId: string,
    private generationValue: number,
    private readonly emit: (frame: RelayRouteFrame) => void,
    readonly limits: RelayClientBridgeLimits = DEFAULT_RELAY_CLIENT_BRIDGE_LIMITS,
  ) {
    assertLimits(limits);
  }

  generation(): number {
    return this.generationValue;
  }

  resynchronize(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new RangeError('generation must be a non-negative safe integer');
    }
    const streams = [...this.streams.values()];
    for (const stream of streams) this.remove(stream);
    this.generationValue = generation;
    for (const stream of streams) {
      try {
        stream.listener.reset('resync_required');
      } catch {
        // An observer cannot leave this or another stream registered.
      }
    }
  }

  open(streamId: string, listener: RelayClientStreamListener): RelayClientStream {
    if (streamId.length === 0 || this.streams.has(streamId)) {
      throw new RelayClientBridgeError('protocol_error', 'streamId must be unique and non-empty');
    }
    const stream: ClientStreamState = {
      streamId,
      listener,
      nextOutboundSequence: 1,
      nextInboundSequence: 0,
      sendCredit: this.limits.initialCreditBytes,
      receiveCredit: this.limits.initialCreditBytes,
      queue: [],
      queueBytes: 0,
      closePending: false,
      closeSent: false,
    };
    const openFrame = this.frame(stream, 0, 'open');
    try {
      assertRelayRouteFrame(openFrame, {
        maxFrameBytes: this.limits.maxFrameBytes,
        maxCreditBytes: this.limits.maxCreditBytes,
      });
    } catch {
      throw new RelayClientBridgeError('protocol_error', 'streamId is not a valid Relay id');
    }
    this.streams.set(streamId, stream);
    if (!this.emitFrame(stream, openFrame)) {
      throw new RelayClientBridgeError('protocol_error', 'Relay open emission failed');
    }
    return {
      streamId,
      send: (payload) => this.send(stream, payload),
      close: () => this.close(stream),
      cancel: () => this.cancel(stream),
    };
  }

  accept(frame: RelayRouteFrame): void {
    assertRelayRouteFrame(frame, {
      maxFrameBytes: this.limits.maxFrameBytes,
      maxCreditBytes: this.limits.maxCreditBytes,
    });
    if (frame.instanceId !== this.instanceId || frame.direction !== 'worker-to-client') {
      throw new RelayClientBridgeError('protocol_error', 'Inbound Relay frame identity is invalid');
    }
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;
    const generationMismatch = frame.generation !== this.generationValue;
    if (
      generationMismatch &&
      !(
        frame.kind === 'reset' &&
        (frame.resetCode === 'generation_mismatch' || frame.resetCode === 'worker_offline')
      )
    ) {
      this.fail(stream, 'generation_mismatch');
      throw new RelayClientBridgeError('generation_mismatch', 'Relay generation changed');
    }
    if (frame.sequence !== stream.nextInboundSequence) {
      this.fail(stream, 'protocol_error');
      throw new RelayClientBridgeError('protocol_error', 'Inbound stream sequence is invalid');
    }
    stream.nextInboundSequence += 1;

    switch (frame.kind) {
      case 'data':
        if (frame.payload.byteLength > stream.receiveCredit) {
          this.fail(stream, 'protocol_error');
          return;
        }
        stream.receiveCredit -= frame.payload.byteLength;
        try {
          stream.listener.data(frame.payload.slice());
        } catch {
          this.fail(stream, 'protocol_error');
          return;
        }
        if (this.streams.get(stream.streamId) !== stream) return;
        stream.receiveCredit += frame.payload.byteLength;
        this.emitSequencedFrame(
          stream,
          this.frame(stream, stream.nextOutboundSequence, 'credit', frame.payload.byteLength),
        );
        return;
      case 'credit':
        if (
          frame.creditBytes === null ||
          stream.sendCredit + frame.creditBytes > this.limits.maxCreditBytes
        ) {
          this.fail(stream, 'protocol_error');
          return;
        }
        stream.sendCredit += frame.creditBytes;
        this.flush(stream);
        return;
      case 'close':
        this.remove(stream);
        try {
          stream.listener.close();
        } catch {
          // The stream is already terminal and cannot be orphaned by its listener.
        }
        return;
      case 'reset':
        this.remove(stream);
        try {
          stream.listener.reset(frame.resetCode ?? 'protocol_error');
        } catch {
          // The stream is already terminal and cannot be orphaned by its listener.
        }
        return;
      default:
        this.fail(stream, 'protocol_error');
        throw new RelayClientBridgeError('protocol_error', 'Inbound frame kind is invalid');
    }
  }

  private send(stream: ClientStreamState, payload: Uint8Array): void {
    if (this.streams.get(stream.streamId) !== stream || stream.closePending) {
      throw new RelayClientBridgeError('cancelled', 'Relay stream is closed');
    }
    if (!(payload instanceof Uint8Array) || payload.byteLength === 0) {
      throw new RelayClientBridgeError('protocol_error', 'payload must be non-empty Uint8Array');
    }
    if (payload.byteLength > this.limits.maxFrameBytes) {
      throw new RelayClientBridgeError('protocol_error', 'payload exceeds maxFrameBytes');
    }
    if (stream.queue.length === 0 && payload.byteLength <= stream.sendCredit) {
      stream.sendCredit -= payload.byteLength;
      if (!this.emitData(stream, payload)) {
        throw new RelayClientBridgeError('protocol_error', 'Relay data emission failed');
      }
      return;
    }
    const streamBytes = stream.queueBytes + payload.byteLength;
    const clientBytes = this.queuedBytes + payload.byteLength;
    const streamFrames = stream.queue.length + 1;
    const clientFrames = this.queuedFrames + 1;
    if (
      streamBytes > this.limits.maxQueueBytesPerStream ||
      clientBytes > this.limits.maxQueueBytesPerClient ||
      streamFrames > this.limits.maxQueueFramesPerStream ||
      clientFrames > this.limits.maxQueueFramesPerClient
    ) {
      this.fail(stream, 'backpressure');
      throw new RelayClientBridgeError('backpressure', 'Relay client queue limit exceeded');
    }
    const copy = payload.slice();
    stream.queue.push(copy);
    stream.queueBytes = streamBytes;
    this.queuedBytes = clientBytes;
    this.queuedFrames = clientFrames;
  }

  private emitData(stream: ClientStreamState, payload: Uint8Array): boolean {
    return this.emitSequencedFrame(stream, {
      ...this.frame(stream, stream.nextOutboundSequence, 'data'),
      payload: payload.slice(),
    });
  }

  private close(stream: ClientStreamState): void {
    if (this.streams.get(stream.streamId) !== stream || stream.closePending) return;
    stream.closePending = true;
    this.flush(stream);
  }

  private cancel(stream: ClientStreamState): void {
    if (this.streams.get(stream.streamId) !== stream) return;
    const reset = this.frame(stream, stream.nextOutboundSequence, 'reset', null, 'cancelled');
    this.remove(stream);
    try {
      this.emit(reset);
    } catch {
      // Local cancellation remains terminal even if the transport callback fails.
    }
  }

  private flush(stream: ClientStreamState): void {
    while (stream.queue.length > 0) {
      const payload = stream.queue[0];
      if (payload.byteLength > stream.sendCredit) break;
      stream.queue.shift();
      stream.queueBytes -= payload.byteLength;
      this.queuedBytes -= payload.byteLength;
      this.queuedFrames -= 1;
      stream.sendCredit -= payload.byteLength;
      if (!this.emitData(stream, payload)) return;
    }
    if (stream.closePending && !stream.closeSent && stream.queue.length === 0) {
      if (this.emitSequencedFrame(stream, this.frame(stream, stream.nextOutboundSequence, 'close'))) {
        stream.closeSent = true;
      }
    }
  }

  private fail(stream: ClientStreamState, code: RelayResetCode): void {
    if (this.streams.get(stream.streamId) !== stream) return;
    const reset = this.frame(stream, stream.nextOutboundSequence, 'reset', null, code);
    this.remove(stream);
    try {
      this.emit(reset);
    } catch {
      // Transport failure is confined to this removed stream.
    }
    try {
      stream.listener.reset(code);
    } catch {
      // Listener failure is confined to this removed stream.
    }
  }

  private emitFrame(stream: ClientStreamState, frame: RelayRouteFrame): boolean {
    try {
      this.emit(frame);
      return this.streams.get(stream.streamId) === stream;
    } catch {
      this.fail(stream, 'protocol_error');
      return false;
    }
  }

  private emitSequencedFrame(stream: ClientStreamState, frame: RelayRouteFrame): boolean {
    const sequence = stream.nextOutboundSequence;
    stream.nextOutboundSequence = sequence + 1;
    try {
      this.emit(frame);
      return this.streams.get(stream.streamId) === stream;
    } catch {
      if (
        this.streams.get(stream.streamId) === stream &&
        stream.nextOutboundSequence === sequence + 1
      ) {
        stream.nextOutboundSequence = sequence;
      }
      this.fail(stream, 'protocol_error');
      return false;
    }
  }

  private frame(
    stream: ClientStreamState,
    sequence: number,
    kind: 'open' | 'close' | 'reset' | 'credit' | 'data',
    creditBytes: number | null = null,
    resetCode: RelayResetCode | null = null,
  ): RelayRouteFrame {
    return {
      instanceId: this.instanceId,
      generation: this.generationValue,
      streamId: stream.streamId,
      direction: 'client-to-worker',
      sequence,
      kind,
      payload: emptyRoutePayload(),
      creditBytes,
      resetCode,
    };
  }

  private remove(stream: ClientStreamState): void {
    if (this.streams.get(stream.streamId) !== stream) return;
    this.queuedBytes -= stream.queueBytes;
    this.queuedFrames -= stream.queue.length;
    stream.queue.length = 0;
    stream.queueBytes = 0;
    this.streams.delete(stream.streamId);
  }

  streamCount(): number {
    return this.streams.size;
  }

  queuedOutputBytes(): number {
    return this.queuedBytes;
  }

  queuedOutputFrames(): number {
    return this.queuedFrames;
  }
}
