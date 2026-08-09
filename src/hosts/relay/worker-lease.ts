import type {
  WorkerAttachRejected,
  WorkerAttachRequest,
  WorkerAttached,
  WorkerNegotiatedRouteLimits,
} from '@protocol/relay';
import {
  RelayMetadataError,
  RelayMetadataStore,
  type WorkerRegistrationMetadata,
} from './metadata';

export interface WorkerLeaseStatus {
  instanceId: string;
  workerId: string | null;
  credentialId: string | null;
  generation: number;
  online: boolean;
  connectionId: string | null;
  lastHeartbeatAt: number | null;
}

export interface WorkerLeaseAccepted {
  accepted: true;
  attached: WorkerAttached;
  fencedConnectionId: string | null;
  resumedGeneration: boolean;
}

export interface WorkerLeaseRejected {
  accepted: false;
  rejected: WorkerAttachRejected;
}

export type WorkerLeaseAttachResult = WorkerLeaseAccepted | WorkerLeaseRejected;

export interface WorkerLeaseLoss {
  connectionId: string;
  generation: number;
  reason: 'disconnect' | 'heartbeat_timeout' | 'relay_restart';
}

export class WorkerLeaseRegistry {
  private activeConnectionId: string | null = null;
  private lastHeartbeatAt: number | null = null;

  constructor(
    readonly instanceId: string,
    private readonly metadata: RelayMetadataStore,
    readonly heartbeatTimeoutMs: number,
    private readonly routeLimits: WorkerNegotiatedRouteLimits,
    recoveredAt = Date.now(),
  ) {
    if (!Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs <= 0) {
      throw new RangeError('heartbeatTimeoutMs must be a positive safe integer');
    }
    const recovered = this.registration();
    if (recovered?.status === 'online') {
      // A process-local connection cannot survive Relay restart. Preserve the timestamp of the
      // last real Worker observation while failing the recovered lease closed.
      this.persist({ ...recovered, status: 'offline' });
    }
    void recoveredAt;
  }

  private registration(): WorkerRegistrationMetadata | null {
    const registration = this.metadata.getById('workerRegistrations', this.instanceId);
    if (registration !== null && registration.instanceId !== this.instanceId) {
      throw new RelayMetadataError(
        'Worker registration instanceId does not match its registry instance',
      );
    }
    return registration;
  }

  private persist(record: WorkerRegistrationMetadata): void {
    this.metadata.put('workerRegistrations', record);
  }

  private reject(
    code: WorkerAttachRejected['code'],
    message: string,
    retryable: boolean,
  ): WorkerLeaseRejected {
    return {
      accepted: false,
      rejected: {
        type: 'rejected',
        code,
        message,
        retryable,
        currentGeneration: this.registration()?.generation ?? null,
      },
    };
  }

  attach(request: WorkerAttachRequest, connectionId: string, now: number): WorkerLeaseAttachResult {
    if (request.instanceId !== this.instanceId) {
      return this.reject('invalid_attach', 'Worker attached to the wrong instance', false);
    }
    if (connectionId.length === 0) {
      return this.reject('invalid_attach', 'connectionId is required', false);
    }
    const current = this.registration();
    let next: WorkerRegistrationMetadata;
    let resumedGeneration = false;

    if (request.mode === 'register') {
      if (request.generation !== null || request.expectedGeneration !== null) {
        return this.reject('invalid_attach', 'Register generation fields must be null', false);
      }
      if (current !== null) {
        return this.reject(
          'worker_already_registered',
          'A Worker is already registered; use reconnect or explicit takeover',
          false,
        );
      }
      next = {
        id: this.instanceId,
        instanceId: this.instanceId,
        workerId: request.workerId,
        credentialId: request.credentialId,
        generation: 1,
        status: 'online',
        registeredAt: now,
        lastSeenAt: now,
      };
    } else if (request.mode === 'reconnect') {
      if (request.generation === null || request.expectedGeneration !== null) {
        return this.reject('invalid_attach', 'Reconnect generation fields are invalid', false);
      }
      if (current === null) {
        return this.reject('worker_not_registered', 'No Worker registration exists', false);
      }
      if (
        current.workerId !== request.workerId ||
        current.credentialId !== request.credentialId
      ) {
        return this.reject(
          'credential_mismatch',
          'Reconnect identity does not match the registered Worker',
          false,
        );
      }
      if (request.generation !== current.generation) {
        return this.reject('generation_conflict', 'Reconnect generation is stale', false);
      }
      next = { ...current, status: 'online', lastSeenAt: now };
      resumedGeneration = true;
    } else {
      const expected = current?.generation ?? 0;
      if (
        request.generation !== null ||
        request.expectedGeneration === null ||
        request.expectedGeneration >= Number.MAX_SAFE_INTEGER
      ) {
        return this.reject('invalid_attach', 'Takeover generation fields are invalid', false);
      }
      if (request.expectedGeneration !== expected) {
        return this.reject(
          'generation_conflict',
          'Takeover lost the generation compare-and-set race',
          false,
        );
      }
      next = {
        id: this.instanceId,
        instanceId: this.instanceId,
        workerId: request.workerId,
        credentialId: request.credentialId,
        generation: expected + 1,
        status: 'online',
        registeredAt: now,
        lastSeenAt: now,
      };
    }

    const fencedConnectionId =
      this.activeConnectionId !== null && this.activeConnectionId !== connectionId
        ? this.activeConnectionId
        : null;
    this.persist(next);
    this.activeConnectionId = connectionId;
    this.lastHeartbeatAt = now;
    return {
      accepted: true,
      attached: {
        type: 'attached',
        instanceId: this.instanceId,
        workerId: next.workerId,
        generation: next.generation,
        heartbeatTimeoutMs: this.heartbeatTimeoutMs,
        ...this.routeLimits,
      },
      fencedConnectionId,
      resumedGeneration,
    };
  }

  heartbeat(connectionId: string, generation: number, now: number): boolean {
    const current = this.registration();
    if (
      current === null ||
      this.activeConnectionId !== connectionId ||
      current.generation !== generation ||
      current.status !== 'online'
    ) {
      return false;
    }
    this.lastHeartbeatAt = now;
    this.persist({ ...current, lastSeenAt: now });
    return true;
  }

  disconnect(connectionId: string, now: number): WorkerLeaseLoss | null {
    if (this.activeConnectionId !== connectionId) return null;
    const current = this.registration();
    this.activeConnectionId = null;
    this.lastHeartbeatAt = null;
    if (current === null) return null;
    this.persist({ ...current, status: 'offline', lastSeenAt: now });
    return { connectionId, generation: current.generation, reason: 'disconnect' };
  }

  expire(now: number): WorkerLeaseLoss | null {
    if (
      this.activeConnectionId === null ||
      this.lastHeartbeatAt === null ||
      now - this.lastHeartbeatAt <= this.heartbeatTimeoutMs
    ) {
      return null;
    }
    const connectionId = this.activeConnectionId;
    const current = this.registration();
    this.activeConnectionId = null;
    this.lastHeartbeatAt = null;
    if (current === null) return null;
    this.persist({ ...current, status: 'offline', lastSeenAt: now });
    return {
      connectionId,
      generation: current.generation,
      reason: 'heartbeat_timeout',
    };
  }

  isActiveConnection(connectionId: string, generation: number): boolean {
    const current = this.registration();
    return (
      current !== null &&
      current.status === 'online' &&
      current.generation === generation &&
      this.activeConnectionId === connectionId
    );
  }

  status(): WorkerLeaseStatus {
    const current = this.registration();
    return {
      instanceId: this.instanceId,
      workerId: current?.workerId ?? null,
      credentialId: current?.credentialId ?? null,
      generation: current?.generation ?? 0,
      online: current?.status === 'online' && this.activeConnectionId !== null,
      connectionId: this.activeConnectionId,
      lastHeartbeatAt: this.lastHeartbeatAt,
    };
  }
}
