import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { DaemonListener } from '@hosts/daemon';

import {
  ProviderSessionSupervisorError,
  type ProviderSessionControlChannel,
  type ProviderSessionSupervisorErrorCode,
  type ProviderSessionSupervisorControlPort,
} from './supervisor-port';
import {
  PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
  parseProviderSessionSupervisorAttachReady,
  parseProviderSessionSupervisorTransportRequest,
  type ProviderSessionSupervisorTransportRequest,
  type ProviderSessionSupervisorTransportResponse,
  type ProviderSessionSupervisorTransportResult,
} from './supervisor-transport-contract';
import {
  readProviderSessionSupervisorFrame,
  readProviderSessionSupervisorUpgradeFrame,
  writeProviderSessionSupervisorFrame,
} from './supervisor-transport-frame';

export interface ProviderSessionSupervisorTransportServerOptions {
  readonly listener: DaemonListener;
  readonly maxConnections?: number;
  readonly maxReplayEntries?: number;
  readonly requestReadTimeoutMs?: number;
  readonly prepare?: () => Promise<void>;
  readonly supervisor: ProviderSessionSupervisorControlPort;
}

interface ReplayEntry {
  readonly fingerprint: string;
  readonly response: Promise<ProviderSessionSupervisorTransportResponse>;
  completed: boolean;
}

const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_MAX_REPLAY_ENTRIES = 256;
const DEFAULT_REQUEST_READ_TIMEOUT_MS = 5_000;
const ERROR_MESSAGES: Readonly<Record<ProviderSessionSupervisorErrorCode, string>> = Object.freeze({
  closed: 'Provider session supervisor is closed',
  conflict: 'Provider session identity conflicts with existing state',
  'identity-changed': 'Provider session identity could not be verified',
  limit: 'Provider session supervisor limit reached',
  'not-found': 'Provider session lease is unavailable',
  'teardown-failed': 'Provider session teardown failed',
  unavailable: 'Provider session supervisor is unavailable',
});

function boundedInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function failure(
  requestId: string,
  code: ProviderSessionSupervisorErrorCode,
): ProviderSessionSupervisorTransportResponse {
  return Object.freeze({
    schemaVersion: PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
    error: Object.freeze({ code, message: ERROR_MESSAGES[code] }),
    ok: false,
    requestId,
  });
}

/** Host-side private RPC service. It dispatches only the complete topology-free supervisor port. */
export class ProviderSessionSupervisorTransportServer {
  private readonly connections = new Set<Duplex>();
  private readonly closeRequested: Promise<void>;
  private readonly maxConnections: number;
  private readonly maxReplayEntries: number;
  private readonly operations = new Set<Promise<void>>();
  private readonly replay = new Map<string, ReplayEntry>();
  private readonly requestReadTimeoutMs: number;
  private readonly failureWaiters: Array<(error: Error) => void> = [];
  private resolveCloseRequested!: () => void;
  private closeRequestObserved = false;
  private failureValue: Error | null = null;
  private started = false;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: ProviderSessionSupervisorTransportServerOptions) {
    this.closeRequested = new Promise((resolve) => { this.resolveCloseRequested = resolve; });
    this.maxConnections = boundedInteger(
      options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      'provider supervisor connection limit',
      128,
    );
    this.maxReplayEntries = boundedInteger(
      options.maxReplayEntries ?? DEFAULT_MAX_REPLAY_ENTRIES,
      'provider supervisor replay limit',
      1_024,
    );
    this.requestReadTimeoutMs = boundedInteger(
      options.requestReadTimeoutMs ?? DEFAULT_REQUEST_READ_TIMEOUT_MS,
      'provider supervisor request read timeout',
      60_000,
    );
  }

  get failure(): Error | null {
    return this.failureValue;
  }

  /** Resolves only after a successful remote close response has been flushed to Core. */
  whenCloseRequested(): Promise<void> {
    return this.closeRequested;
  }

  /** Resolves on the first listener failure so a host service cannot remain falsely alive. */
  whenFailed(): Promise<Error> {
    if (this.failureValue) return Promise.resolve(this.failureValue);
    return new Promise((resolve) => this.failureWaiters.push(resolve));
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopping) throw new Error('provider supervisor transport is stopping');
    this.failureValue = null;
    let listenerStarted = false;
    try {
      await this.options.listener.start(
        (stream) => this.accept(stream),
        (error) => this.recordFailure(error),
      );
      listenerStarted = true;
      await this.options.prepare?.();
      if (this.failureValue) throw this.failureValue;
      this.started = true;
    } catch (error) {
      this.started = false;
      await Promise.allSettled([
        ...(listenerStarted ? [this.options.listener.stop()] : []),
        this.options.supervisor.close(),
      ]);
      throw error;
    }
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.started = false;
    const failures: unknown[] = [];
    const listenerStop = this.options.listener.stop().catch((error) => failures.push(error));
    for (const connection of this.connections) connection.destroy();
    const supervisorClose = this.options.supervisor.close()
      .catch((error) => failures.push(error));
    await Promise.allSettled([...this.operations]);
    await Promise.all([listenerStop, supervisorClose]);
    this.connections.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Provider supervisor transport shutdown failed');
    }
  }

  private accept(stream: Duplex): void {
    if (!this.started || this.stopping || this.connections.size >= this.maxConnections) {
      stream.destroy();
      return;
    }
    this.connections.add(stream);
    const retire = (): void => { this.connections.delete(stream); };
    stream.once('close', retire);
    const operation = this.serve(stream).finally(() => {
      stream.removeListener('close', retire);
      this.connections.delete(stream);
    });
    let tracked!: Promise<void>;
    tracked = operation.finally(() => this.operations.delete(tracked));
    this.operations.add(tracked);
  }

  private async serve(stream: Duplex): Promise<void> {
    try {
      const request = parseProviderSessionSupervisorTransportRequest(
        await readProviderSessionSupervisorFrame(stream, this.requestReadTimeoutMs),
      );
      if (request.method === 'attach') {
        await this.serveAttach(stream, request);
        return;
      }
      const response = await this.replayed(request);
      if (stream.destroyed || !stream.writable || stream.writableEnded) return;
      await writeProviderSessionSupervisorFrame(stream, response);
      if (request.method === 'close' && response.ok) {
        await new Promise<void>((resolve) => stream.end(resolve));
        this.observeCloseRequest();
      } else {
        stream.end();
      }
    } catch {
      stream.destroy();
    }
  }

  private async serveAttach(
    stream: Duplex,
    request: ProviderSessionSupervisorTransportRequest,
  ): Promise<void> {
    let channel: ProviderSessionControlChannel | null = null;
    try {
      channel = await this.options.supervisor.attach(request.params as never);
      const spec = request.params as {
        readonly processId: string;
        readonly runtimeHandle: string;
        readonly schemaVersion: number;
        readonly sessionId: string;
      };
      await writeProviderSessionSupervisorFrame(stream, Object.freeze({
        schemaVersion: PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
        ok: true,
        requestId: request.requestId,
        result: Object.freeze({ ...spec, attached: true }),
      }));
      const ready = readProviderSessionSupervisorUpgradeFrame(
        stream,
        this.requestReadTimeoutMs,
      );
      stream.resume();
      const decoded = await ready;
      parseProviderSessionSupervisorAttachReady(decoded.value, request.requestId);
      if (decoded.remainder.byteLength > 0) stream.unshift(decoded.remainder);
      await Promise.allSettled([
        pipeline(stream, channel.stream),
        pipeline(channel.stream, stream),
      ]);
    } catch (cause) {
      if (!channel && !stream.destroyed && stream.writable && !stream.writableEnded) {
        const code = cause instanceof ProviderSessionSupervisorError
          ? cause.code
          : 'unavailable';
        await writeProviderSessionSupervisorFrame(
          stream,
          failure(request.requestId, code),
        ).catch(() => undefined);
        stream.end();
        return;
      }
      stream.destroy();
    } finally {
      await channel?.close().catch(() => undefined);
    }
  }

  private replayed(
    request: ProviderSessionSupervisorTransportRequest,
  ): Promise<ProviderSessionSupervisorTransportResponse> {
    const fingerprint = JSON.stringify(request);
    const existing = this.replay.get(request.requestId);
    if (existing) {
      return existing.fingerprint === fingerprint
        ? existing.response
        : Promise.resolve(failure(request.requestId, 'conflict'));
    }
    this.trimReplay();
    if (this.replay.size >= this.maxReplayEntries) {
      return Promise.resolve(failure(request.requestId, 'limit'));
    }
    let entry!: ReplayEntry;
    const response = this.dispatch(request).finally(() => { entry.completed = true; });
    entry = { completed: false, fingerprint, response };
    this.replay.set(request.requestId, entry);
    return response;
  }

  private trimReplay(): void {
    while (this.replay.size >= this.maxReplayEntries) {
      const completed = [...this.replay].find(([, entry]) => entry.completed);
      if (!completed) return;
      this.replay.delete(completed[0]);
    }
  }

  private observeCloseRequest(): void {
    if (this.closeRequestObserved) return;
    this.closeRequestObserved = true;
    this.resolveCloseRequested();
  }

  private recordFailure(error: Error): void {
    if (this.failureValue) return;
    this.failureValue = error;
    for (const resolve of this.failureWaiters.splice(0)) resolve(error);
  }

  private async dispatch(
    request: ProviderSessionSupervisorTransportRequest,
  ): Promise<ProviderSessionSupervisorTransportResponse> {
    try {
      let result: ProviderSessionSupervisorTransportResult;
      if (request.method === 'attach') {
        throw new ProviderSessionSupervisorError(
          'conflict',
          'Provider session attachments are not replayable',
        );
      } else if (request.method === 'capabilities') {
        result = await this.options.supervisor.capabilities();
      } else if (request.method === 'launch') {
        result = await this.options.supervisor.launch(request.params as never);
      } else if (request.method === 'stop') {
        result = await this.options.supervisor.stop(request.params as never);
      } else {
        await this.options.supervisor.close();
        result = Object.freeze({ closed: true });
      }
      return Object.freeze({
        schemaVersion: PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
        ok: true,
        requestId: request.requestId,
        result,
      });
    } catch (error) {
      const code = error instanceof ProviderSessionSupervisorError
        ? error.code
        : request.method === 'close' ? 'teardown-failed' : 'unavailable';
      return failure(request.requestId, code);
    }
  }
}
