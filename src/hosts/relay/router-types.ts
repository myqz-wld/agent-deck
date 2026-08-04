import type { RelayResetCode, RelayRouteFrame } from '@protocol/relay';

export interface RelayRouterLimits {
  maxFrameBytes: number;
  initialCreditBytes: number;
  maxCreditBytes: number;
  maxQueueBytesPerStream: number;
  maxQueueBytesPerClient: number;
  maxQueueBytesToWorker: number;
  heartbeatTimeoutMs: number;
}

export const DEFAULT_RELAY_ROUTER_LIMITS: RelayRouterLimits = {
  maxFrameBytes: 4 * 1024 * 1024,
  initialCreditBytes: 256 * 1024,
  maxCreditBytes: 1024 * 1024,
  maxQueueBytesPerStream: 512 * 1024,
  maxQueueBytesPerClient: 2 * 1024 * 1024,
  maxQueueBytesToWorker: 4 * 1024 * 1024,
  heartbeatTimeoutMs: 30_000,
};

export interface RelayClientDisconnect {
  clientId: string;
  reason: 'replaced' | 'resync_required';
}

export interface RelayWorkerDelivery {
  connectionId: string;
  frames: RelayRouteFrame[];
}

export interface RelayRouteResult {
  accepted: boolean;
  error: RelayResetCode | null;
}

export class RelayRouterError extends Error {
  constructor(
    readonly code:
      | 'client_unknown'
      | 'credential_invalid'
      | 'direction_invalid'
      | 'generation_invalid'
      | 'instance_invalid'
      | 'sequence_invalid'
      | 'stream_invalid'
      | 'worker_fenced',
    message: string,
  ) {
    super(message);
    this.name = 'RelayRouterError';
  }
}

export function assertRelayRouterLimits(limits: RelayRouterLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (limits.initialCreditBytes > limits.maxCreditBytes) {
    throw new RangeError('initialCreditBytes cannot exceed maxCreditBytes');
  }
  if (limits.maxQueueBytesPerStream > limits.maxQueueBytesPerClient) {
    throw new RangeError('Per-stream queue limit cannot exceed the per-client limit');
  }
  if (limits.maxQueueBytesPerStream > limits.maxQueueBytesToWorker) {
    throw new RangeError('Per-stream queue limit cannot exceed the Worker queue limit');
  }
}
