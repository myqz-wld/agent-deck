import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAbsolute, normalize } from 'node:path';
import type { Duplex } from 'node:stream';

import {
  PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION,
  PROVIDER_INFERENCE_MAX_REQUEST_BYTES,
  parseProviderInferenceBrokerRequest,
  type ProviderInferenceBrokerRequest,
  type ProviderInferenceBrokerResponse,
} from '@contracts/index';
import { UnixSocketDaemonListener, type DaemonListener } from '@hosts/daemon';
import { providerSessionBrokerSocketPath } from '@hosts/provider-session/broker-socket-path';

import {
  ServerCoreProviderInferenceError,
  type ServerCoreProviderInferenceBinding,
  type ServerCoreProviderInferenceBrokerPort,
  type ServerCoreProviderInferenceEndpoint,
  type ServerCoreProviderInferencePeer,
} from './provider-inference-broker-port';
import { parseServerCoreProviderInferenceBinding } from './provider-inference-broker';

export interface ServerCoreProviderInferenceUnixHttpOptions {
  readonly broker: ServerCoreProviderInferenceBrokerPort;
  readonly brokerRoot: string;
  readonly currentUid?: () => number;
  readonly listener?: (socketPath: string, brokerRoot: string) => DaemonListener;
  readonly maxConnectionsPerEndpoint?: number;
}

export interface ServerCoreProviderInferenceUnixHttpPort {
  available(binding: ServerCoreProviderInferenceBinding): Promise<boolean>;
  open(binding: ServerCoreProviderInferenceBinding): Promise<ServerCoreProviderInferenceEndpoint>;
  invoke(
    endpointId: string,
    request: ProviderInferenceBrokerRequest,
    signal: AbortSignal,
  ): Promise<ProviderInferenceBrokerResponse>;
  release(endpointId: string): Promise<void>;
  releaseSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

interface RootIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
}
interface EndpointRecord {
  readonly binding: ServerCoreProviderInferenceBinding;
  readonly connections: Set<Duplex>;
  readonly endpointId: string;
  readonly http: ReturnType<typeof createServer>;
  readonly listener: DaemonListener;
  readonly socketPath: string;
  cleanupComplete: boolean;
  closePromise: Promise<void> | null;
  closed: boolean;
}

const MAX_HEADER_BYTES = 8 * 1024;
const MAX_CONNECTIONS_PER_ENDPOINT = 8;
const REQUEST_BODY_TIMEOUT_MS = 5_000;
const ALLOWED_HEADERS = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'host',
  'x-agent-deck-deadline-ms',
  'x-agent-deck-request-id',
]);

function rootIdentity(stat: Stats): RootIdentity {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777, uid: stat.uid };
}

function sameRoot(left: RootIdentity, right: RootIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid;
}

function requireBrokerRoot(path: string, uid: number): RootIdentity {
  if (!isAbsolute(path) || normalize(path) !== path || path === '/' || path.includes('\0')) {
    throw new Error('provider inference broker root is invalid');
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path ||
      stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
    throw new Error('provider inference broker root is not private');
  }
  return rootIdentity(stat);
}

function integerHeader(value: string | string[] | undefined, field: string): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} is invalid`);
  return parsed;
}

function stringHeader(value: string | string[] | undefined, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is invalid`);
  return value;
}

function validateHeaders(request: IncomingMessage): void {
  const names = request.rawHeaders.filter((_, index) => index % 2 === 0)
    .map((name) => name.toLowerCase());
  if (new Set(names).size !== names.length || names.some((name) => !ALLOWED_HEADERS.has(name)) ||
      request.headers['content-type'] !== 'application/json') {
    throw new Error('provider inference HTTP headers were rejected');
  }
}

function readBody(request: IncomingMessage, expectedBytes: number): Promise<Record<string, unknown>> {
  if (expectedBytes < 2 || expectedBytes > PROVIDER_INFERENCE_MAX_REQUEST_BYTES) {
    throw new Error('provider inference HTTP body exceeded its bound');
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('provider inference HTTP body timed out')),
      REQUEST_BODY_TIMEOUT_MS);
    timer.unref();
    const cleanup = (): void => {
      clearTimeout(timer);
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('aborted', onAborted);
      request.removeListener('error', onError);
    };
    const finish = (error?: Error, value?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value!);
    };
    const onData = (chunk: unknown): void => {
      if (!Buffer.isBuffer(chunk)) {
        finish(new Error('provider inference HTTP body was not bytes'));
        return;
      }
      bytes += chunk.byteLength;
      if (bytes > expectedBytes) {
        finish(new Error('provider inference HTTP body exceeded its declared length'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = (): void => {
      if (bytes !== expectedBytes) {
        finish(new Error('provider inference HTTP body length changed'));
        return;
      }
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const parsed = JSON.parse(decoded) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('body is not an object');
        }
        finish(undefined, parsed as Record<string, unknown>);
      } catch {
        finish(new Error('provider inference HTTP body is invalid'));
      }
    };
    const onAborted = (): void => finish(new Error('provider inference HTTP body was aborted'));
    const onError = (): void => finish(new Error('provider inference HTTP body failed'));
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
  });
}

function status(code: ServerCoreProviderInferenceError['code']): number {
  if (code === 'access-denied') return 403;
  if (code === 'limit') return 429;
  if (code === 'deadline') return 504;
  if (code === 'response-invalid') return 502;
  return 503;
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.destroyed || response.headersSent) return;
  const code = error instanceof ServerCoreProviderInferenceError
    ? error.code
    : 'access-denied';
  const body = JSON.stringify({ error: `provider_inference_${code.replaceAll('-', '_')}` });
  response.statusCode = status(code);
  response.setHeader('connection', 'close');
  response.setHeader('content-type', 'application/json');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

function sendResult(response: ServerResponse, result: ProviderInferenceBrokerResponse): void {
  response.statusCode = result.statusCode;
  response.setHeader('connection', 'close');
  response.setHeader('content-type', result.contentType);
  response.setHeader('content-length', Buffer.byteLength(result.body));
  response.setHeader('x-agent-deck-request-id', result.requestId);
  response.end(result.body);
}

/** One private Unix HTTP socket per broker endpoint; HTTP identity fields never come from the body. */
export class ServerCoreProviderInferenceUnixHttp
implements ServerCoreProviderInferenceUnixHttpPort {
  private readonly brokerRootIdentity: RootIdentity;
  private readonly currentUid: number;
  private readonly endpoints = new Map<string, EndpointRecord>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly listener: (socketPath: string, brokerRoot: string) => DaemonListener;
  private readonly maxConnectionsPerEndpoint: number;
  private brokerClosed = false;
  private cleanupComplete = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private failureValue: Error | null = null;

  constructor(private readonly options: ServerCoreProviderInferenceUnixHttpOptions) {
    this.currentUid = (options.currentUid ?? (() => {
      if (typeof process.getuid !== 'function') return -1;
      return process.getuid();
    }))();
    if (!Number.isSafeInteger(this.currentUid) || this.currentUid < 0) {
      throw new Error('provider inference broker owner is invalid');
    }
    this.brokerRootIdentity = requireBrokerRoot(options.brokerRoot, this.currentUid);
    providerSessionBrokerSocketPath(options.brokerRoot, 'path-validation');
    this.listener = options.listener ?? ((path, root) => new UnixSocketDaemonListener(path, root));
    this.maxConnectionsPerEndpoint = options.maxConnectionsPerEndpoint ??
      MAX_CONNECTIONS_PER_ENDPOINT;
    if (!Number.isSafeInteger(this.maxConnectionsPerEndpoint) ||
        this.maxConnectionsPerEndpoint < 1 || this.maxConnectionsPerEndpoint > 32) {
      throw new Error('provider inference HTTP connection limit is invalid');
    }
  }

  get failure(): Error | null {
    return this.failureValue;
  }

  async available(value: ServerCoreProviderInferenceBinding): Promise<boolean> {
    if (this.closed) return false;
    try {
      this.assertBrokerRoot();
      return await this.options.broker.available(parseServerCoreProviderInferenceBinding(value));
    } catch {
      return false;
    }
  }

  async open(value: ServerCoreProviderInferenceBinding): Promise<ServerCoreProviderInferenceEndpoint> {
    if (this.closed) throw new ServerCoreProviderInferenceError('closed', 'Broker endpoint is closed');
    this.assertBrokerRoot();
    const binding = parseServerCoreProviderInferenceBinding(value);
    const finish = this.beginOperation();
    let endpoint: ServerCoreProviderInferenceEndpoint | null = null;
    let record: EndpointRecord | null = null;
    try {
      endpoint = await this.options.broker.open(binding);
      const socketPath = providerSessionBrokerSocketPath(
        this.options.brokerRoot,
        endpoint.endpointId,
      );
      const listener = this.listener(socketPath, this.options.brokerRoot);
      const http = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
        void this.handle(record!, request, response);
      });
      http.on('clientError', (_error, socket) => socket.destroy());
      record = {
        binding,
        cleanupComplete: false,
        closePromise: null,
        closed: false,
        connections: new Set(),
        endpointId: endpoint.endpointId,
        http,
        listener,
        socketPath,
      };
      this.endpoints.set(endpoint.endpointId, record);
      await listener.start(
        (stream) => this.accept(record!, stream),
        (error) => {
          this.failureValue ??= error;
          void this.release(endpoint!.endpointId).catch(() => undefined);
        },
      );
      this.assertBrokerRoot();
      if (this.closed) throw new ServerCoreProviderInferenceError('closed', 'Broker endpoint is closed');
      return endpoint;
    } catch (error) {
      if (record) {
        await this.closeEndpoint(record).catch(() => undefined);
      }
      else if (endpoint) this.options.broker.release(endpoint.endpointId);
      throw error;
    } finally {
      finish();
    }
  }

  async release(endpointId: string): Promise<void> {
    const record = this.endpoints.get(endpointId);
    if (!record) {
      this.options.broker.release(endpointId);
      return;
    }
    await this.closeEndpoint(record);
  }

  async releaseSession(sessionId: string): Promise<void> {
    const records = [...this.endpoints.values()]
      .filter((record) => record.binding.sessionId === sessionId);
    await Promise.all(records.map((record) => this.release(record.endpointId)));
    this.options.broker.releaseSession(sessionId);
  }

  async invoke(
    endpointId: string,
    value: ProviderInferenceBrokerRequest,
    signal: AbortSignal,
  ): Promise<ProviderInferenceBrokerResponse> {
    if (this.closed) throw new ServerCoreProviderInferenceError('closed', 'Broker endpoint is closed');
    this.assertBrokerRoot();
    const record = this.endpoints.get(endpointId);
    const request = parseProviderInferenceBrokerRequest(value);
    if (!record || record.closed || request.method !== record.binding.method ||
        !record.binding.paths.includes(request.path)) {
      throw new ServerCoreProviderInferenceError('access-denied', 'Broker endpoint was rejected');
    }
    const finish = this.beginOperation();
    try {
      if (this.closed || record.closed || signal.aborted) {
        throw new ServerCoreProviderInferenceError('closed', 'Broker endpoint is closed');
      }
      const peer: ServerCoreProviderInferencePeer = Object.freeze({
        adapterId: record.binding.adapterId,
        endpointId: record.endpointId,
        instanceId: record.binding.instanceId,
        processId: record.binding.processId,
        providerId: record.binding.providerId,
        sessionId: record.binding.sessionId,
        upstreamId: record.binding.upstreamId,
      });
      return await this.options.broker.invoke(peer, request, signal);
    } finally {
      finish();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const closing = this.closeOnce();
    this.closePromise = closing;
    void closing.catch(() => {
      if (this.closePromise === closing) this.closePromise = null;
    });
    return closing;
  }

  private async closeOnce(): Promise<void> {
    if (this.cleanupComplete) return;
    this.closed = true;
    const failures: unknown[] = [];
    const initialRecords = new Set(this.endpoints.values());
    await Promise.all([...initialRecords].map((record) =>
      this.closeEndpoint(record).catch((error) => failures.push(error))));
    await Promise.allSettled([...this.inFlight]);
    const lateRecords = [...this.endpoints.values()]
      .filter((record) => !initialRecords.has(record));
    await Promise.all(lateRecords.map((record) =>
      this.closeEndpoint(record).catch((error) => failures.push(error))));
    if (!this.brokerClosed) {
      try {
        this.options.broker.close();
        this.brokerClosed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 0 && this.endpoints.size > 0) {
      failures.push(new Error('Provider inference endpoint cleanup remained incomplete'));
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Provider inference Unix HTTP shutdown failed');
    }
    this.cleanupComplete = true;
  }

  private accept(record: EndpointRecord, stream: Duplex): void {
    if (record.closed || record.connections.size >= this.maxConnectionsPerEndpoint) {
      stream.destroy();
      return;
    }
    record.connections.add(stream);
    stream.once('close', () => record.connections.delete(stream));
    record.http.emit('connection', stream);
  }

  private async handle(
    record: EndpointRecord,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.shouldKeepAlive = false;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.once('aborted', abort);
    request.socket.once('close', abort);
    try {
      if (record.closed || request.method !== 'POST' ||
          !record.binding.paths.includes(request.url ?? '')) {
        throw new ServerCoreProviderInferenceError('access-denied', 'HTTP route was rejected');
      }
      validateHeaders(request);
      const deadlineMs = integerHeader(
        request.headers['x-agent-deck-deadline-ms'],
        'provider inference deadline',
      );
      const requestId = stringHeader(
        request.headers['x-agent-deck-request-id'],
        'provider inference request id',
      );
      const body = await readBody(
        request,
        integerHeader(request.headers['content-length'], 'provider inference content length'),
      );
      const brokerRequest = parseProviderInferenceBrokerRequest({
        schemaVersion: PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION,
        body,
        deadlineMs,
        method: 'POST',
        path: request.url,
        requestId,
      });
      sendResult(response, await this.invoke(record.endpointId, brokerRequest, controller.signal));
    } catch (error) {
      sendError(response, error);
    } finally {
      request.removeListener('aborted', abort);
      request.socket.removeListener('close', abort);
    }
  }

  private async closeRecord(record: EndpointRecord): Promise<void> {
    if (record.cleanupComplete) return;
    record.closed = true;
    const failures: unknown[] = [];
    const listenerStop = record.listener.stop().catch((error) => failures.push(error));
    try { this.options.broker.release(record.endpointId); } catch (error) { failures.push(error); }
    for (const connection of record.connections) connection.destroy();
    await listenerStop;
    record.connections.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Provider inference endpoint cleanup failed');
    }
    record.cleanupComplete = true;
    if (this.endpoints.get(record.endpointId) === record) {
      this.endpoints.delete(record.endpointId);
    }
  }

  private closeEndpoint(record: EndpointRecord): Promise<void> {
    if (record.closePromise) return record.closePromise;
    const closing = this.closeRecord(record);
    record.closePromise = closing;
    void closing.catch(() => {
      if (record.closePromise === closing) record.closePromise = null;
    });
    return closing;
  }

  private assertBrokerRoot(): void {
    if (!sameRoot(
      this.brokerRootIdentity,
      requireBrokerRoot(this.options.brokerRoot, this.currentUid),
    )) throw new Error('provider inference broker root identity changed');
  }

  private beginOperation(): () => void {
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => { finish = resolve; });
    this.inFlight.add(operation);
    return () => {
      this.inFlight.delete(operation);
      finish();
    };
  }
}
