import type { Duplex } from 'node:stream';

import {
  RelayClientFrameBridge,
  type RelayClientStream,
  type RelayRouteFrame,
} from '@protocol/relay';

import type { RelayStreamRouter } from './router';

function bytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  throw new Error('Relay client stream emitted non-byte data');
}

export interface RelaySocketClientPeerOptions {
  readonly clientId: string;
  readonly streamId: string;
  readonly credentialId: string;
  readonly surface: 'desktop-full' | 'feishu-session-console';
  readonly stream: Duplex;
  readonly router: RelayStreamRouter;
  readonly onRouterChanged: () => void;
  readonly onClosed: (clientId: string) => void;
}

/** One bounded opaque Core byte stream carried by one Relay route stream. */
export class RelaySocketClientPeer {
  private readonly bridge: RelayClientFrameBridge;
  private readonly pendingInbound: RelayRouteFrame[] = [];
  private readonly maxChunkBytes: number;
  private handle: RelayClientStream | null = null;
  private blocked = false;
  private closed = false;
  private pumping = false;

  constructor(private readonly options: RelaySocketClientPeerOptions) {
    const { limits } = options.router;
    if (limits.maxFrameBytes <= 1024) {
      throw new Error('Relay control transport requires maxFrameBytes greater than 1024');
    }
    this.maxChunkBytes = Math.min(64 * 1024, limits.maxFrameBytes - 1024);
    this.bridge = new RelayClientFrameBridge(
      options.router.instanceId,
      options.router.status().generation,
      (frame) => {
        options.router.routeFromClient(options.clientId, frame);
        options.onRouterChanged();
      },
      {
        initialCreditBytes: limits.initialCreditBytes,
        maxCreditBytes: limits.maxCreditBytes,
        maxQueueBytesPerStream: limits.maxQueueBytesPerStream,
        maxQueueBytesPerClient: limits.maxQueueBytesPerClient,
        maxQueueFramesPerStream: 1024,
        maxQueueFramesPerClient: 4096,
        maxFrameBytes: limits.maxFrameBytes,
      },
    );
  }

  start(remainder: Uint8Array): void {
    if (this.closed || this.handle) throw new Error('Relay client peer already started');
    const stream = this.options.stream;
    stream.on('data', this.onData);
    stream.on('drain', this.onDrain);
    stream.once('end', this.onEnd);
    stream.once('error', this.onTerminal);
    stream.once('close', this.onTerminal);
    this.options.router.registerClient(
      this.options.clientId,
      this.options.credentialId,
      this.options.surface,
    );
    try {
      this.handle = this.bridge.open(this.options.streamId, {
        data: (payload) => {
          if (this.closed) return;
          if (!stream.write(payload)) this.blocked = true;
        },
        close: () => stream.end(),
        reset: () => stream.destroy(),
      });
      if (remainder.byteLength > 0) this.forward(remainder);
    } catch (error) {
      this.terminate();
      throw error;
    }
  }

  pullFromRouter(): void {
    if (this.closed || this.blocked) return;
    if (this.pendingInbound.length === 0) {
      this.pendingInbound.push(...this.options.router.drainClient(this.options.clientId));
    }
    this.pumpInbound();
  }

  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachListeners();
    try {
      this.handle?.cancel();
    } catch {}
    this.handle = null;
    this.pendingInbound.splice(0);
    this.options.router.disconnectClient(this.options.clientId);
    if (!this.options.stream.destroyed) this.options.stream.destroy();
    this.options.onClosed(this.options.clientId);
    this.options.onRouterChanged();
  }

  private readonly onData = (chunk: unknown): void => {
    try {
      this.forward(bytes(chunk));
    } catch {
      this.terminate();
    }
  };

  private readonly onDrain = (): void => {
    this.blocked = false;
    this.pumpInbound();
    this.options.onRouterChanged();
  };

  private readonly onEnd = (): void => {
    try {
      this.handle?.close();
      this.options.onRouterChanged();
    } catch {
      this.terminate();
    }
  };

  private readonly onTerminal = (): void => this.terminate();

  private forward(chunk: Uint8Array): void {
    const handle = this.handle;
    if (!handle || this.closed) return;
    for (let offset = 0; offset < chunk.byteLength; offset += this.maxChunkBytes) {
      handle.send(chunk.subarray(offset, Math.min(chunk.byteLength, offset + this.maxChunkBytes)));
    }
    this.options.onRouterChanged();
  }

  private pumpInbound(): void {
    if (this.pumping || this.closed || this.blocked) return;
    this.pumping = true;
    try {
      while (!this.blocked && this.pendingInbound.length > 0) {
        const frame = this.pendingInbound.shift();
        if (frame) this.bridge.accept(frame);
      }
    } catch {
      this.terminate();
    } finally {
      this.pumping = false;
    }
  }

  private detachListeners(): void {
    const stream = this.options.stream;
    stream.off('data', this.onData);
    stream.off('drain', this.onDrain);
    stream.off('end', this.onEnd);
    stream.off('error', this.onTerminal);
    stream.off('close', this.onTerminal);
  }
}
