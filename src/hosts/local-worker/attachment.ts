import {
  emptyRoutePayload,
  RELAY_CONTROL_STREAM_ID,
  type RelayRouteFrame,
} from '@protocol/relay';
import {
  assertAttachedResponse,
  assertInitialGeneration,
  assertTimerDelay,
  buildWorkerAttachRequest,
  MAX_ATTACHMENT_TIMER_MS,
  negotiatedBridgeLimits,
  WorkerAttachmentProtocolError,
} from './attachment-validation';
import {
  DEFAULT_ATTACHMENT_SCHEDULER,
  WorkerAttachmentConnectError,
  WorkerAttachmentRetirementError,
  type AttachmentScheduler,
  type WorkerAttachmentConnector,
  type WorkerAttachmentOptions,
  type WorkerAttachmentSession,
  type WorkerAttachmentStatus,
} from './attachment-types';
import type { LocalWorkerSshConfig } from './config';
import { LocalWorkerFrameBridge, type CoreFrameChannelFactory } from './frame-bridge';
export * from './attachment-types';

function errorValue(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export class WorkerAttachmentController {
  private readonly scheduler: AttachmentScheduler;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly heartbeatIntervalMs: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaximumMs: number;
  private readonly backoffJitterRatio: number;
  private readonly onStatus?: (status: WorkerAttachmentStatus) => void;
  private readonly onGeneration?: (generation: number) => void;
  private readonly retirements = new WeakMap<WorkerAttachmentSession, Promise<void>>();
  private readonly lostSessions = new WeakSet<WorkerAttachmentSession>();
  private lifecycle: Promise<void> = Promise.resolve();
  private terminalRetirementError: WorkerAttachmentRetirementError | null = null;
  private desired = false;
  private epoch = 0;
  private timer: unknown = null;
  private session: WorkerAttachmentSession | null = null;
  private bridge: LocalWorkerFrameBridge | null = null;
  private takeoverExpectedGeneration: number | null = null;
  private nextHeartbeatSequence = 0;
  private nextRelayHeartbeatSequence = 0;
  private statusValue: WorkerAttachmentStatus;

  constructor(
    readonly ssh: LocalWorkerSshConfig,
    private readonly connector: WorkerAttachmentConnector,
    private readonly channels: CoreFrameChannelFactory,
    private readonly options: WorkerAttachmentOptions = {},
  ) {
    this.scheduler = options.scheduler ?? DEFAULT_ATTACHMENT_SCHEDULER;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.heartbeatIntervalMs = assertTimerDelay(
      options.heartbeatIntervalMs ?? 10_000,
      'heartbeatIntervalMs',
    );
    this.backoffInitialMs = assertTimerDelay(
      options.backoffInitialMs ?? 1_000,
      'backoffInitialMs',
    );
    this.backoffMaximumMs = assertTimerDelay(
      options.backoffMaximumMs ?? 60_000,
      'backoffMaximumMs',
    );
    this.backoffJitterRatio = options.backoffJitterRatio ?? 0.2;
    this.onStatus = options.onStatus;
    this.onGeneration = options.onGeneration;
    if (this.backoffInitialMs > this.backoffMaximumMs) {
      throw new RangeError('backoffInitialMs cannot exceed backoffMaximumMs');
    }
    if (
      !Number.isFinite(this.backoffJitterRatio) ||
      this.backoffJitterRatio < 0 ||
      this.backoffJitterRatio > 1
    ) {
      throw new RangeError('backoffJitterRatio must be between zero and one');
    }
    this.statusValue = {
      state: 'stopped',
      generation: assertInitialGeneration(options.initialGeneration ?? null),
      attempt: 0,
      nextRetryAt: null,
      lastHeartbeatAckAt: null,
      lastErrorCode: null,
    };
  }

  status(): WorkerAttachmentStatus {
    return { ...this.statusValue };
  }

  private transition(
    patch: Partial<WorkerAttachmentStatus>,
    failOnObserverError = false,
  ): void {
    this.statusValue = { ...this.statusValue, ...patch };
    try {
      this.onStatus?.(this.status());
    } catch (error) {
      if (failOnObserverError) throw error;
    }
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(operation, operation);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  start(): Promise<void> {
    if (this.desired) return this.lifecycle;
    if (this.terminalRetirementError) return Promise.reject(this.terminalRetirementError);
    this.desired = true;
    this.epoch += 1;
    const epoch = this.epoch;
    return this.serialize(() => this.connectNow(epoch));
  }

  stop(): Promise<void> {
    this.desired = false;
    this.epoch += 1;
    this.clearTimer();
    return this.serialize(async () => {
      const session = this.session;
      if (session) await this.cleanupSession(session);
      if (this.terminalRetirementError) throw this.terminalRetirementError;
      this.transition({
        state: 'stopped',
        attempt: 0,
        nextRetryAt: null,
        lastHeartbeatAckAt: null,
        lastErrorCode: null,
      });
    });
  }

  requestTakeover(expectedGeneration: number): Promise<void> {
    if (
      !Number.isSafeInteger(expectedGeneration) ||
      expectedGeneration < 0 ||
      expectedGeneration >= Number.MAX_SAFE_INTEGER
    ) {
      return Promise.reject(
        new RangeError('expectedGeneration must have a safe successor generation'),
      );
    }
    if (this.terminalRetirementError) return Promise.reject(this.terminalRetirementError);
    this.takeoverExpectedGeneration = expectedGeneration;
    this.desired = true;
    this.epoch += 1;
    const epoch = this.epoch;
    this.clearTimer();
    return this.serialize(async () => {
      if (!this.desired || epoch !== this.epoch) return;
      const session = this.session;
      if (session) await this.cleanupSession(session, 'worker_fenced');
      if (!this.desired || epoch !== this.epoch) return;
      await this.connectNow(epoch);
    });
  }

  private async connectNow(epoch: number): Promise<void> {
    if (!this.desired || epoch !== this.epoch || this.terminalRetirementError) return;
    this.transition({ state: 'connecting', nextRetryAt: null, lastErrorCode: null });
    if (!this.desired || epoch !== this.epoch) return;
    const request = buildWorkerAttachRequest(
      this.ssh,
      this.statusValue.generation,
      this.takeoverExpectedGeneration,
    );
    let resolvedSession: WorkerAttachmentSession | null = null;
    try {
      const session = await this.connector.connect(this.ssh, request);
      resolvedSession = session;
      if (!this.desired || epoch !== this.epoch) {
        await this.cleanupSession(session);
        return;
      }
      assertAttachedResponse(request, session.attached, this.ssh);
      this.statusValue = { ...this.statusValue, generation: session.attached.generation };
      this.takeoverExpectedGeneration = null;
      const bridgeLimits = negotiatedBridgeLimits(session.attached, this.options.bridgeLimits);
      const bridge = new LocalWorkerFrameBridge(
        this.ssh.instanceId,
        session.attached.generation,
        this.channels,
        (frame) => this.sendBridgeFrame(session, epoch, frame),
        bridgeLimits,
      );
      await this.onGeneration?.(session.attached.generation);
      if (!this.desired || epoch !== this.epoch) {
        await this.cleanupSession(session);
        return;
      }
      this.session = session;
      this.bridge = bridge;
      this.nextHeartbeatSequence = 0;
      this.nextRelayHeartbeatSequence = 0;
      session.setHandlers({
        onFrame: (frame) => this.onFrame(session, epoch, frame),
        onClose: (error) => this.queueConnectionLost(session, epoch, error),
      });
      if (
        this.session !== session ||
        this.lostSessions.has(session) ||
        !this.desired ||
        epoch !== this.epoch
      ) {
        return;
      }
      const now = this.now();
      this.transition(
        {
          state: 'online',
          generation: session.attached.generation,
          attempt: 0,
          nextRetryAt: null,
          lastHeartbeatAckAt: now,
          lastErrorCode: null,
        },
        true,
      );
      if (this.session !== session || !this.desired || epoch !== this.epoch) return;
      this.scheduleHeartbeat(session, epoch);
    } catch (error) {
      const failure = errorValue(error, 'Worker attachment failed');
      const lossAlreadyQueued = resolvedSession !== null && this.lostSessions.has(resolvedSession);
      if (resolvedSession) {
        try {
          await this.cleanupSession(resolvedSession);
        } catch (cleanupError) {
          throw new WorkerAttachmentRetirementError(failure, cleanupError);
        }
      }
      if (lossAlreadyQueued || !this.desired || epoch !== this.epoch) return;
      if (failure instanceof WorkerAttachmentRetirementError) {
        this.recordRetirementFailure(failure);
        throw failure;
      }
      if (failure instanceof WorkerAttachmentProtocolError) {
        this.transition({
          state: 'fenced',
          nextRetryAt: null,
          lastHeartbeatAckAt: null,
          lastErrorCode: failure.code,
        });
        return;
      }
      if (failure instanceof WorkerAttachmentConnectError && !failure.rejection.retryable) {
        this.transition({
          state: 'fenced',
          nextRetryAt: null,
          lastErrorCode: failure.rejection.code,
        });
        return;
      }
      this.scheduleBackoff(epoch, failure.name);
    }
  }

  private sendBridgeFrame(
    session: WorkerAttachmentSession,
    epoch: number,
    frame: RelayRouteFrame,
  ): void {
    if (this.session !== session || epoch !== this.epoch) return;
    try {
      session.send(frame);
    } catch (error) {
      this.queueConnectionLost(session, epoch, errorValue(error, 'Worker send failed'));
    }
  }

  private onFrame(
    session: WorkerAttachmentSession,
    epoch: number,
    frame: RelayRouteFrame,
  ): void {
    if (this.session !== session || epoch !== this.epoch) return;
    if (frame.kind === 'heartbeat') {
      if (
        frame.instanceId !== this.ssh.instanceId ||
        frame.generation !== session.attached.generation ||
        frame.direction !== 'client-to-worker' ||
        frame.streamId !== RELAY_CONTROL_STREAM_ID ||
        frame.sequence !== this.nextRelayHeartbeatSequence
      ) {
        this.queueConnectionLost(
          session,
          epoch,
          new Error('Relay heartbeat acknowledgement invalid'),
        );
        return;
      }
      this.nextRelayHeartbeatSequence += 1;
      this.transition({ lastHeartbeatAckAt: this.now() });
      return;
    }
    try {
      this.bridge?.accept(frame);
    } catch (error) {
      this.queueConnectionLost(session, epoch, errorValue(error, 'Worker bridge rejected frame'));
    }
  }

  private scheduleHeartbeat(session: WorkerAttachmentSession, epoch: number): void {
    this.clearTimer();
    const heartbeatDelay = Math.min(
      this.heartbeatIntervalMs,
      Math.max(1, Math.floor(session.attached.heartbeatTimeoutMs / 2)),
    );
    this.timer = this.scheduler.set(heartbeatDelay, () => {
      this.timer = null;
      if (
        this.session !== session ||
        this.lostSessions.has(session) ||
        epoch !== this.epoch ||
        !this.desired
      ) {
        return;
      }
      const lastAck = this.statusValue.lastHeartbeatAckAt;
      if (lastAck === null || this.now() - lastAck > session.attached.heartbeatTimeoutMs) {
        this.queueConnectionLost(session, epoch, new Error('Worker heartbeat timed out'));
        return;
      }
      try {
        session.send({
          instanceId: this.ssh.instanceId,
          generation: session.attached.generation,
          streamId: RELAY_CONTROL_STREAM_ID,
          direction: 'worker-to-client',
          sequence: this.nextHeartbeatSequence,
          kind: 'heartbeat',
          payload: emptyRoutePayload(),
          creditBytes: null,
          resetCode: null,
          connectionScope: null,
          accessSurface: null,
          accessGrant: null,
        });
        this.nextHeartbeatSequence += 1;
        this.scheduleHeartbeat(session, epoch);
      } catch (error) {
        this.queueConnectionLost(session, epoch, errorValue(error, 'Heartbeat send failed'));
      }
    });
  }

  private queueConnectionLost(
    session: WorkerAttachmentSession,
    epoch: number,
    error = new Error('Worker attachment closed'),
  ): void {
    if (
      this.session !== session ||
      epoch !== this.epoch ||
      this.lostSessions.has(session)
    ) {
      return;
    }
    this.lostSessions.add(session);
    this.clearTimer();
    this.transition({
      state: 'connecting',
      nextRetryAt: null,
      lastHeartbeatAckAt: null,
      lastErrorCode: error.name,
    });
    void this.serialize(async () => {
      try {
        await this.cleanupSession(session);
      } catch {
        return;
      }
      if (this.desired && epoch === this.epoch) this.scheduleBackoff(epoch, error.name);
    });
  }

  private async cleanupSession(
    session: WorkerAttachmentSession,
    code: RelayRouteFrame['resetCode'] = 'worker_disconnected',
  ): Promise<void> {
    let disposeError: Error | null = null;
    if (this.session === session) {
      this.session = null;
      this.clearTimer();
      try {
        this.bridge?.dispose(code ?? 'worker_disconnected');
      } catch (error) {
        disposeError = errorValue(error, 'Worker bridge disposal failed');
      }
      this.bridge = null;
    }
    let retirement = this.retirements.get(session);
    if (!retirement) {
      retirement = Promise.resolve().then(() => session.close());
      this.retirements.set(session, retirement);
    }
    try {
      await retirement;
    } catch (error) {
      const failure = new WorkerAttachmentRetirementError(
        disposeError ?? new Error('Worker session close failed'),
        error,
      );
      this.recordRetirementFailure(failure);
      throw failure;
    }
    if (disposeError) {
      const failure = new WorkerAttachmentRetirementError(
        disposeError,
        new Error('Worker child retired after bridge disposal failure'),
      );
      this.recordRetirementFailure(failure);
      throw failure;
    }
  }

  private recordRetirementFailure(error: WorkerAttachmentRetirementError): void {
    this.terminalRetirementError ??= error;
    this.desired = false;
    this.epoch += 1;
    this.clearTimer();
    this.transition({
      state: 'fenced',
      nextRetryAt: null,
      lastHeartbeatAckAt: null,
      lastErrorCode: 'retirement_failed',
    });
  }

  private scheduleBackoff(epoch: number, errorCode: string): void {
    if (!this.desired || epoch !== this.epoch) return;
    const attempt = this.statusValue.attempt + 1;
    const base = Math.min(
      this.backoffMaximumMs,
      this.backoffInitialMs * 2 ** Math.min(attempt - 1, 30),
    );
    const random = this.random();
    if (!Number.isFinite(random) || random < 0 || random > 1) {
      this.transition({ state: 'fenced', nextRetryAt: null, lastErrorCode: 'random_invalid' });
      return;
    }
    const jitter = Math.floor(base * this.backoffJitterRatio * random);
    const delay = Math.min(this.backoffMaximumMs, base + jitter);
    if (delay > MAX_ATTACHMENT_TIMER_MS) {
      this.transition({ state: 'fenced', nextRetryAt: null, lastErrorCode: 'timer_invalid' });
      return;
    }
    this.transition({
      state: 'backoff',
      attempt,
      nextRetryAt: this.now() + delay,
      lastHeartbeatAckAt: null,
      lastErrorCode: errorCode,
    });
    if (!this.desired || epoch !== this.epoch) return;
    this.clearTimer();
    try {
      this.timer = this.scheduler.set(delay, () => {
        this.timer = null;
        void this.serialize(() => this.connectNow(epoch)).catch((error) => {
          if (error instanceof WorkerAttachmentRetirementError) {
            this.recordRetirementFailure(error);
          }
        });
      });
    } catch {
      this.timer = null;
      this.transition({ state: 'fenced', nextRetryAt: null, lastErrorCode: 'scheduler_failed' });
    }
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    const handle = this.timer;
    this.timer = null;
    try {
      this.scheduler.clear(handle);
    } catch {
      // Epoch/session guards make an uncleared callback stale; retirement must still proceed.
    }
  }
}
