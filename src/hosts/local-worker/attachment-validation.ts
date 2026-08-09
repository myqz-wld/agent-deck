import type { WorkerAttachRequest, WorkerAttached } from '@protocol/relay';
import type { LocalWorkerSshConfig } from './config';
import {
  DEFAULT_LOCAL_WORKER_BRIDGE_LIMITS,
  type LocalWorkerFrameBridgeLimits,
} from './frame-bridge';

export const MAX_ATTACHMENT_TIMER_MS = 2_147_483_647;

export class WorkerAttachmentProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkerAttachmentProtocolError';
  }
}

export function assertTimerDelay(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_ATTACHMENT_TIMER_MS) {
    throw new RangeError(
      `${field} must be a positive safe integer no greater than ${MAX_ATTACHMENT_TIMER_MS}`,
    );
  }
  return value;
}

export function assertInitialGeneration(value: number | null): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
    throw new RangeError('initialGeneration must be null or a positive safe integer');
  }
  return value;
}

export function buildWorkerAttachRequest(
  ssh: LocalWorkerSshConfig,
  generation: number | null,
  takeoverExpectedGeneration: number | null,
): WorkerAttachRequest {
  if (takeoverExpectedGeneration !== null) {
    return {
      type: 'attach',
      instanceId: ssh.instanceId,
      workerId: ssh.workerId,
      credentialId: ssh.credentialId,
      mode: 'takeover',
      generation: null,
      expectedGeneration: takeoverExpectedGeneration,
    };
  }
  return {
    type: 'attach',
    instanceId: ssh.instanceId,
    workerId: ssh.workerId,
    credentialId: ssh.credentialId,
    mode: generation === null ? 'register' : 'reconnect',
    generation,
    expectedGeneration: null,
  };
}

export function assertAttachedResponse(
  request: WorkerAttachRequest,
  attached: WorkerAttached,
  ssh: LocalWorkerSshConfig,
): void {
  if (attached.instanceId !== ssh.instanceId || attached.workerId !== ssh.workerId) {
    throw new WorkerAttachmentProtocolError(
      'attached_identity_mismatch',
      'Relay attached response identity mismatch',
    );
  }
  if (!Number.isSafeInteger(attached.generation) || attached.generation < 1) {
    throw new WorkerAttachmentProtocolError(
      'attached_generation_mismatch',
      'Relay attached response generation is invalid',
    );
  }
  let expectedGeneration: number;
  if (request.mode === 'register') {
    if (request.generation !== null || request.expectedGeneration !== null) {
      throw new WorkerAttachmentProtocolError(
        'attach_request_invalid',
        'Register request generation fields are invalid',
      );
    }
    expectedGeneration = 1;
  } else if (request.mode === 'reconnect') {
    if (request.generation === null || request.expectedGeneration !== null) {
      throw new WorkerAttachmentProtocolError(
        'attach_request_invalid',
        'Reconnect request generation fields are invalid',
      );
    }
    expectedGeneration = request.generation;
  } else {
    if (
      request.generation !== null ||
      request.expectedGeneration === null ||
      request.expectedGeneration >= Number.MAX_SAFE_INTEGER
    ) {
      throw new WorkerAttachmentProtocolError(
        'attach_request_invalid',
        'Takeover request has no safe successor generation',
      );
    }
    expectedGeneration = request.expectedGeneration + 1;
  }
  if (attached.generation !== expectedGeneration) {
    throw new WorkerAttachmentProtocolError(
      'attached_generation_mismatch',
      `Relay attached generation does not satisfy ${request.mode}`,
    );
  }
  if (
    !Number.isSafeInteger(attached.heartbeatTimeoutMs) ||
    attached.heartbeatTimeoutMs <= 0 ||
    attached.heartbeatTimeoutMs > MAX_ATTACHMENT_TIMER_MS
  ) {
    throw new WorkerAttachmentProtocolError(
      'heartbeat_timeout_invalid',
      'Relay advertised heartbeat timeout is outside the timer boundary',
    );
  }
  for (const field of ['initialCreditBytes', 'maxCreditBytes', 'maxFrameBytes'] as const) {
    if (!Number.isSafeInteger(attached[field]) || attached[field] <= 0) {
      throw new WorkerAttachmentProtocolError(
        'route_limits_invalid',
        `Relay advertised ${field} is invalid`,
      );
    }
  }
  if (attached.initialCreditBytes > attached.maxCreditBytes) {
    throw new WorkerAttachmentProtocolError(
      'route_limits_invalid',
      'Relay advertised initial credit exceeds max credit',
    );
  }
}

export function negotiatedBridgeLimits(
  attached: WorkerAttached,
  configured?: LocalWorkerFrameBridgeLimits,
): LocalWorkerFrameBridgeLimits {
  const base = configured ?? DEFAULT_LOCAL_WORKER_BRIDGE_LIMITS;
  if (
    configured &&
    (configured.initialCreditBytes !== attached.initialCreditBytes ||
      configured.maxCreditBytes !== attached.maxCreditBytes ||
      configured.maxFrameBytes !== attached.maxFrameBytes)
  ) {
    throw new WorkerAttachmentProtocolError(
      'route_limits_mismatch',
      'Configured Worker bridge limits differ from Relay negotiation',
    );
  }
  return {
    ...base,
    initialCreditBytes: attached.initialCreditBytes,
    maxCreditBytes: attached.maxCreditBytes,
    maxFrameBytes: attached.maxFrameBytes,
  };
}
