import type { Duplex } from 'node:stream';

import {
  BridgeAdmissionDecoder,
  type DecodedBridgeAdmission,
} from '@protocol/index';

import type { RelayStreamRouter } from './router';
import { RelaySocketClientPeer } from './socket-client-peer';
import { RelaySocketWorkerPeer } from './socket-worker-peer';

export interface RelayControlHostOptions {
  readonly router: RelayStreamRouter;
  readonly admissionTimeoutMs?: number;
  readonly maxAdmissionBytes?: number;
  readonly maxConnections?: number;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function bytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  throw new Error('Relay control socket emitted non-byte data');
}

/**
 * Private per-instance Relay socket. It authenticates only provisioning-owned admission metadata,
 * then forwards opaque Core bytes or Worker wire frames without any server compute fallback.
 */
export class RelayControlHost {
  private readonly admissionTimeoutMs: number;
  private readonly maxAdmissionBytes: number;
  private readonly maxConnections: number;
  private readonly pending = new Map<string, Duplex>();
  private readonly clients = new Map<string, RelaySocketClientPeer>();
  private readonly workers = new Map<string, RelaySocketWorkerPeer>();
  private nextConnection = 0;
  private started = false;
  private pumping = false;
  private repump = false;

  constructor(private readonly options: RelayControlHostOptions) {
    this.admissionTimeoutMs = positiveInteger(
      options.admissionTimeoutMs ?? 10_000,
      'admissionTimeoutMs',
    );
    this.maxAdmissionBytes = positiveInteger(
      options.maxAdmissionBytes ?? 8 * 1024,
      'maxAdmissionBytes',
    );
    this.maxConnections = positiveInteger(options.maxConnections ?? 128, 'maxConnections');
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get workerCount(): number {
    return this.workers.size;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const stream of this.pending.values()) stream.destroy();
    this.pending.clear();
    for (const peer of [...this.clients.values()]) peer.terminate();
    for (const peer of [...this.workers.values()]) peer.terminate();
    this.clients.clear();
    this.workers.clear();
  }

  accept(stream: Duplex): string {
    if (!this.started) {
      stream.destroy();
      throw new Error('Relay control host is not running');
    }
    if (this.pending.size + this.clients.size + this.workers.size >= this.maxConnections) {
      stream.destroy();
      throw new Error('Relay control connection limit reached');
    }
    const connectionId = `relay-connection-${++this.nextConnection}`;
    this.pending.set(connectionId, stream);
    this.readAdmission(connectionId, stream);
    return connectionId;
  }

  tick(now = Date.now()): void {
    if (!this.started) return;
    this.options.router.tick(now);
    this.routerChanged();
  }

  private readAdmission(connectionId: string, stream: Duplex): void {
    const decoder = new BridgeAdmissionDecoder(this.maxAdmissionBytes);
    let terminal = false;
    const timeout = setTimeout(() => fail(), this.admissionTimeoutMs);
    timeout.unref();
    const cleanup = (): void => {
      clearTimeout(timeout);
      stream.off('data', onData);
      stream.off('end', fail);
      stream.off('error', fail);
      this.pending.delete(connectionId);
    };
    const fail = (): void => {
      if (terminal) return;
      terminal = true;
      cleanup();
      stream.destroy();
    };
    const onData = (chunk: unknown): void => {
      let decoded: DecodedBridgeAdmission | null;
      try {
        decoded = decoder.push(bytes(chunk));
      } catch {
        fail();
        return;
      }
      if (!decoded) return;
      terminal = true;
      stream.pause();
      cleanup();
      this.handoff(connectionId, stream, decoded);
    };
    stream.on('data', onData);
    stream.once('end', fail);
    stream.once('error', fail);
  }

  private handoff(
    connectionId: string,
    stream: Duplex,
    decoded: DecodedBridgeAdmission,
  ): void {
    const admission = decoded.admission;
    const credential = this.options.router.metadata.credential(admission.credentialId);
    if (
      !this.started ||
      admission.topology !== 'relay' ||
      admission.instanceId !== this.options.router.instanceId ||
      !credential ||
      credential.instanceId !== admission.instanceId ||
      credential.status !== 'active'
    ) {
      stream.destroy();
      return;
    }
    try {
      if (admission.role === 'client') {
        const expectedKind = admission.surface === 'desktop-full' ? 'ssh-client' : 'feishu';
        if (credential.kind !== expectedKind) {
          throw new Error('Credential does not match its provisioned client surface');
        }
        const clientId = `relay-client-${connectionId}`;
        const peer = new RelaySocketClientPeer({
          clientId,
          streamId: `relay-stream-${connectionId}`,
          credentialId: admission.credentialId,
          surface: admission.surface,
          stream,
          router: this.options.router,
          onRouterChanged: () => this.routerChanged(),
          onClosed: (closedId) => this.clients.delete(closedId),
        });
        this.clients.set(clientId, peer);
        peer.start(decoded.remainder);
      } else {
        if (credential.kind !== 'relay-worker') throw new Error('Credential is not a Worker');
        const peer = new RelaySocketWorkerPeer({
          connectionId,
          admission,
          stream,
          router: this.options.router,
          onRouterChanged: () => this.routerChanged(),
          onClosed: (closedId) => this.workers.delete(closedId),
        });
        this.workers.set(connectionId, peer);
        peer.start(decoded.remainder);
      }
      stream.resume();
      this.routerChanged();
    } catch {
      this.clients.get(`relay-client-${connectionId}`)?.terminate();
      this.workers.get(connectionId)?.terminate();
      stream.destroy();
    }
  }

  private routerChanged(): void {
    if (!this.started) return;
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.repump = false;
        for (const connectionId of this.options.router.takeWorkerConnectionsToFence()) {
          this.workers.get(connectionId)?.terminate();
        }
        for (const disconnect of this.options.router.takeClientDisconnects()) {
          this.clients.get(disconnect.clientId)?.terminate();
        }
        for (const peer of this.workers.values()) peer.pullFromRouter();
        for (const peer of this.clients.values()) peer.pullFromRouter();
      } while (this.repump);
    } finally {
      this.pumping = false;
    }
  }
}
