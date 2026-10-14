import type { RelayRouteFrame, WorkerAttachRequest } from '@protocol/relay';
import type { RelayMetadataStore } from './metadata';
import { RelayRouterError, RelayStreamRouter, DEFAULT_RELAY_ROUTER_LIMITS, type RelayRouterLimits } from './router';
import type { WorkerLeaseStatus } from './worker-lease';
import { createRuntimeDiagnostics } from '@hosts/linux-runtime/runtime-diagnostics';

type Diagnostics = ReturnType<typeof createRuntimeDiagnostics>;

/** Observe the existing router at lifecycle boundaries; never inspect forwarded payload bytes. */
export class DiagnosticRelayStreamRouter extends RelayStreamRouter {
  private lastTickAt: number | null = null;
  private lastOfflineAt: number | null = null;

  constructor(
    instanceId: string,
    metadata: RelayMetadataStore,
    private readonly diagnostics: Diagnostics = createRuntimeDiagnostics(),
    private readonly tickIntervalMs = 1000,
    limits: RelayRouterLimits = DEFAULT_RELAY_ROUTER_LIMITS,
  ) {
    super(instanceId, metadata, limits);
  }

  override attachWorker(request: WorkerAttachRequest, connectionId: string, now = Date.now()) {
    const result = super.attachWorker(request, connectionId, now);
    if (result.accepted) {
      this.observe('info', 'relay-worker-attached', {
        connectionId, workerId: request.workerId, generation: result.attached.generation,
        resumed: result.resumedGeneration,
        ...(this.lastOfflineAt === null ? {} : { elapsedMs: Math.max(0, now - this.lastOfflineAt) }),
      });
      this.lastOfflineAt = null;
    }
    return result;
  }

  override detachWorker(connectionId: string, now = Date.now()): void {
    const previous = this.status();
    const queuedBytes = this.queuedBytesToWorker();
    super.detachWorker(connectionId, now);
    if (previous.online && !this.status().online) {
      this.lastOfflineAt = now;
      this.observe('warn', 'relay-worker-detached', {
        ...this.leaseDetails(previous, now), queuedBytes, reason: 'disconnect',
      });
    }
  }

  override tick(now = Date.now()): void {
    const previous = this.status();
    const queuedBytes = this.queuedBytesToWorker();
    const timerLagMs = this.lastTickAt === null ? 0 : Math.max(0, now - this.lastTickAt - this.tickIntervalMs);
    this.lastTickAt = now;
    super.tick(now);
    if (previous.online && !this.status().online) {
      this.lastOfflineAt = now;
      this.observe('warn', 'relay-worker-expired', {
        ...this.leaseDetails(previous, now), queuedBytes, timerLagMs, reason: 'heartbeat_timeout',
      });
    }
  }

  override routeFromClient(clientId: string, frame: RelayRouteFrame) {
    return this.route(frame, () => super.routeFromClient(clientId, frame));
  }

  override routeFromWorker(connectionId: string, frame: RelayRouteFrame, now = Date.now()) {
    return this.route(frame, () => super.routeFromWorker(connectionId, frame, now));
  }

  private route(frame: RelayRouteFrame, action: () => ReturnType<RelayStreamRouter['routeFromClient']>) {
    const queuedBytes = this.queuedBytesToWorker();
    try {
      const result = action();
      // Late data after a stream close is expected and does not indicate a broken attachment.
      if (result.error && result.error !== 'cancelled') this.routeFailure(frame, result.error, queuedBytes);
      return result;
    } catch (error) {
      this.routeFailure(frame, error instanceof RelayRouterError ? error.code : 'protocol_error', queuedBytes);
      throw error;
    }
  }

  private routeFailure(frame: RelayRouteFrame, reason: string, queuedBytes: number): void {
    try {
      this.observe('warn', 'relay-stream-failed', {
        streamId: frame.streamId, generation: frame.generation, direction: frame.direction, reason, queuedBytes,
      });
    } catch { /* Even malformed frame access cannot replace the original protocol failure. */ }
  }

  private leaseDetails(status: WorkerLeaseStatus, now: number) {
    return {
      connectionId: status.connectionId, workerId: status.workerId, generation: status.generation,
      lastHeartbeatAgeMs: status.lastHeartbeatAt === null ? 0 : Math.max(0, now - status.lastHeartbeatAt),
      heartbeatTimeoutMs: this.limits.heartbeatTimeoutMs,
    };
  }

  private observe(level: 'info' | 'warn', event: string, details: Record<string, unknown>): void {
    try { this.diagnostics[level](event, details); } catch { /* Observation never owns routing. */ }
  }
}
