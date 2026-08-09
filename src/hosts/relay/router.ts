import type { WorkerAttachRequest } from '@protocol/relay';
import { BoundedRelayFrameQueue } from './bounded-queue';
import { RelayCredentialPolicy } from './credential-policy';
import { RelayMetadataStore } from './metadata';
import { RELAY_CONTROL_STREAM_ID, type RelayRouteFrame } from '@protocol/relay';
import {
  assertRelayRouterFrame,
  closeRelayRoute,
  createRelayClientQueue,
  fenceRecoveredRelayRoutes,
  recordOpenRelayRoute,
  type RelayClientState,
  type RelayStreamState,
} from './router-state';
import { RelayTerminalCoordinator } from './router-terminal';
import {
  assertRelayRouterLimits,
  DEFAULT_RELAY_ROUTER_LIMITS,
  RelayRouterError,
  type RelayClientDisconnect,
  type RelayRouteResult,
  type RelayRouterLimits,
  type RelayWorkerDelivery,
} from './router-types';
import {
  WorkerLeaseRegistry,
  type WorkerLeaseAttachResult,
  type WorkerLeaseStatus,
} from './worker-lease';
import { drainWorkerFrames } from './worker-delivery';

export {
  DEFAULT_RELAY_ROUTER_LIMITS,
  RelayRouterError,
  type RelayClientDisconnect,
  type RelayRouteResult,
  type RelayRouterLimits,
  type RelayWorkerDelivery,
} from './router-types';

export class RelayStreamRouter {
  readonly lease: WorkerLeaseRegistry;
  private readonly clients = new Map<string, RelayClientState>();
  private readonly streams = new Map<string, RelayStreamState>();
  private readonly workerQueue: BoundedRelayFrameQueue;
  private readonly workerConnectionsToFence: string[] = [];
  private readonly clientDisconnects: RelayClientDisconnect[] = [];
  private readonly terminal: RelayTerminalCoordinator;
  private readonly credentials: RelayCredentialPolicy;
  private nextWorkerHeartbeatSequence = 0;
  private nextRelayHeartbeatSequence = 0;

  constructor(
    readonly instanceId: string,
    readonly metadata: RelayMetadataStore,
    readonly limits: RelayRouterLimits = DEFAULT_RELAY_ROUTER_LIMITS,
    recoveredAt = Date.now(),
  ) {
    assertRelayRouterLimits(limits);
    if (metadata.getById('instances', instanceId) === null) {
      metadata.put('instances', {
        id: instanceId,
        instanceId,
        topology: 'relay',
        createdAt: recoveredAt,
      });
    }
    const frameLimits = {
      maxFrameBytes: limits.maxFrameBytes,
      maxCreditBytes: limits.maxCreditBytes,
    };
    this.workerQueue = new BoundedRelayFrameQueue(
      limits.maxQueueBytesPerStream,
      limits.maxQueueBytesToWorker,
      frameLimits,
    );
    this.lease = new WorkerLeaseRegistry(
      instanceId,
      metadata,
      limits.heartbeatTimeoutMs,
      {
        initialCreditBytes: limits.initialCreditBytes,
        maxCreditBytes: limits.maxCreditBytes,
        maxFrameBytes: limits.maxFrameBytes,
      },
      recoveredAt,
    );
    this.credentials = new RelayCredentialPolicy(metadata, instanceId);
    this.terminal = new RelayTerminalCoordinator({
      instanceId,
      metadata,
      clients: this.clients,
      streams: this.streams,
      clientDisconnects: this.clientDisconnects,
      dropStreamQueues: (streamId) => this.dropStreamQueues(streamId),
      enqueueWorker: (frame) => this.enqueueWorker(frame),
      workerStatus: () => this.lease.status(),
      onWorkerDeliveryFailure: () => this.failActiveWorkerDelivery(),
    });
    fenceRecoveredRelayRoutes(metadata, instanceId, recoveredAt);
  }

  registerClient(
    clientId: string,
    credentialId: string,
    surface: 'desktop-full' | 'feishu-session-console' = 'desktop-full',
  ): void {
    if (clientId.length === 0 || credentialId.length === 0) {
      throw new RelayRouterError('client_unknown', 'clientId and credentialId are required');
    }
    if (!this.credentials.activeClientSurface(credentialId, surface)) {
      throw new RelayRouterError(
        'credential_invalid',
        'Client credential is not active for this Relay instance',
      );
    }
    if (this.clients.has(clientId)) this.disconnectClient(clientId, 'replaced');
    this.clients.set(clientId, {
      clientId,
      credentialId,
      surface,
      queue: createRelayClientQueue(this.limits),
    });
  }

  disconnectClient(clientId: string, reason: RelayClientDisconnect['reason'] = 'resync_required'):
  void {
    this.terminal.disconnectClient(clientId, reason);
  }

  attachWorker(
    request: WorkerAttachRequest,
    connectionId: string,
    now = Date.now(),
  ): WorkerLeaseAttachResult {
    if (!this.credentials.activeWorker(request.credentialId)) {
      return {
        accepted: false,
        rejected: this.credentials.rejectWorker(this.lease.status().generation),
      };
    }
    const previous = this.lease.status();
    const result = this.lease.attach(request, connectionId, now);
    if (!result.accepted) return result;
    if (result.fencedConnectionId !== null) {
      this.workerConnectionsToFence.push(result.fencedConnectionId);
    }
    if (previous.online || previous.generation !== result.attached.generation) {
      this.terminal.failAllStreams(
        request.mode === 'takeover' ? 'worker_fenced' : 'worker_disconnected',
      );
    }
    this.workerQueue.clear();
    this.nextWorkerHeartbeatSequence = 0;
    this.nextRelayHeartbeatSequence = 0;
    return result;
  }

  detachWorker(connectionId: string, now = Date.now()): void {
    const loss = this.lease.disconnect(connectionId, now);
    if (!loss) return;
    this.workerConnectionsToFence.push(connectionId);
    this.terminal.failAllStreams('worker_disconnected');
    this.workerQueue.clear();
  }

  tick(now = Date.now()): void {
    const loss = this.lease.expire(now);
    if (!loss) return;
    this.workerConnectionsToFence.push(loss.connectionId);
    this.terminal.failAllStreams('heartbeat_timeout');
    this.workerQueue.clear();
  }

  routeFromClient(clientId: string, frame: RelayRouteFrame): RelayRouteResult {
    assertRelayRouterFrame(this.instanceId, this.limits, frame);
    const client = this.clients.get(clientId);
    if (!client) throw new RelayRouterError('client_unknown', 'Client is not registered');
    if (!this.credentials.activeClientSurface(client.credentialId, client.surface)) {
      this.disconnectClient(clientId, 'resync_required');
      return { accepted: false, error: 'resync_required' };
    }
    if (frame.direction !== 'client-to-worker' || frame.kind === 'heartbeat') {
      throw new RelayRouterError('direction_invalid', 'Client frame direction or kind is invalid');
    }
    this.revalidateActiveWorkerCredential(null, Date.now());
    const status = this.lease.status();
    if (!status.online) {
      const delivered = this.terminal.enqueueResetToClient(
        client,
        frame.streamId,
        status.generation,
        0,
        'worker_offline',
      );
      return { accepted: false, error: delivered ? 'worker_offline' : 'resync_required' };
    }
    if (frame.generation !== status.generation) {
      const delivered = this.terminal.enqueueResetToClient(
        client,
        frame.streamId,
        status.generation,
        0,
        'generation_mismatch',
      );
      return {
        accepted: false,
        error: delivered ? 'generation_mismatch' : 'resync_required',
      };
    }
    if (frame.kind === 'open') return this.openStream(clientId, client, frame, status);

    const stream = this.streams.get(frame.streamId);
    if (!stream || stream.clientId !== clientId || stream.generation !== frame.generation) {
      const delivered = this.terminal.enqueueResetToClient(
        client,
        frame.streamId,
        status.generation,
        0,
        'protocol_error',
      );
      return { accepted: false, error: delivered ? 'protocol_error' : 'resync_required' };
    }
    if (
      (stream.clientClosed && frame.kind !== 'credit' && frame.kind !== 'reset') ||
      frame.sequence !== stream.nextClientSequence
    ) {
      const terminalError = this.terminal.failStream(stream, 'protocol_error', true, true);
      return { accepted: false, error: terminalError ?? 'protocol_error' };
    }

    if (frame.kind === 'data') {
      if (frame.payload.byteLength > stream.clientToWorkerCredit) {
        const terminalError = this.terminal.failStream(stream, 'protocol_error', true, true);
        return { accepted: false, error: terminalError ?? 'protocol_error' };
      }
      stream.clientToWorkerCredit -= frame.payload.byteLength;
    } else if (frame.kind === 'credit') {
      if (
        frame.creditBytes === null ||
        stream.workerToClientCredit + frame.creditBytes > this.limits.maxCreditBytes
      ) {
        const terminalError = this.terminal.failStream(stream, 'protocol_error', true, true);
        return { accepted: false, error: terminalError ?? 'protocol_error' };
      }
      stream.workerToClientCredit += frame.creditBytes;
    } else if (frame.kind === 'close') {
      stream.clientClosed = true;
    }
    stream.nextClientSequence += 1;

    if (frame.kind === 'reset') {
      this.dropStreamQueues(stream.streamId);
      closeRelayRoute(this.metadata, stream.streamId, 'closed');
      this.streams.delete(stream.streamId);
      if (!this.enqueueWorker(frame)) {
        this.failActiveWorkerDelivery();
        return { accepted: false, error: 'worker_disconnected' };
      }
      return { accepted: true, error: null };
    }
    if (!this.enqueueWorker(frame)) {
      const terminalError = this.terminal.failStream(stream, 'backpressure', true, true);
      return { accepted: false, error: terminalError ?? 'backpressure' };
    }
    return { accepted: true, error: null };
  }

  private openStream(
    clientId: string,
    client: RelayClientState,
    frame: RelayRouteFrame,
    status: WorkerLeaseStatus,
  ): RelayRouteResult {
    if (frame.accessCredentialId !== null || frame.accessSurface !== null) {
      const delivered = this.terminal.enqueueResetToClient(
        client,
        frame.streamId,
        status.generation,
        0,
        'protocol_error',
      );
      return { accepted: false, error: delivered ? 'protocol_error' : 'resync_required' };
    }
    if (this.streams.has(frame.streamId)) {
      const delivered = this.terminal.enqueueResetToClient(
        client,
        frame.streamId,
        status.generation,
        0,
        'protocol_error',
      );
      return { accepted: false, error: delivered ? 'protocol_error' : 'resync_required' };
    }
    const stream: RelayStreamState = {
      streamId: frame.streamId,
      clientId,
      generation: frame.generation,
      nextClientSequence: 1,
      nextWorkerSequence: 0,
      clientToWorkerCredit: this.limits.initialCreditBytes,
      workerToClientCredit: this.limits.initialCreditBytes,
      clientClosed: false,
      workerClosed: false,
    };
    this.streams.set(frame.streamId, stream);
    recordOpenRelayRoute(this.metadata, {
      instanceId: this.instanceId,
      streamId: frame.streamId,
      accessCredentialId: client.credentialId,
      accessSurface: client.surface,
      workerId: status.workerId ?? 'offline',
      generation: frame.generation,
      updatedAt: Date.now(),
    });
    const authorizedOpen: RelayRouteFrame = {
      ...frame,
      accessCredentialId: client.credentialId,
      accessSurface: client.surface,
    };
    if (!this.enqueueWorker(authorizedOpen)) {
      const terminalError = this.terminal.failStream(stream, 'backpressure', true, true);
      return { accepted: false, error: terminalError ?? 'backpressure' };
    }
    return { accepted: true, error: null };
  }

  routeFromWorker(connectionId: string, frame: RelayRouteFrame, now = Date.now()): RelayRouteResult {
    assertRelayRouterFrame(this.instanceId, this.limits, frame);
    if (
      !this.revalidateActiveWorkerCredential(connectionId, now) ||
      !this.lease.isActiveConnection(connectionId, frame.generation)
    ) {
      throw new RelayRouterError('worker_fenced', 'Worker connection or generation is fenced');
    }
    if (frame.direction !== 'worker-to-client') {
      throw new RelayRouterError('direction_invalid', 'Worker frame direction is invalid');
    }
    if (frame.kind === 'heartbeat') return this.acceptHeartbeat(connectionId, frame, now);
    if (frame.kind === 'open') {
      throw new RelayRouterError('stream_invalid', 'Only clients may open Relay streams');
    }
    const stream = this.streams.get(frame.streamId);
    if (!stream || stream.generation !== frame.generation) {
      throw new RelayRouterError('stream_invalid', 'Worker frame references an inactive stream');
    }
    if (stream.workerClosed || frame.sequence !== stream.nextWorkerSequence) {
      const terminalError = this.terminal.failStream(stream, 'protocol_error', true, true);
      return { accepted: false, error: terminalError ?? 'protocol_error' };
    }
    const client = this.clients.get(stream.clientId);
    if (!client) {
      this.terminal.failStream(stream, 'cancelled', false, true);
      return { accepted: false, error: 'cancelled' };
    }
    if (!this.credentials.activeClientSurface(client.credentialId, client.surface)) {
      this.disconnectClient(stream.clientId, 'resync_required');
      return { accepted: false, error: 'resync_required' };
    }

    if (frame.kind === 'data') {
      if (frame.payload.byteLength > stream.workerToClientCredit) {
        const terminalError = this.terminal.failStream(stream, 'protocol_error', true, true);
        return { accepted: false, error: terminalError ?? 'protocol_error' };
      }
      stream.workerToClientCredit -= frame.payload.byteLength;
    } else if (frame.kind === 'credit') {
      if (
        frame.creditBytes === null ||
        stream.clientToWorkerCredit + frame.creditBytes > this.limits.maxCreditBytes
      ) {
        const terminalError = this.terminal.failStream(stream, 'protocol_error', true, true);
        return { accepted: false, error: terminalError ?? 'protocol_error' };
      }
      stream.clientToWorkerCredit += frame.creditBytes;
    } else if (frame.kind === 'close') {
      stream.workerClosed = true;
    }
    stream.nextWorkerSequence += 1;

    if (frame.kind === 'reset') {
      this.dropStreamQueues(stream.streamId);
      closeRelayRoute(this.metadata, stream.streamId, 'closed');
      this.streams.delete(stream.streamId);
      if (!client.queue.enqueue(frame)) {
        this.disconnectClient(stream.clientId, 'resync_required');
        return { accepted: false, error: 'resync_required' };
      }
      return { accepted: true, error: null };
    }
    if (!client.queue.enqueue(frame)) {
      this.disconnectClient(stream.clientId, 'resync_required');
      return { accepted: false, error: 'resync_required' };
    }
    if (stream.workerClosed) {
      // Worker close is terminal for the Core channel. Preserve already queued Worker output and
      // its ordered close frame, but discard client input that the closed channel cannot consume.
      this.workerQueue.dropStream(stream.streamId);
      closeRelayRoute(this.metadata, stream.streamId, 'closed');
      this.streams.delete(stream.streamId);
    }
    return { accepted: true, error: null };
  }

  private acceptHeartbeat(
    connectionId: string,
    frame: RelayRouteFrame,
    now: number,
  ): RelayRouteResult {
    if (
      frame.streamId !== RELAY_CONTROL_STREAM_ID ||
      frame.sequence !== this.nextWorkerHeartbeatSequence ||
      !this.lease.heartbeat(connectionId, frame.generation, now)
    ) {
      throw new RelayRouterError('sequence_invalid', 'Worker heartbeat sequence is invalid');
    }
    this.nextWorkerHeartbeatSequence += 1;
    const acknowledgement: RelayRouteFrame = {
      ...frame,
      direction: 'client-to-worker',
      sequence: this.nextRelayHeartbeatSequence,
    };
    this.nextRelayHeartbeatSequence += 1;
    if (!this.enqueueWorker(acknowledgement)) {
      this.failActiveWorkerDelivery();
      return { accepted: false, error: 'worker_disconnected' };
    }
    return { accepted: true, error: null };
  }

  private enqueueWorker(frame: RelayRouteFrame): boolean { return this.workerQueue.enqueue(frame); }

  private dropStreamQueues(streamId: string): void {
    this.workerQueue.dropStream(streamId);
    for (const client of this.clients.values()) client.queue.dropStream(streamId);
  }

  private failActiveWorkerDelivery(): void {
    const status = this.lease.status();
    if (status.online && status.connectionId !== null) {
      this.detachWorker(status.connectionId);
    } else {
      this.workerQueue.clear();
    }
  }

  private revalidateActiveWorkerCredential(
    connectionId: string | null,
    now: number,
  ): boolean {
    const status = this.lease.status();
    if (!this.credentials.targetsWorker(status, connectionId)) return false;
    if (this.credentials.activeWorker(status.credentialId)) return true;
    this.detachWorker(status.connectionId, now);
    return false;
  }

  drainWorker(maxBytes = Number.MAX_SAFE_INTEGER): RelayWorkerDelivery | null {
    const status = this.lease.status();
    if (!status.online || status.connectionId === null) return null;
    return this.drainWorkerFor(status.connectionId, maxBytes);
  }

  drainWorkerFor(
    connectionId: string,
    maxBytes = Number.MAX_SAFE_INTEGER,
  ): RelayWorkerDelivery | null {
    if (!this.revalidateActiveWorkerCredential(connectionId, Date.now())) return null;
    this.credentials.disconnectInactiveClients(this.clients.values(), (clientId) =>
      this.disconnectClient(clientId),
    );
    const status = this.lease.status();
    if (status.connectionId !== connectionId) return null;
    const frames = drainWorkerFrames(this.workerQueue, this.limits, maxBytes);
    return { connectionId, frames };
  }

  drainClient(clientId: string, maxBytes = Number.MAX_SAFE_INTEGER): RelayRouteFrame[] {
    const client = this.clients.get(clientId);
    if (!client) return [];
    if (!this.credentials.activeClientSurface(client.credentialId, client.surface)) {
      this.disconnectClient(clientId, 'resync_required');
      return [];
    }
    return client.queue.drain(maxBytes);
  }

  takeWorkerConnectionsToFence(): string[] { return this.workerConnectionsToFence.splice(0); }
  takeClientDisconnects(): RelayClientDisconnect[] { return this.clientDisconnects.splice(0); }
  status(): WorkerLeaseStatus { return this.lease.status(); }

  streamCount(): number { return this.streams.size; }

  queuedBytesForClient(clientId: string): number {
    return this.clients.get(clientId)?.queue.totalBytes ?? 0;
  }

  queuedBytesToWorker(): number { return this.workerQueue.totalBytes; }
}
