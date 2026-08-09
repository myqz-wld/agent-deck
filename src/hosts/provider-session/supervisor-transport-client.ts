import { createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { isAbsolute, normalize } from 'node:path';
import { Duplex } from 'node:stream';

import type {
  ProviderSessionAttachSpec,
  ProviderSessionLaunchResult,
  ProviderSessionLaunchSpec,
  ProviderSessionStopResult,
  ProviderSessionStopSpec,
  ProviderSessionSupervisorCapabilities,
} from '@contracts/index';

import {
  ProviderSessionSupervisorError,
  type ProviderSessionControlChannel,
  type ProviderSessionSupervisorControlPort,
} from './supervisor-port';
import {
  PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
  parseProviderSessionSupervisorAttachReady,
  parseProviderSessionSupervisorTransportRequest,
  parseProviderSessionSupervisorTransportResponse,
  type ProviderSessionSupervisorTransportMethod,
  type ProviderSessionSupervisorTransportParams,
  type ProviderSessionSupervisorTransportRequest,
  type ProviderSessionSupervisorTransportResult,
} from './supervisor-transport-contract';
import {
  readProviderSessionSupervisorFrame,
  writeProviderSessionSupervisorFrame,
} from './supervisor-transport-frame';

export interface ProviderSessionSupervisorTransportClientOptions {
  readonly connect?: () => Duplex;
  readonly nextRequestId?: () => string;
  readonly requestTimeoutMs?: number;
  readonly socketPath: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

function socketPath(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || value === '/' ||
      value.includes('\0') || Buffer.byteLength(value) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error('provider supervisor transport socket path is invalid');
  }
  return value;
}

function transportFailure(): ProviderSessionSupervisorError {
  return new ProviderSessionSupervisorError(
    'unavailable',
    'Provider session supervisor transport is unavailable',
  );
}

function stopRequestId(spec: ProviderSessionStopSpec): string {
  const digest = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  return `stop:${digest}`;
}

/** Core-side client. Engine, image, mount, environment, and host paths never enter its API. */
export class ProviderSessionSupervisorTransportClient implements ProviderSessionSupervisorControlPort {
  private readonly connect: () => Duplex;
  private readonly nextRequestId: () => string;
  private readonly requestTimeoutMs: number;
  private closed = false;

  constructor(options: ProviderSessionSupervisorTransportClientOptions) {
    const path = socketPath(options.socketPath);
    this.connect = options.connect ?? (() => createConnection(path));
    this.nextRequestId = options.nextRequestId ?? randomUUID;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1 ||
        this.requestTimeoutMs > 600_000) {
      throw new Error('provider supervisor transport request timeout is invalid');
    }
  }

  capabilities(): Promise<ProviderSessionSupervisorCapabilities> {
    return this.call('capabilities', null, `capabilities:${this.nextRequestId()}`)
      .then((result) => result as ProviderSessionSupervisorCapabilities);
  }

  launch(spec: ProviderSessionLaunchSpec): Promise<ProviderSessionLaunchResult> {
    return this.call('launch', spec, `launch:${spec.launchId}`)
      .then((result) => result as ProviderSessionLaunchResult);
  }

  stop(spec: ProviderSessionStopSpec): Promise<ProviderSessionStopResult> {
    return this.call('stop', spec, stopRequestId(spec))
      .then((result) => result as ProviderSessionStopResult);
  }

  async attach(spec: ProviderSessionAttachSpec): Promise<ProviderSessionControlChannel> {
    if (this.closed) {
      throw new ProviderSessionSupervisorError('closed', 'Provider session supervisor is closed');
    }
    const digest = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
    const request = parseProviderSessionSupervisorTransportRequest({
      schemaVersion: PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
      method: 'attach',
      params: spec,
      requestId: `attach:${digest}`,
    });
    let stream: Duplex | null = null;
    try {
      stream = this.connect();
      await writeProviderSessionSupervisorFrame(stream, request);
      const raw = await readProviderSessionSupervisorFrame(stream, this.requestTimeoutMs);
      const response = parseProviderSessionSupervisorTransportResponse(
        raw,
        request.method,
        request.requestId,
      );
      if (!response.ok) {
        throw new ProviderSessionSupervisorError(response.error.code, response.error.message);
      }
      const ready = parseProviderSessionSupervisorAttachReady({
        schemaVersion: PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
        ready: true,
        requestId: request.requestId,
      }, request.requestId);
      await writeProviderSessionSupervisorFrame(stream, ready);
    } catch (error) {
      stream?.destroy();
      if (error instanceof ProviderSessionSupervisorError) throw error;
      throw transportFailure();
    }
    if (!stream) throw transportFailure();
    // The frame decoder intentionally leaves the raw socket paused. Duplex.from installs a real
    // downstream reader before resuming it, so an eager first ACP frame is buffered, not discarded.
    const channelStream = Duplex.from({ readable: stream, writable: stream });
    // Duplexify reports an intentional close as AbortError. Consumers may still observe errors,
    // while this listener prevents an unhandled process-level exception before one is installed.
    channelStream.on('error', () => undefined);
    let closed = false;
    const exited = new Promise<{ code: null; signal: null }>((resolve) => {
      const finish = (): void => resolve(Object.freeze({ code: null, signal: null }));
      stream.once('close', finish);
      stream.once('end', finish);
      stream.once('error', finish);
    });
    return Object.freeze({
      exited,
      stream: channelStream,
      close: async () => {
        if (closed) return;
        closed = true;
        channelStream.destroy();
        stream.destroy();
        await exited;
      },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.call('close', null, `close:${this.nextRequestId()}`);
    this.closed = true;
  }

  private async call(
    method: ProviderSessionSupervisorTransportMethod,
    params: ProviderSessionSupervisorTransportParams,
    requestId: string,
  ): Promise<ProviderSessionSupervisorTransportResult> {
    if (this.closed) {
      throw new ProviderSessionSupervisorError('closed', 'Provider session supervisor is closed');
    }
    const request = parseProviderSessionSupervisorTransportRequest({
      schemaVersion: PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
      method,
      params,
      requestId,
    });
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.exchange(request);
      } catch (error) {
        if (error instanceof ProviderSessionSupervisorError) throw error;
        lastError = error;
      }
    }
    void lastError;
    throw transportFailure();
  }

  private async exchange(
    request: ProviderSessionSupervisorTransportRequest,
  ): Promise<ProviderSessionSupervisorTransportResult> {
    let stream: Duplex;
    try {
      stream = this.connect();
    } catch {
      throw transportFailure();
    }
    try {
      await writeProviderSessionSupervisorFrame(stream, request);
      const raw = await readProviderSessionSupervisorFrame(stream, this.requestTimeoutMs);
      const response = parseProviderSessionSupervisorTransportResponse(
        raw,
        request.method,
        request.requestId,
      );
      if (!response.ok) {
        throw new ProviderSessionSupervisorError(response.error.code, response.error.message);
      }
      return response.result;
    } finally {
      stream.destroy();
    }
  }
}
