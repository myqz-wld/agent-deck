import type { Duplex } from 'node:stream';

import type { BridgeWorkerAdmission } from '@protocol/index';

import type { RelayStreamRouter } from './router';
import { RelayWorkerAttachmentPeer } from './worker-attachment-peer';

function bytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  throw new Error('Relay Worker stream emitted non-byte data');
}

export interface RelaySocketWorkerPeerOptions {
  readonly connectionId: string;
  readonly admission: BridgeWorkerAdmission;
  readonly stream: Duplex;
  readonly router: RelayStreamRouter;
  readonly onRouterChanged: () => void;
  readonly onClosed: (connectionId: string) => void;
  readonly maxPendingBytes?: number;
}

/** Owns one authenticated Worker stdio attachment without owning Core or provider lifecycle. */
export class RelaySocketWorkerPeer {
  private readonly peer: RelayWorkerAttachmentPeer;
  private readonly pending: Uint8Array[] = [];
  private readonly maxPendingBytes: number;
  private pendingBytes = 0;
  private blocked = false;
  private closed = false;
  private closeAfterFlush = false;

  constructor(private readonly options: RelaySocketWorkerPeerOptions) {
    this.maxPendingBytes = options.maxPendingBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.maxPendingBytes) || this.maxPendingBytes <= 0) {
      throw new RangeError('maxPendingBytes must be a positive safe integer');
    }
    this.peer = new RelayWorkerAttachmentPeer(options.router, options.connectionId, {
      instanceId: options.admission.instanceId,
      workerId: options.admission.workerId,
      credentialId: options.admission.credentialId,
    });
  }

  start(remainder: Uint8Array): void {
    const stream = this.options.stream;
    stream.on('data', this.onData);
    stream.on('drain', this.onDrain);
    stream.once('error', this.onTerminal);
    stream.once('end', this.onTerminal);
    stream.once('close', this.onTerminal);
    if (remainder.byteLength > 0) this.accept(remainder);
  }

  pullFromRouter(): void {
    if (this.closed || this.blocked || this.pending.length > 0) return;
    for (const chunk of this.peer.drain(512 * 1024)) this.enqueue(chunk);
    this.flush();
  }

  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachListeners();
    this.pending.splice(0);
    this.pendingBytes = 0;
    this.peer.close();
    if (!this.options.stream.destroyed) this.options.stream.destroy();
    this.options.onClosed(this.options.connectionId);
    this.options.onRouterChanged();
  }

  private readonly onData = (chunk: unknown): void => {
    try {
      this.accept(bytes(chunk));
    } catch {
      this.terminate();
    }
  };

  private readonly onDrain = (): void => {
    this.blocked = false;
    this.flush();
    this.options.onRouterChanged();
  };

  private readonly onTerminal = (): void => this.terminate();

  private accept(chunk: Uint8Array): void {
    for (const output of this.peer.push(chunk)) this.enqueue(output);
    if (this.peer.state() === 'rejected') this.closeAfterFlush = true;
    this.flush();
    this.options.onRouterChanged();
  }

  private enqueue(chunk: Uint8Array): void {
    const copy = chunk.slice();
    if (this.pendingBytes + copy.byteLength > this.maxPendingBytes) {
      throw new Error('Relay Worker socket output queue overflow');
    }
    this.pending.push(copy);
    this.pendingBytes += copy.byteLength;
  }

  private flush(): void {
    while (!this.closed && !this.blocked && this.pending.length > 0) {
      const chunk = this.pending.shift();
      if (!chunk) break;
      this.pendingBytes -= chunk.byteLength;
      if (!this.options.stream.write(chunk)) this.blocked = true;
    }
    if (this.closeAfterFlush && !this.blocked && this.pending.length === 0) {
      this.options.stream.end();
    }
  }

  private detachListeners(): void {
    const stream = this.options.stream;
    stream.off('data', this.onData);
    stream.off('drain', this.onDrain);
    stream.off('error', this.onTerminal);
    stream.off('end', this.onTerminal);
    stream.off('close', this.onTerminal);
  }
}
