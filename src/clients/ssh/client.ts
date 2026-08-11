import {
  AgentDeckClientErrorCode,
  isCoreMethod,
  type AgentDeckClient,
  type AgentDeckEventEnvelope,
  type AgentDeckRequestOptions,
  type AgentDeckSubscription,
  type ClientHello,
  type CoreMethod,
  type CoreMethodMap,
  type HostHello,
  type JsonValue,
} from '@contracts/index';
import type {
  HostProtocolMessage,
  ProtocolCancelMessage,
  ProtocolErrorMessage,
  ProtocolEventMessage,
  ProtocolRequestMessage,
  ProtocolResultMessage,
  ProtocolSubscribeMessage,
} from '@protocol/messages';

import { SshProtocolConnection } from './connection';
import { AgentDeckRemoteError, SshTransportError } from './errors';
import { isBoundedSingleLine, SSH_TEXT_LIMITS } from './limits';
import {
  cleanupPendingRequest,
  createPendingRequest,
  installPendingCancellation,
  type PendingRequest,
} from './pending-request';
import { buildProtocolRequest } from './request-policy';
import { ResponseLedger } from './response-ledger';
import type {
  SshConnectionState,
  SshHostProfile,
  SshRequestOptions,
  SshStateSubscription,
  SshTransportOptions,
} from './types';

type MethodParams<Method extends CoreMethod> = CoreMethodMap[Method] extends {
  params: infer Params;
}
  ? Params
  : never;
type MethodResult<Method extends CoreMethod> = CoreMethodMap[Method] extends {
  result: infer Result;
}
  ? Result
  : never;

export class SshAgentDeckClient implements AgentDeckClient<CoreMethodMap> {
  readonly profile: Readonly<SshHostProfile>;
  private readonly connection: SshProtocolConnection;
  private readonly now: () => number;
  private readonly responseLedger: ResponseLedger;
  private readonly subscriptions = new Map<
    number,
    (event: AgentDeckEventEnvelope) => void
  >();
  private readonly pending = new Map<string, PendingRequest>();
  /** Requests written on the active Core connection; the remaining pending entries are queued. */
  private readonly sentRequestIds = new Set<string>();
  private readonly controlRequests = new Map<string, 'cancel' | 'subscribe'>();
  private streamCursor = 0;
  private cursorInitialized = false;
  private pendingConnectCursor: number | null = null;
  private nextSubscriptionId = 0;

  constructor(
    profile: SshHostProfile,
    options: SshTransportOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.connection = new SshProtocolConnection(profile, options, {
      getEventCursor: () => this.pendingConnectCursor ?? this.streamCursor,
      onReady: (hello) => this.handleReady(hello),
      onMessage: (message) => this.handleHostMessage(message),
      onTerminal: (error) => this.rejectAllPending(error),
    });
    this.profile = this.connection.profile;
    this.responseLedger = new ResponseLedger(
      this.connection.resolved.bounds.maxRememberedResponses,
    );
  }

  get connectionState(): SshConnectionState {
    return this.connection.state;
  }

  get lastEventRevision(): number {
    return this.streamCursor;
  }

  onConnectionState(listener: (state: SshConnectionState) => void): SshStateSubscription {
    return this.connection.onState(listener);
  }

  connect(hello: ClientHello): Promise<HostHello> {
    const cursor = hello.lastEventRevision ?? 0;
    const establishedCursor = this.cursorInitialized
      ? this.streamCursor
      : this.pendingConnectCursor;
    if (establishedCursor !== null && cursor !== establishedCursor) {
      return Promise.reject(
        new SshTransportError(
          'invalid_request',
          'Client hello cursor must match this SSH client cursor',
        ),
      );
    }
    if (!this.cursorInitialized) this.pendingConnectCursor = cursor;
    return this.connection.connect(hello).then(
      (hostHello) => {
        if (!this.cursorInitialized) {
          this.streamCursor = cursor;
          this.cursorInitialized = true;
        }
        if (this.pendingConnectCursor === cursor) this.pendingConnectCursor = null;
        return hostHello;
      },
      (error: unknown) => {
        if (!this.cursorInitialized && this.pendingConnectCursor === cursor) {
          this.pendingConnectCursor = null;
        }
        throw error;
      },
    );
  }

  request: AgentDeckClient<CoreMethodMap>['request'] = ((
    method: CoreMethod,
    params: unknown,
    options?: AgentDeckRequestOptions,
  ) => this.requestInternal(method, params, options)) as AgentDeckClient<CoreMethodMap>['request'];

  requestCancellable<Method extends CoreMethod>(
    method: Method,
    params: MethodParams<Method>,
    options: SshRequestOptions,
  ): Promise<MethodResult<Method>> {
    return this.requestInternal(method, params, options) as Promise<MethodResult<Method>>;
  }

  subscribe(
    afterRevision: number,
    listener: (event: AgentDeckEventEnvelope) => void,
  ): AgentDeckSubscription {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new SshTransportError('invalid_request', 'afterRevision must be non-negative');
    }
    const activeCursor = this.cursorInitialized ? this.streamCursor : this.pendingConnectCursor;
    if (activeCursor !== null && afterRevision !== activeCursor) {
      throw new SshTransportError(
        'replay_gap',
        'All listeners on one SSH client must share its event cursor',
      );
    }
    const wasEmpty = this.subscriptions.size === 0;
    if (!this.cursorInitialized) {
      this.streamCursor = afterRevision;
      this.cursorInitialized = true;
      this.pendingConnectCursor = null;
    }
    const id = ++this.nextSubscriptionId;
    this.subscriptions.set(id, listener);
    if (wasEmpty && this.connection.ready) this.sendSubscribe();
    return { close: () => this.subscriptions.delete(id) };
  }

  cancel(requestId: string): boolean {
    return this.cancelPending(requestId, 'cancelled');
  }

  close(): Promise<void> {
    return this.connection.close();
  }

  private requestInternal(
    method: CoreMethod,
    params: unknown,
    options?: SshRequestOptions,
  ): Promise<JsonValue> {
    if (this.connection.isClosed) {
      return Promise.reject(new SshTransportError('connection_closed', 'SSH transport is closed'));
    }
    const clientHello = this.connection.clientHello;
    if (!clientHello || !this.connection.acceptingRequests) {
      return Promise.reject(
        new SshTransportError(
          'not_connected',
          this.connection.state.reason ?? 'No active SSH connection or reconnect attempt',
        ),
      );
    }
    if (!isCoreMethod(method)) {
      return Promise.reject(new SshTransportError('invalid_request', `Unknown method: ${method}`));
    }
    const requestId = options?.requestId ?? this.connection.createId('request');
    if (
      !isBoundedSingleLine(requestId, SSH_TEXT_LIMITS.requestId) ||
      this.isRequestIdInUse(requestId)
    ) {
      return Promise.reject(
        new SshTransportError(
          'invalid_request',
          `requestId must be unique, free of wire controls, and at most ${SSH_TEXT_LIMITS.requestId} UTF-8 bytes`,
        ),
      );
    }
    if (this.pending.size >= this.connection.resolved.bounds.maxQueuedRequests) {
      return Promise.reject(
        new SshTransportError('in_flight_limit', 'SSH request queue limit reached', true),
      );
    }
    if (options?.signal?.aborted) {
      return Promise.reject(new SshTransportError('cancelled', 'Request was cancelled'));
    }

    let message: ProtocolRequestMessage;
    try {
      message = buildProtocolRequest({
        method,
        params,
        options,
        requestId,
        generatedIdempotencyKey: `${clientHello.clientId}:${requestId}`,
        now: this.now(),
        hello: this.connection.hostHello,
      });
    } catch (error) {
      return Promise.reject(error);
    }

    const { pending, promise } = createPendingRequest(message);
    this.pending.set(requestId, pending);
    installPendingCancellation(pending, options, this.now, (reason) => {
      this.cancelPending(requestId, reason);
    });
    if (this.connection.ready) this.dispatchPending();
    return promise;
  }

  private handleReady(hello: HostHello): void {
    this.controlRequests.clear();
    // A new SSH/Core connection has no live requests even when logical requests are retained for
    // retry. Re-admit them against the newly negotiated limit instead of rejecting the tail.
    this.sentRequestIds.clear();
    if (this.subscriptions.size > 0) this.sendSubscribe();
    this.dispatchPending(hello);
  }

  private handleHostMessage(message: HostProtocolMessage): void {
    switch (message.type) {
      case 'result':
      case 'error':
        this.handleResponse(message);
        return;
      case 'event':
        this.handleEvent(message);
        return;
      default:
        this.connection.failProtocol(
          new SshTransportError('protocol_violation', `Unexpected message ${message.type}`),
          'incompatible',
        );
    }
  }

  private handleResponse(message: ProtocolResultMessage | ProtocolErrorMessage): void {
    const control = this.controlRequests.get(message.requestId);
    if (control) {
      this.controlRequests.delete(message.requestId);
      if (message.type === 'error') {
        this.handleControlError(control, this.remoteError(message));
      }
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) {
      const remembered = this.responseLedger.get(message.requestId);
      if (remembered === 'cancelled' || remembered === 'deadline') return;
      const kind = remembered === 'settled' ? 'duplicate' : 'unknown';
      this.connection.failProtocol(
        new SshTransportError(
          'protocol_violation',
          `Host sent ${kind} response for ${message.requestId}`,
        ),
        'incompatible',
      );
      return;
    }
    if (!this.sentRequestIds.has(message.requestId)) {
      this.connection.failProtocol(
        new SshTransportError(
          'protocol_violation',
          `Host sent response for queued request ${message.requestId}`,
        ),
        'incompatible',
      );
      return;
    }

    this.pending.delete(message.requestId);
    this.sentRequestIds.delete(message.requestId);
    this.cleanupPending(pending);
    this.responseLedger.remember(message.requestId, 'settled');
    if (message.type === 'result') {
      this.connection.markResponsive();
      pending.resolve(message.result);
      this.dispatchPending();
      return;
    }
    const error = this.remoteError(message);
    if (error.code === AgentDeckClientErrorCode.WorkerOffline) {
      this.connection.markWorkerOffline(error);
    }
    pending.reject(error);
    if (error.code === AgentDeckClientErrorCode.Revoked) {
      this.connection.failProtocol(error, 'incompatible');
      return;
    }
    this.dispatchPending();
  }

  private handleEvent(message: ProtocolEventMessage): void {
    if (!this.connection.hostHello || message.instanceId !== this.connection.hostHello.instanceId) {
      this.connection.failProtocol(
        new SshTransportError('protocol_violation', 'Event instance does not match host hello'),
        'incompatible',
      );
      return;
    }
    if (message.revision <= this.streamCursor) return;
    if (message.revision !== this.streamCursor + 1) {
      this.connection.failProtocol(
        new SshTransportError(
          'replay_gap',
          `Expected event revision ${this.streamCursor + 1}, received ${message.revision}`,
        ),
        'offline',
      );
      return;
    }
    this.streamCursor = message.revision;
    for (const listener of this.subscriptions.values()) {
      try {
        listener(structuredClone(message));
      } catch {}
    }
    this.connection.markResponsive();
  }

  private cancelPending(requestId: string, reason: 'cancelled' | 'deadline'): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    const wasSent = this.sentRequestIds.delete(requestId);
    this.cleanupPending(pending);
    this.responseLedger.remember(requestId, reason);
    if (wasSent && this.connection.ready) {
      const controlId = this.connection.createId('cancel');
      this.trackControl(controlId, 'cancel');
      try {
        this.connection.send({
          type: 'cancel',
          requestId: controlId,
          targetRequestId: requestId,
        } satisfies ProtocolCancelMessage);
      } catch {
        this.controlRequests.delete(controlId);
      }
    }
    pending.reject(
      reason === 'deadline'
        ? new AgentDeckRemoteError(
            AgentDeckClientErrorCode.DeadlineExceeded,
            'Request deadline exceeded',
            false,
            undefined,
            null,
          )
        : new SshTransportError('cancelled', 'Request was cancelled'),
    );
    this.dispatchPending();
    return true;
  }

  private sendPending(pending: PendingRequest): void {
    const requestId = pending.message.requestId;
    if (!this.pending.has(requestId) || this.sentRequestIds.has(requestId)) return;
    this.sentRequestIds.add(requestId);
    try {
      this.connection.send(pending.message);
    } catch (error) {
      this.pending.delete(requestId);
      this.sentRequestIds.delete(requestId);
      this.cleanupPending(pending);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private dispatchPending(hello = this.connection.hostHello): void {
    if (!this.connection.ready) return;
    const limit = this.effectiveInFlightLimit(hello);
    for (const pending of this.pending.values()) {
      if (this.sentRequestIds.size >= limit) return;
      this.sendPending(pending);
    }
  }

  private sendSubscribe(): void {
    if ([...this.controlRequests.values()].includes('subscribe')) return;
    const requestId = this.connection.createId('subscribe');
    this.trackControl(requestId, 'subscribe');
    try {
      this.connection.send({
        type: 'subscribe',
        requestId,
        afterRevision: this.streamCursor,
      } satisfies ProtocolSubscribeMessage);
    } catch (error) {
      this.controlRequests.delete(requestId);
      throw error;
    }
  }

  private effectiveInFlightLimit(hello = this.connection.hostHello): number {
    return Math.min(
      this.connection.resolved.bounds.maxInFlightRequests,
      hello?.limits.maxConcurrentRequests ?? Number.POSITIVE_INFINITY,
    );
  }

  private trackControl(requestId: string, kind: 'cancel' | 'subscribe'): void {
    const limit = this.connection.resolved.bounds.maxInFlightRequests;
    while (this.controlRequests.size >= limit) {
      const oldest = this.controlRequests.keys().next().value as string | undefined;
      if (!oldest) break;
      this.controlRequests.delete(oldest);
      this.responseLedger.remember(oldest, 'cancelled');
    }
    this.controlRequests.set(requestId, kind);
  }

  private remoteError(message: ProtocolErrorMessage): AgentDeckRemoteError {
    return new AgentDeckRemoteError(
      message.error.code,
      message.error.message,
      message.error.retryable,
      message.error.currentRevision ?? undefined,
      message.error.details,
    );
  }

  private handleControlError(
    _control: 'cancel' | 'subscribe',
    error: AgentDeckRemoteError,
  ): void {
    if (error.code === AgentDeckClientErrorCode.Revoked) {
      this.connection.failProtocol(error, 'incompatible');
      return;
    }
    if (
      error.code === AgentDeckClientErrorCode.WorkerOffline &&
      this.profile.topology === 'relay'
    ) {
      this.connection.markWorkerOffline(error);
      return;
    }
    this.connection.failProtocol(error, 'offline');
  }

  private cleanupPending(pending: PendingRequest): void {
    cleanupPendingRequest(pending);
  }

  private rejectAllPending(error: Error): void {
    this.controlRequests.clear();
    this.sentRequestIds.clear();
    for (const pending of this.pending.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private isRequestIdInUse(requestId: string): boolean {
    return (
      this.pending.has(requestId) ||
      this.controlRequests.has(requestId) ||
      this.responseLedger.get(requestId) !== undefined
    );
  }
}
