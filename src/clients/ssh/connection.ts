import {
  AgentDeckClientErrorCode,
  type ClientHello,
  type HostHello,
  type JsonValue,
} from '@contracts/index';
import {
  assertClientHello,
  type ProtocolMessage,
} from '@protocol/messages';
import { validateSshHostProfile } from './argv';
import type { SshChildRetirement } from './child-lifecycle';
import { startConnectionAttempt } from './connection-attempt';
import { resolveSshTransportOptions, type ResolvedSshTransportOptions } from './config';
import type {
  ConnectionContext,
  ConnectDeferred,
  SshProtocolConnectionHooks,
} from './connection-context';
import { createConnectDeferred } from './connection-context';
import {
  errorMessage,
  isHostKeyFailure,
  isRetryableSshWriteFailure,
  remoteErrorFromMessage,
  SshTransportError,
} from './errors';
import {
  assertJsonSafeClientHello,
  asSshHandshakeError,
  validateSshClientHello,
  validateSshHostHello,
} from './handshake';
import { ProtocolHeartbeat } from './heartbeat';
import { captureSshStderr, decodeSshStdout } from './connection-io';
import { routeHostProtocolMessage } from './connection-message-router';
import { SshConnectionStatePublisher } from './connection-state';
import { isBoundedSingleLine, SSH_TEXT_LIMITS } from './limits';
import { spawnOpenSsh } from './process';
import { SshRetirementTracker } from './retirement-tracker';
import {
  cloneClientHello,
  cloneHostHello,
  freezeClientHello,
  freezeHostHello,
  freezeSshHostProfile,
} from './snapshots';
import type {
  SpawnSshProcess,
  SshConnectionState,
  SshHostProfile,
  SshStateSubscription,
  SshTransportOptions,
} from './types';

type Timer = ReturnType<typeof setTimeout>;
type TerminalStatus = 'incompatible' | 'offline';
export type { SshProtocolConnectionHooks } from './connection-context';
export class SshProtocolConnection {
  readonly profile: Readonly<SshHostProfile>;
  readonly resolved: ResolvedSshTransportOptions;
  private readonly spawn: SpawnSshProcess;
  private readonly states: SshConnectionStatePublisher;
  private clientHelloValue: ClientHello | null = null;
  private hostHelloValue: HostHello | null = null;
  private context: ConnectionContext | null = null;
  private attemptRetirement: SshChildRetirement | null = null;
  private readonly retirements = new SshRetirementTracker();
  private connectDeferred: ConnectDeferred | null = null;
  private reconnectTimer: Timer | null = null;
  private readonly heartbeat: ProtocolHeartbeat;
  private nextSequence = 0;
  private reconnectAttempt = 0;
  private generation = 0;
  private hasConnected = false;
  private recoveryActive = false;
  private terminalError: Error | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  constructor(
    profile: SshHostProfile,
    private readonly options: SshTransportOptions,
    private readonly hooks: SshProtocolConnectionHooks,
  ) {
    validateSshHostProfile(profile);
    this.profile = freezeSshHostProfile(profile);
    this.resolved = resolveSshTransportOptions(options);
    this.spawn = options.spawn ?? spawnOpenSsh;
    this.heartbeat = new ProtocolHeartbeat(
      this.resolved.timing,
      () => this.createId('ping'),
      (nonce) => this.send({ type: 'ping', nonce }),
      () =>
        this.handleFailure(
          this.context,
          new SshTransportError('connection_failed', 'SSH protocol pong timed out', true),
        ),
    );
    this.states = new SshConnectionStatePublisher(this.profile);
  }
  get state(): SshConnectionState {
    return this.states.snapshot();
  }
  get clientHello(): ClientHello | null {
    return this.clientHelloValue ? cloneClientHello(this.clientHelloValue) : null;
  }
  get hostHello(): HostHello | null {
    return this.hostHelloValue ? cloneHostHello(this.hostHelloValue) : null;
  }
  get ready(): boolean {
    return this.context?.handshakeComplete === true;
  }
  get isClosed(): boolean {
    return this.closed;
  }
  get acceptingRequests(): boolean {
    return (
      !this.closed &&
      (this.ready || this.context !== null || this.reconnectTimer !== null || this.recoveryActive)
    );
  }
  onState(listener: (state: SshConnectionState) => void): SshStateSubscription {
    return this.states.subscribe(listener);
  }
  connect(hello: ClientHello): Promise<HostHello> {
    if (this.closed) {
      return Promise.reject(
        new SshTransportError('connection_closed', 'SSH transport is already closed'),
      );
    }
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }
    try {
      assertClientHello(hello);
      assertJsonSafeClientHello(hello);
      validateSshClientHello(this.profile, this.clientHelloValue, hello);
    } catch (error) {
      return Promise.reject(asSshHandshakeError(error));
    }
    if (this.ready && this.hostHelloValue) return Promise.resolve(cloneHostHello(this.hostHelloValue));
    if (this.connectDeferred) return this.connectDeferred.promise.then(cloneHostHello);

    const deferred = createConnectDeferred();
    this.connectDeferred = deferred;
    this.clientHelloValue ??= freezeClientHello(hello);
    const joinsActiveChain =
      this.context !== null ||
      this.attemptRetirement !== null ||
      this.recoveryActive ||
      this.reconnectTimer !== null;
    if (!joinsActiveChain) {
      this.reconnectAttempt = 0;
      this.beginAttempt();
    }
    return deferred.promise.then(cloneHostHello);
  }
  send(message: object): void {
    const context = this.context;
    if (!context?.handshakeComplete || context.terminated) {
      throw new SshTransportError('not_connected', 'SSH protocol connection is not ready');
    }
    context.writer.enqueue(message as JsonValue);
  }
  createId(kind: string): string {
    const provided = this.options.createRequestId?.();
    const id = provided ?? `ssh:${this.profile.id}:${kind}:${++this.nextSequence}`;
    if (!isBoundedSingleLine(id, SSH_TEXT_LIMITS.requestId)) {
      throw new SshTransportError(
        'invalid_request',
        `Generated request id must be at most ${SSH_TEXT_LIMITS.requestId} UTF-8 bytes and contain no wire controls`,
      );
    }
    return id;
  }
  markWorkerOffline(error: ReturnType<typeof remoteErrorFromMessage>): void {
    if (this.profile.topology === 'relay' && this.ready) {
      this.setState('offline', error.message, error.code);
    }
  }
  markResponsive(): void {
    if (
      this.ready &&
      this.states.value.errorCode === AgentDeckClientErrorCode.WorkerOffline &&
      this.profile.topology === 'relay'
    ) {
      this.setState('connected', null, null);
    }
  }
  failProtocol(error: Error, status: TerminalStatus): void {
    this.failTerminal(this.context, error, status);
  }
  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    this.recoveryActive = false;
    this.clearReconnectTimer();
    const context = this.context;
    this.detach(context);
    const error = new SshTransportError(
      'connection_closed',
      'SSH transport stopped; the remote Core lifecycle is unchanged',
    );
    this.rejectConnect(error);
    try {
      this.hooks.onTerminal(error);
    } catch {}
    this.setState('closed', error.message, error.code);
    const failures = await this.retirements.retireAll();
    if (failures.length === 0) return;
    const failure = failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
    const code =
      'code' in failure && typeof failure.code === 'string' ? failure.code : 'child_exit_timeout';
    this.setState('closed', failure.message, code);
    throw failure;
  }

  private beginAttempt(): void {
    if (this.closed || !this.clientHelloValue) return;
    this.clearReconnectTimer();
    this.recoveryActive = true;
    this.generation += 1;
    const generation = this.generation;
    this.setState(
      this.hasConnected || this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting',
      null,
      null,
    );
    if (this.closed) {
      this.recoveryActive = false;
      return;
    }

    const reconnectHello = {
      ...this.clientHelloValue,
      lastEventRevision: this.hooks.getEventCursor(),
    };
    try {
      startConnectionAttempt({
        profile: this.profile,
        spawn: this.spawn,
        resolved: this.resolved,
        generation,
        hello: reconnectHello,
        hooks: {
          adopt: (retirement) => {
            this.attemptRetirement = retirement;
            this.retirements.adopt(retirement);
          },
          activate: (context) => {
            this.context = context;
          },
          createId: () => this.createId('hello'),
          onStdout: (context, chunk) => this.handleStdout(context, chunk),
          onStderr: (context, chunk) => this.handleStderr(context, chunk),
          onFailure: (context, error) => this.handleFailure(context, error),
        },
      });
      this.attemptRetirement = null;
      if (this.context?.generation === generation) this.recoveryActive = false;
    } catch (error) {
      const retirement = this.attemptRetirement;
      this.attemptRetirement = null;
      const context = this.context?.retirement === retirement ? this.context : null;
      this.handleFailure(context, error, retirement);
    }
  }

  private handleStdout(context: ConnectionContext, chunk: unknown): void {
    if (this.context !== context || context.terminated) return;
    try {
      decodeSshStdout(context, chunk, (message) => this.handleMessage(context, message));
    } catch (error) {
      if (isRetryableSshWriteFailure(error)) {
        this.handleFailure(context, error);
        return;
      }
      this.failTerminal(
        context,
        new SshTransportError('protocol_violation', errorMessage(error), false, { cause: error }),
        'incompatible',
      );
    }
  }

  private handleStderr(context: ConnectionContext, chunk: unknown): void {
    if (this.context !== context || context.terminated) return;
    captureSshStderr(context, chunk, this.resolved.bounds.maxStderrBytes);
  }

  private handleMessage(context: ConnectionContext, message: ProtocolMessage): void {
    routeHostProtocolMessage(context, message, {
      completeHandshake: (hello) => this.completeHandshake(context, hello),
      deliver: (hostMessage) => this.hooks.onMessage(hostMessage),
      sendPong: (nonce) => this.send({ type: 'pong', nonce }),
      acceptPong: (nonce) => this.heartbeat.acceptPong(nonce),
      fail: (error, status) => this.failTerminal(context, error, status),
      invalid: (detail) => this.protocolDirectionFailure(context, detail),
    });
  }

  private completeHandshake(context: ConnectionContext, hello: HostHello): void {
    if (!this.clientHelloValue) return;
    try {
      validateSshHostHello(
        this.profile,
        this.clientHelloValue,
        hello,
        Math.max(
          this.clientHelloValue.lastEventRevision ?? 0,
          this.hooks.getEventCursor(),
        ),
      );
    } catch (error) {
      const failure = error instanceof SshTransportError ? error : asSshHandshakeError(error);
      this.failTerminal(
        context,
        failure,
        failure.code === 'replay_gap' ? 'offline' : 'incompatible',
      );
      return;
    }

    const reconnected = this.hasConnected;
    context.handshakeComplete = true;
    if (context.handshakeTimer) clearTimeout(context.handshakeTimer);
    context.handshakeTimer = null;
    context.writer.setNegotiatedMaxFrameBytes(hello.limits.maxFrameBytes);
    this.hostHelloValue = freezeHostHello(hello);
    this.hasConnected = true;
    this.reconnectAttempt = 0;
    if (this.closed || this.context !== context) return;
    try {
      // Reconcile retained/sent request bookkeeping before observers can admit work as connected.
      this.hooks.onReady(cloneHostHello(this.hostHelloValue), reconnected);
    } catch (error) {
      if (isRetryableSshWriteFailure(error)) {
        this.handleFailure(context, error);
        return;
      }
      this.failTerminal(context, error instanceof Error ? error : new Error(String(error)), 'offline');
      return;
    }
    if (this.closed || this.context !== context) return;
    this.setState('connected', null, null);
    if (this.closed || this.context !== context) return;
    this.heartbeat.start();
    const deferred = this.connectDeferred;
    this.connectDeferred = null;
    deferred?.resolve(this.hostHelloValue);
  }

  private handleFailure(
    context: ConnectionContext | null,
    cause: unknown,
    adoptedRetirement: SshChildRetirement | null = null,
  ): void {
    if (context && (this.context !== context || context.terminated)) return;
    const stderr = context?.stderr ?? '';
    const retirement = context?.retirement ?? adoptedRetirement;
    this.detach(context);
    if (this.closed) return;
    if (context?.hostKeyFailure || isHostKeyFailure(`${stderr}\n${errorMessage(cause)}`)) {
      this.failTerminal(
        null,
        new SshTransportError(
          'host_key_verification_failed',
          'SSH host key verification failed; update trust explicitly before reconnecting',
        ),
        'incompatible',
        retirement,
      );
      return;
    }
    this.recoverAfterRetirement(
      retirement,
      cause instanceof Error ? cause : new Error(String(cause)),
    );
  }

  private recoverAfterRetirement(
    retirement: SshChildRetirement | null,
    error: Error,
  ): void {
    if (this.reconnectAttempt >= this.resolved.reconnect.maxAttempts) {
      this.failTerminal(null, error, 'offline', retirement);
      return;
    }
    this.recoveryActive = true;
    this.setState('reconnecting', error.message, 'connection_failed');
    this.retirements.track(this.finishRecovery(retirement, error));
  }

  private async finishRecovery(
    retirement: SshChildRetirement | null,
    error: Error,
  ): Promise<void> {
    try {
      if (retirement) await this.retirements.retire(retirement);
    } catch (childError) {
      if (this.closed) return;
      this.recoveryActive = false;
      const failure =
        childError instanceof Error ? childError : new Error(String(childError));
      this.failTerminal(null, failure, 'offline');
      return;
    }
    if (this.closed) return;
    const delay = Math.min(
      this.resolved.reconnect.maxDelayMs,
      this.resolved.reconnect.initialDelayMs *
        this.resolved.reconnect.multiplier ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.beginAttempt(), delay);
    this.recoveryActive = false;
    this.setState('reconnecting', error.message, 'connection_failed');
  }

  private failTerminal(
    context: ConnectionContext | null,
    error: Error,
    status: TerminalStatus,
    adoptedRetirement: SshChildRetirement | null = null,
  ): void {
    if (context && this.context !== context) return;
    this.clearReconnectTimer();
    this.recoveryActive = false;
    this.terminalError = error;
    const active = context ?? this.context;
    const retirement = active?.retirement ?? adoptedRetirement;
    this.detach(active);
    this.rejectConnect(error);
    try {
      this.hooks.onTerminal(error);
    } catch {}
    const code = 'code' in error && typeof error.code === 'string' ? error.code : status;
    this.setState(status, error.message, code);
    if (retirement) {
      this.retirements.track(this.finishTerminalRetirement(retirement));
    }
  }

  private async finishTerminalRetirement(retirement: SshChildRetirement): Promise<void> {
    try {
      await this.retirements.retire(retirement);
    } catch (error) {
      if (this.closed) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      const code =
        'code' in failure && typeof failure.code === 'string'
          ? failure.code
          : 'child_exit_timeout';
      this.terminalError = failure;
      this.setState('offline', failure.message, code);
    }
  }

  private detach(context: ConnectionContext | null): void {
    if (!context || context.terminated) return;
    context.terminated = true;
    if (this.context === context) this.context = null;
    if (context.handshakeTimer) clearTimeout(context.handshakeTimer);
    context.handshakeTimer = null;
    context.detachListeners?.();
    context.writer.close();
    this.heartbeat.stop();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private rejectConnect(error: Error): void {
    const deferred = this.connectDeferred;
    this.connectDeferred = null;
    deferred?.reject(error);
  }

  private protocolDirectionFailure(context: ConnectionContext, detail: string): void {
    this.failTerminal(
      context,
      new SshTransportError('protocol_violation', `Host sent ${detail}`),
      'incompatible',
    );
  }
  private setState(
    status: SshConnectionState['status'],
    reason: string | null,
    errorCode: string | null,
  ): void {
    this.states.publish(status, this.reconnectAttempt, this.hostHelloValue, reason, errorCode);
  }
}
