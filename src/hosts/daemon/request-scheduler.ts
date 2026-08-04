import {
  AgentDeckClientErrorCode,
  CORE_METHOD_METADATA,
  isCoreMethodAllowed,
  isJsonValue,
  type AuthenticatedClientAccessContext,
  type CoreMethod,
  type JsonValue,
} from '@contracts/index';
import type { ProtocolRequestMessage } from '@protocol/index';

import {
  assertDaemonIdentifier,
  MAX_DAEMON_IDEMPOTENCY_KEY_BYTES,
  MAX_DAEMON_REQUEST_ID_BYTES,
} from './request-identifiers';
import {
  DaemonRequestError,
  type DaemonConnectionLimits,
  type DaemonCoreRuntime,
} from './types';

interface QueuedRequest {
  readonly message: ProtocolRequestMessage;
}

interface ActiveRequest {
  readonly controller: AbortController;
  readonly deadlineAt: number | null;
  deadlineTimer: NodeJS.Timeout | null;
  terminalSent: boolean;
}

/** Node timers cannot represent a longer one-shot delay without firing early. */
export const MAX_DAEMON_TIMER_DELAY_MS = 2_147_483_647;

export interface DaemonRequestSchedulerCallbacks {
  readonly onResult: (requestId: string, result: JsonValue, revision: number) => void;
  readonly onError: (requestId: string, error: DaemonRequestError) => void;
  readonly onOverflow: () => void;
}

export interface DaemonRequestSchedulerOptions {
  readonly access: AuthenticatedClientAccessContext;
  readonly runtime: DaemonCoreRuntime;
  readonly supportedMethods: ReadonlySet<CoreMethod>;
  readonly limits: DaemonConnectionLimits;
  readonly callbacks: DaemonRequestSchedulerCallbacks;
  readonly now: () => number;
}

function assertExecutionResult(result: unknown): asserts result is {
  result: JsonValue;
  revision: number;
} {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('result' in result) ||
    !isJsonValue(result.result) ||
    !('revision' in result) ||
    typeof result.revision !== 'number' ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 0
  ) {
    throw new Error('Core executor returned an invalid result envelope');
  }
}

export class DaemonRequestScheduler {
  private readonly queuedRequests: QueuedRequest[] = [];
  private readonly activeRequests = new Map<string, ActiveRequest>();
  private readonly requestIds = new Set<string>();
  private readonly requestTasks = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly options: DaemonRequestSchedulerOptions) {}

  get inFlightCount(): number {
    return this.activeRequests.size;
  }

  get queuedCount(): number {
    return this.queuedRequests.length;
  }

  enqueue(message: ProtocolRequestMessage): void {
    try {
      this.validate(message);
    } catch (error) {
      this.options.callbacks.onError(message.requestId, this.normalizeError(error));
      return;
    }

    this.requestIds.add(message.requestId);
    if (this.activeRequests.size < this.options.limits.maxConcurrentRequests) {
      this.start(message);
      return;
    }
    if (this.queuedRequests.length >= this.options.limits.maxQueuedRequests) {
      this.options.callbacks.onOverflow();
      return;
    }
    this.queuedRequests.push({ message });
  }

  cancel(targetRequestId: string): void {
    const active = this.activeRequests.get(targetRequestId);
    if (active) {
      this.terminateActive(
        targetRequestId,
        active,
        new DaemonRequestError(
          AgentDeckClientErrorCode.Cancelled,
          'Request was cancelled',
          false,
          null,
          { reason: 'client-cancelled' },
        ),
        'client-cancelled',
      );
      return;
    }
    const queuedIndex = this.queuedRequests.findIndex(
      ({ message }) => message.requestId === targetRequestId,
    );
    if (queuedIndex < 0) return;
    this.queuedRequests.splice(queuedIndex, 1);
    this.requestIds.delete(targetRequestId);
    this.options.callbacks.onError(
      targetRequestId,
      new DaemonRequestError(
        AgentDeckClientErrorCode.Cancelled,
        'Request was cancelled',
        false,
        null,
        { reason: 'client-cancelled' },
      ),
    );
  }

  async close(reason: string): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const active of this.activeRequests.values()) {
        if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
        active.controller.abort(reason);
      }
      this.activeRequests.clear();
      this.queuedRequests.splice(0);
      this.requestIds.clear();
    }
    await Promise.all([...this.requestTasks]);
  }

  private validate(message: ProtocolRequestMessage): void {
    const { access, supportedMethods } = this.options;
    assertDaemonIdentifier(message.requestId, 'requestId', MAX_DAEMON_REQUEST_ID_BYTES);
    if (message.idempotencyKey !== null) {
      assertDaemonIdentifier(
        message.idempotencyKey,
        'idempotencyKey',
        MAX_DAEMON_IDEMPOTENCY_KEY_BYTES,
      );
    }
    if (!isCoreMethodAllowed(access.surface, message.method)) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.AccessDenied,
        `Method is not allowed on ${access.surface}`,
      );
    }
    if (!supportedMethods.has(message.method)) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.CapabilityUnavailable,
        `Core method is not available: ${message.method}`,
      );
    }
    const metadata = CORE_METHOD_METADATA[message.method];
    if (metadata.idempotency === 'required' && message.idempotencyKey === null) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        `${message.method} requires an idempotency key`,
      );
    }
    if (metadata.idempotency === 'forbidden' && message.idempotencyKey !== null) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        `${message.method} does not accept an idempotency key`,
      );
    }
    if (metadata.expectedRevision === 'required' && message.expectedRevision === null) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        `${message.method} requires expectedRevision`,
      );
    }
    if (metadata.expectedRevision === 'none' && message.expectedRevision !== null) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        `${message.method} does not accept expectedRevision`,
      );
    }
    if (this.requestIds.has(message.requestId)) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        `Duplicate live request id: ${message.requestId}`,
      );
    }
    if (message.deadlineAt !== null) {
      const delay = message.deadlineAt - this.options.now();
      if (delay <= 0) {
        throw new DaemonRequestError(
          AgentDeckClientErrorCode.DeadlineExceeded,
          'Request deadline has already elapsed',
        );
      }
    }
  }

  private start(message: ProtocolRequestMessage): void {
    if (this.closed) return;
    let deadlineDelay: number | null = null;
    if (message.deadlineAt !== null) {
      deadlineDelay = message.deadlineAt - this.options.now();
      if (deadlineDelay <= 0) {
        this.requestIds.delete(message.requestId);
        this.options.callbacks.onError(
          message.requestId,
          new DaemonRequestError(
            AgentDeckClientErrorCode.DeadlineExceeded,
            'Request expired while queued',
          ),
        );
        this.drain();
        return;
      }
    }

    const controller = new AbortController();
    const active: ActiveRequest = {
      controller,
      deadlineAt: message.deadlineAt,
      deadlineTimer: null,
      terminalSent: false,
    };
    this.activeRequests.set(message.requestId, active);
    if (!this.armDeadline(message.requestId, active)) {
      this.activeRequests.delete(message.requestId);
      this.requestIds.delete(message.requestId);
      this.drain();
      return;
    }

    const task = this.run(message, controller);
    this.requestTasks.add(task);
    void task.then(
      () => this.requestTasks.delete(task),
      () => this.requestTasks.delete(task),
    );
  }

  private async run(
    message: ProtocolRequestMessage,
    controller: AbortController,
  ): Promise<void> {
    try {
      const result = await this.options.runtime.execute({
        access: this.options.access,
        requestId: message.requestId,
        method: message.method as CoreMethod,
        params: message.params,
        idempotencyKey: message.idempotencyKey,
        expectedRevision: message.expectedRevision,
        deadlineAt: message.deadlineAt,
        signal: controller.signal,
      });
      assertExecutionResult(result);
      const active = this.activeRequests.get(message.requestId);
      if (!this.closed && active && !active.terminalSent) {
        active.terminalSent = true;
        this.options.callbacks.onResult(message.requestId, result.result, result.revision);
      }
    } catch (error: unknown) {
      const active = this.activeRequests.get(message.requestId);
      if (!this.closed && active && !active.terminalSent) {
        active.terminalSent = true;
        this.options.callbacks.onError(
          message.requestId,
          this.normalizeExecutionError(error),
        );
      }
    } finally {
      const active = this.activeRequests.get(message.requestId);
      if (active?.deadlineTimer) clearTimeout(active.deadlineTimer);
      this.activeRequests.delete(message.requestId);
      this.requestIds.delete(message.requestId);
      this.drain();
    }
  }

  private drain(): void {
    while (
      !this.closed &&
      this.activeRequests.size < this.options.limits.maxConcurrentRequests &&
      this.queuedRequests.length > 0
    ) {
      const queued = this.queuedRequests.shift();
      if (queued) this.start(queued.message);
    }
  }

  private armDeadline(requestId: string, active: ActiveRequest): boolean {
    if (active.deadlineAt === null || active.terminalSent || this.closed) return true;
    const remaining = active.deadlineAt - this.options.now();
    if (remaining <= 0) {
      this.terminateActive(
        requestId,
        active,
        new DaemonRequestError(
          AgentDeckClientErrorCode.DeadlineExceeded,
          'Request deadline exceeded',
          false,
          null,
          { reason: 'deadline' },
        ),
        'deadline',
      );
      return false;
    }
    active.deadlineTimer = setTimeout(() => {
      active.deadlineTimer = null;
      if (this.activeRequests.get(requestId) !== active || active.terminalSent || this.closed) {
        return;
      }
      this.armDeadline(requestId, active);
    }, Math.min(remaining, MAX_DAEMON_TIMER_DELAY_MS));
    active.deadlineTimer.unref();
    return true;
  }

  private terminateActive(
    requestId: string,
    active: ActiveRequest,
    error: DaemonRequestError,
    abortReason: string,
  ): boolean {
    if (
      this.closed ||
      active.terminalSent ||
      this.activeRequests.get(requestId) !== active
    ) {
      return false;
    }
    active.terminalSent = true;
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    active.deadlineTimer = null;
    active.controller.abort(abortReason);
    this.options.callbacks.onError(requestId, error);
    return true;
  }

  private normalizeExecutionError(error: unknown): DaemonRequestError {
    if (error instanceof DaemonRequestError) return error;
    return new DaemonRequestError(
      AgentDeckClientErrorCode.InternalError,
      'Core request failed',
    );
  }

  private normalizeError(error: unknown): DaemonRequestError {
    return error instanceof DaemonRequestError
      ? error
      : new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Request rejected');
  }
}
