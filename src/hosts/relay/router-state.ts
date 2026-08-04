import { RelayMetadataStore } from './metadata';
import { BoundedRelayFrameQueue } from './bounded-queue';
import {
  assertRelayRouteFrame,
  emptyRoutePayload,
  type RelayDirection,
  type RelayResetCode,
  type RelayRouteFrame,
} from '@protocol/relay';
import { RelayRouterError, type RelayRouterLimits } from './router-types';

export interface RelayClientState {
  clientId: string;
  credentialId: string;
  queue: {
    clear(): void;
    dropStream(streamId: string): void;
    enqueue(frame: RelayRouteFrame): boolean;
    drain(maxBytes?: number): RelayRouteFrame[];
    readonly totalBytes: number;
  };
}

export interface RelayStreamState {
  streamId: string;
  clientId: string;
  generation: number;
  nextClientSequence: number;
  nextWorkerSequence: number;
  clientToWorkerCredit: number;
  workerToClientCredit: number;
  clientClosed: boolean;
  workerClosed: boolean;
}

export function assertRelayRouterFrame(
  instanceId: string,
  limits: RelayRouterLimits,
  frame: RelayRouteFrame,
): void {
  assertRelayRouteFrame(frame, {
    maxFrameBytes: limits.maxFrameBytes,
    maxCreditBytes: limits.maxCreditBytes,
  });
  if (frame.instanceId !== instanceId) {
    throw new RelayRouterError('instance_invalid', 'Route frame belongs to another instance');
  }
}

export function createRelayClientQueue(limits: RelayRouterLimits): BoundedRelayFrameQueue {
  return new BoundedRelayFrameQueue(
    limits.maxQueueBytesPerStream,
    limits.maxQueueBytesPerClient,
    {
      maxFrameBytes: limits.maxFrameBytes,
      maxCreditBytes: limits.maxCreditBytes,
    },
  );
}

export function createRelayResetFrame(
  instanceId: string,
  stream: Pick<RelayStreamState, 'generation' | 'streamId'>,
  direction: RelayDirection,
  code: RelayResetCode,
  sequence: number,
): RelayRouteFrame {
  return {
    instanceId,
    generation: stream.generation,
    streamId: stream.streamId,
    direction,
    sequence,
    kind: 'reset',
    payload: emptyRoutePayload(),
    creditBytes: null,
    resetCode: code,
  };
}

export function recordOpenRelayRoute(
  metadata: RelayMetadataStore,
  input: {
    instanceId: string;
    streamId: string;
    accessCredentialId: string;
    workerId: string;
    generation: number;
    updatedAt: number;
  },
): void {
  metadata.put('routes', {
    id: input.streamId,
    instanceId: input.instanceId,
    routeId: input.streamId,
    accessCredentialId: input.accessCredentialId,
    workerId: input.workerId,
    generation: input.generation,
    status: 'open',
    updatedAt: input.updatedAt,
  });
}

export function closeRelayRoute(
  metadata: RelayMetadataStore,
  streamId: string,
  status: 'closed' | 'fenced',
  updatedAt = Date.now(),
): void {
  const current = metadata.getById('routes', streamId);
  if (current) metadata.put('routes', { ...current, status, updatedAt });
}

export function fenceRecoveredRelayRoutes(
  metadata: RelayMetadataStore,
  instanceId: string,
  recoveredAt: number,
): void {
  for (const route of metadata.rows('routes')) {
    if (route.instanceId === instanceId && route.status === 'open') {
      metadata.put('routes', { ...route, status: 'fenced', updatedAt: recoveredAt });
    }
  }
}
