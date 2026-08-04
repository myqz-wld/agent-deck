import type { Duplex } from 'node:stream';

import {
  AgentDeckClientErrorCode,
  DeploymentTopology,
  isCoreMethod,
  type AuthenticatedClientAccessContext,
  type CoreMethod,
  type JsonValue,
} from '@contracts/index';
import {
  assertHostHello,
  assertProtocolMessageEnvelope,
  LengthPrefixedJsonDecoder,
  negotiateProtocolVersion,
  ProtocolCompatibilityError,
  type HostProtocolMessage,
  type ProtocolErrorMessage,
  type ProtocolMessage,
} from '@protocol/index';

import {
  createDaemonHostHello,
  normalizeDaemonAccessContext,
} from './connection-handshake';
import { normalizeDaemonConnectionLimits } from './connection-limits';
import { BoundedFrameWriter } from './frame-writer';
import { assertDaemonMessageIdentifiers } from './request-identifiers';
import { DaemonRequestScheduler } from './request-scheduler';
import {
  DaemonRequestError,
  type DaemonConnectionAdmission,
  type DaemonConnectionLimits,
  type DaemonCoreRuntime,
  type DaemonEventSubscription,
} from './types';

export interface DaemonProtocolConnectionOptions {
  readonly instanceId: string;
  readonly appVersion: string;
  readonly authoritativeCoreId: string;
  readonly runtime: DaemonCoreRuntime;
  readonly admission: DaemonConnectionAdmission;
  readonly limits?: Partial<DaemonConnectionLimits>;
  readonly now?: () => number;
  readonly onClose?: (connection: DaemonProtocolConnection) => void;
}

export type DaemonProtocolConnectionState = 'open' | 'terminal-flushing' | 'closing' | 'closed';

function requestErrorMessage(
  requestId: string,
  error: DaemonRequestError,
): ProtocolErrorMessage {
  return {
    type: 'error',
    requestId,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      currentRevision: error.currentRevision,
      details: error.details,
    },
  };
}

export class DaemonProtocolConnection {
  private readonly stream: Duplex;
  private readonly decoder: LengthPrefixedJsonDecoder;
  private readonly limits: DaemonConnectionLimits;
  private readonly now: () => number;
  private readonly supportedMethods: ReadonlySet<CoreMethod>;
  private readonly pendingMessages: ProtocolMessage[] = [];
  private readonly writer: BoundedFrameWriter;
  private readonly closedPromise: Promise<string>;
  private resolveClosed!: (reason: string) => void;

  private access: AuthenticatedClientAccessContext | null = null;
  private scheduler: DaemonRequestScheduler | null = null;
  private subscription: DaemonEventSubscription | null = null;
  private subscriptionController: AbortController | null = null;
  private subscriptionOperation: Promise<void> | null = null;
  private teardownPromise: Promise<readonly unknown[]> | null = null;
  private finalizePromise: Promise<readonly unknown[]> | null = null;
  private lastEventRevision = 0;
  private dispatching = false;
  private stateValue: DaemonProtocolConnectionState = 'open';
  private closeReasonValue: string | null = null;
  private closeGraceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: DaemonProtocolConnectionOptions) {
    this.stream = options.admission.stream;
    this.limits = normalizeDaemonConnectionLimits(options.limits);
    this.decoder = new LengthPrefixedJsonDecoder(this.limits.maxFrameBytes);
    this.now = options.now ?? Date.now;
    const supported = new Set<CoreMethod>();
    for (const method of options.runtime.supportedMethods) {
      if (!isCoreMethod(method)) throw new TypeError(`Unknown Core method: ${method}`);
      supported.add(method);
    }
    this.supportedMethods = supported;
    this.writer = new BoundedFrameWriter(this.stream, this.limits, {
      onFailure: (reason) => this.close(reason),
    });
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });

    this.stream.on('data', this.onData);
    this.stream.once('end', this.onEnd);
    this.stream.once('error', this.onError);
    this.stream.once('close', this.onStreamClose);
  }

  get isClosed(): boolean {
    return this.stateValue === 'closed';
  }

  get state(): DaemonProtocolConnectionState {
    return this.stateValue;
  }

  get inFlightRequestCount(): number {
    return this.scheduler?.inFlightCount ?? 0;
  }

  get queuedRequestCount(): number {
    return this.scheduler?.queuedCount ?? 0;
  }

  whenClosed(): Promise<string> {
    return this.closedPromise;
  }

  private readonly onData = (chunk: Buffer): void => {
    if (this.stateValue !== 'open') return;
    let values: JsonValue[];
    try {
      values = this.decoder.push(chunk);
      for (const value of values) assertProtocolMessageEnvelope(value);
    } catch {
      this.close('malformed-frame');
      return;
    }
    if (this.pendingMessages.length + values.length > this.limits.maxPendingMessages) {
      this.close('inbound-message-queue-overflow');
      return;
    }
    this.pendingMessages.push(...(values as unknown as ProtocolMessage[]));
    void this.drainPendingMessages();
  };

  private readonly onEnd = (): void => this.close('transport-ended');
  private readonly onError = (): void => this.close('transport-error');
  private readonly onStreamClose = (): void => this.close('transport-closed');

  private async drainPendingMessages(): Promise<void> {
    if (this.dispatching || this.stateValue !== 'open') return;
    this.dispatching = true;
    try {
      while (this.stateValue === 'open' && this.pendingMessages.length > 0) {
        const message = this.pendingMessages.shift();
        if (message) await this.handleMessage(message);
      }
    } catch {
      this.close('protocol-dispatch-failed');
    } finally {
      this.dispatching = false;
    }
  }

  private async handleMessage(message: ProtocolMessage): Promise<void> {
    if (this.stateValue !== 'open') return;
    try {
      assertDaemonMessageIdentifiers(message);
    } catch (error) {
      const detail = error instanceof DaemonRequestError ? error.message : 'Invalid identifier';
      this.failProtocol('invalid-correlation-id', detail);
      return;
    }
    if (!this.access && message.type !== 'hello') {
      this.failProtocol('handshake', 'The first client message must be hello');
      return;
    }
    switch (message.type) {
      case 'hello':
        await this.handleHello(message.requestId, message.hello);
        return;
      case 'request':
        this.scheduler?.enqueue(message);
        return;
      case 'cancel':
        this.scheduler?.cancel(message.targetRequestId);
        return;
      case 'subscribe':
        await this.handleSubscribe(message.requestId, message.afterRevision);
        return;
      case 'ping':
        this.send({ type: 'pong', nonce: message.nonce });
        return;
      case 'error':
      case 'event':
      case 'hello-result':
      case 'pong':
      case 'result':
        this.failProtocol('protocol', `Client cannot send ${message.type}`);
        return;
    }
  }

  private async handleHello(
    requestId: string,
    hello: Parameters<DaemonConnectionAdmission['createAccessContext']>[0],
  ): Promise<void> {
    if (this.access) {
      this.failProtocol(requestId, 'hello may be sent only once');
      return;
    }
    try {
      if (hello.requestedTopology !== DeploymentTopology.ServerCore) {
        throw new ProtocolCompatibilityError(
          `agent-deckd serves server-core, not ${hello.requestedTopology}`,
        );
      }
      const protocolVersion = negotiateProtocolVersion(hello.protocolVersion);
      const created = await this.options.admission.createAccessContext(hello);
      if (this.stateValue !== 'open') return;
      const access = normalizeDaemonAccessContext(
        created,
        hello.clientId,
        this.options.instanceId,
      );
      const eventRevision = await this.options.runtime.currentRevision(access);
      if (this.stateValue !== 'open') return;
      if (!Number.isSafeInteger(eventRevision) || eventRevision < 0) {
        throw new Error('Core returned an invalid current revision');
      }
      const hostHello = createDaemonHostHello({
        protocolVersion,
        appVersion: this.options.appVersion,
        instanceId: this.options.instanceId,
        authoritativeCoreId: this.options.authoritativeCoreId,
        access,
        supportedMethods: this.supportedMethods,
        replayAvailable: Boolean(this.options.runtime.subscribe),
        limits: this.limits,
        eventRevision,
      });
      assertHostHello(hostHello);
      if (this.stateValue !== 'open') return;
      this.access = access;
      this.scheduler = this.createScheduler(access);
      this.lastEventRevision = hello.lastEventRevision ?? eventRevision;
      this.send({ type: 'hello-result', requestId, hello: hostHello });
    } catch (error) {
      if (this.stateValue !== 'open') return;
      const normalized = this.normalizeError(error);
      if (normalized) {
        this.sendError(requestId, normalized);
        this.scheduleCloseAfterFlush('handshake-rejected');
      } else {
        this.close('handshake-host-failed');
      }
    }
  }

  private createScheduler(access: AuthenticatedClientAccessContext): DaemonRequestScheduler {
    return new DaemonRequestScheduler({
      access,
      runtime: this.options.runtime,
      supportedMethods: this.supportedMethods,
      limits: this.limits,
      now: this.now,
      callbacks: {
        onResult: (requestId, result, revision) =>
          this.send({ type: 'result', requestId, result, revision }),
        onError: (requestId, error) => this.sendError(requestId, error),
        onOverflow: () => this.close('request-queue-overflow'),
      },
    });
  }

  private async handleSubscribe(requestId: string, afterRevision: number): Promise<void> {
    const operation = this.performSubscribe(requestId, afterRevision);
    this.subscriptionOperation = operation;
    try {
      await operation;
    } finally {
      if (this.subscriptionOperation === operation) this.subscriptionOperation = null;
    }
  }

  private async performSubscribe(requestId: string, afterRevision: number): Promise<void> {
    const access = this.access;
    if (!access || this.stateValue !== 'open') return;
    if (!this.options.runtime.subscribe) {
      this.sendError(
        requestId,
        new DaemonRequestError(
          AgentDeckClientErrorCode.CapabilityUnavailable,
          'Persisted event replay is not available from this Core runtime',
        ),
      );
      return;
    }
    await this.closeSubscription('subscription-replaced');
    if (this.stateValue !== 'open') return;
    const controller = new AbortController();
    this.subscriptionController = controller;
    this.lastEventRevision = afterRevision;
    try {
      this.subscription = await this.options.runtime.subscribe({
        access,
        afterRevision,
        signal: controller.signal,
        onEvent: (event) => this.forwardEvent(event),
      });
      if (this.stateValue !== 'open' || controller.signal.aborted) return;
      const revision = await this.options.runtime.currentRevision(access);
      if (this.stateValue !== 'open' || controller.signal.aborted) return;
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new Error('Core returned an invalid subscription revision');
      }
      this.send({
        type: 'result',
        requestId,
        result: { subscribed: true, afterRevision },
        revision,
      });
    } catch (error) {
      controller.abort('subscription-failed');
      if (this.subscriptionController === controller) this.subscriptionController = null;
      try {
        await this.closeSubscription('subscription-failed');
      } catch {
        if (this.stateValue === 'open') this.close('subscription-cleanup-failed');
        return;
      }
      if (this.stateValue !== 'open') return;
      const normalized = this.normalizeError(error);
      if (normalized) this.sendError(requestId, normalized);
      else this.close('subscription-host-failed');
    }
  }

  private forwardEvent(event: Parameters<NonNullable<DaemonCoreRuntime['subscribe']>>[0]['onEvent'] extends (
    value: infer Value,
  ) => void
    ? Value
    : never): void {
    if (this.stateValue !== 'open') return;
    if (
      event.instanceId !== this.options.instanceId ||
      !Number.isSafeInteger(event.revision) ||
      event.revision <= this.lastEventRevision
    ) {
      this.close('invalid-core-event');
      return;
    }
    const message = { type: 'event' as const, ...event };
    try {
      assertProtocolMessageEnvelope(message);
    } catch {
      this.close('invalid-core-event');
      return;
    }
    this.lastEventRevision = event.revision;
    this.send(message, true);
  }

  private normalizeError(error: unknown): DaemonRequestError | null {
    if (error instanceof DaemonRequestError) return error;
    if (error instanceof ProtocolCompatibilityError) {
      return new DaemonRequestError(
        AgentDeckClientErrorCode.IncompatibleProtocol,
        error.message,
      );
    }
    return null;
  }

  private failProtocol(requestId: string, message: string): void {
    if (this.stateValue !== 'open') return;
    this.sendError(
      requestId,
      new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, message),
    );
    this.scheduleCloseAfterFlush('protocol-violation');
  }

  private sendError(requestId: string, error: DaemonRequestError): void {
    this.send(requestErrorMessage(requestId, error));
  }

  private send(message: HostProtocolMessage, event = false): void {
    if (this.stateValue !== 'open') return;
    this.writer.send(message, event);
  }

  private scheduleCloseAfterFlush(reason: string): void {
    if (this.stateValue !== 'open') return;
    this.stateValue = 'terminal-flushing';
    this.closeReasonValue = reason;
    this.startTeardown(reason);
    this.closeGraceTimer = setTimeout(() => this.close(reason), this.limits.protocolCloseGraceMs);
    this.closeGraceTimer.unref();
    void this.writer.flushed().then(() => this.close(reason));
  }

  private async closeSubscription(reason: string): Promise<void> {
    this.subscriptionController?.abort(reason);
    this.subscriptionController = null;
    const subscription = this.subscription;
    this.subscription = null;
    if (subscription) await subscription.close();
  }

  private startTeardown(reason: string): Promise<readonly unknown[]> {
    if (this.teardownPromise) return this.teardownPromise;
    this.stream.off('data', this.onData);
    this.decoder.reset();
    this.pendingMessages.splice(0);
    this.access = null;
    const scheduler = this.scheduler;
    this.scheduler = null;
    this.subscriptionController?.abort(reason);
    const subscriptionOperation = this.subscriptionOperation;

    this.teardownPromise = (async () => {
      const failures: unknown[] = [];
      if (scheduler) {
        try {
          await scheduler.close(reason);
        } catch (error) {
          failures.push(error);
        }
      }
      if (subscriptionOperation) {
        try {
          await subscriptionOperation;
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await this.closeSubscription(reason);
      } catch (error) {
        failures.push(error);
      }
      return failures;
    })();
    return this.teardownPromise;
  }

  private finalizeClose(reason: string): Promise<readonly unknown[]> {
    if (this.finalizePromise) return this.finalizePromise;
    const finalReason = this.closeReasonValue ?? reason;
    this.closeReasonValue = finalReason;
    this.stateValue = 'closing';
    if (this.closeGraceTimer) clearTimeout(this.closeGraceTimer);
    this.closeGraceTimer = null;
    this.stream.off('end', this.onEnd);
    this.stream.off('error', this.onError);
    this.stream.off('close', this.onStreamClose);
    const teardown = this.startTeardown(finalReason);
    this.writer.dispose();
    if (!this.stream.destroyed) this.stream.destroy();

    this.finalizePromise = (async () => {
      const failures = [...(await teardown)];
      this.stateValue = 'closed';
      this.resolveClosed(finalReason);
      try {
        this.options.onClose?.(this);
      } catch (error) {
        failures.push(error);
      }
      return failures;
    })();
    return this.finalizePromise;
  }

  close(reason = 'host-closed'): void {
    void this.finalizeClose(reason);
  }

  async shutdown(reason = 'host-closed'): Promise<void> {
    const failures = await this.finalizeClose(reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Daemon connection shutdown failed');
    }
  }
}
