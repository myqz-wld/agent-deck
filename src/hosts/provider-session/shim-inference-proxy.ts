import { randomUUID } from 'node:crypto';
import {
  createServer,
  request as requestHttp,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { isAbsolute, normalize } from 'node:path';

import {
  PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION,
  PROVIDER_INFERENCE_MAX_REQUEST_BYTES,
  PROVIDER_INFERENCE_MAX_RESPONSE_BYTES,
  parseProviderInferenceBrokerRequest,
  parseProviderInferenceBrokerResponse,
  type ProviderInferenceBrokerRequest,
  type ProviderInferenceBrokerResponse,
} from '@contracts/index';

export interface ProviderSessionShimInferenceProxyOptions {
  readonly brokerSocketPath?: string;
  readonly deadlineMs?: number;
  readonly invoke?: ProviderSessionShimInferenceInvoke;
  /** Fixed non-secret model ids served locally; no discovery request reaches trusted egress. */
  readonly localModelIds?: readonly string[];
  readonly maxConcurrent?: number;
  readonly nextRequestId?: () => string;
  readonly onFailure?: (failure: ProviderSessionShimInferenceFailure) => void;
  /** Small exact Core-authorized route set for this Provider session profile. */
  readonly upstreamPaths: readonly string[];
}

export interface ProviderSessionShimInferenceFailure {
  readonly path: string;
  readonly reason: string;
}

export type ProviderSessionShimInferenceInvoke = (
  request: ProviderInferenceBrokerRequest,
  signal: AbortSignal,
) => Promise<ProviderInferenceBrokerResponse>;

const MAX_DEADLINE_MS = 120_000;
const DEFAULT_DEADLINE_MS = 115_000;
const MAX_HEADER_BYTES = 8 * 1024;
const CONTENT_TYPES = new Set(['application/json', 'text/event-stream']);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function socketPath(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || value === '/' ||
      value.includes('\0') || Buffer.byteLength(value) > 103) {
    throw new Error('provider shim broker socket path is invalid');
  }
  return value;
}

function contentType(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const selected = value.split(';', 1)[0]!.trim().toLowerCase();
  return CONTENT_TYPES.has(selected) ? selected : null;
}

async function readBody(request: IncomingMessage): Promise<{
  readonly bytes: Buffer;
  readonly value: Record<string, unknown>;
}> {
  const declared = request.headers['content-length'];
  if (typeof declared !== 'string' || !/^(?:0|[1-9][0-9]{0,7})$/.test(declared)) {
    throw new Error('provider shim request length is invalid');
  }
  const expected = Number(declared);
  if (expected < 2 || expected > PROVIDER_INFERENCE_MAX_REQUEST_BYTES) {
    throw new Error('provider shim request length exceeded its bound');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new Error('provider shim request body is invalid');
    bytes += chunk.byteLength;
    if (bytes > expected) throw new Error('provider shim request body exceeded its declaration');
    chunks.push(Buffer.from(chunk));
  }
  if (bytes !== expected) throw new Error('provider shim request body length changed');
  const body = Buffer.concat(chunks);
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body is not an object');
    }
    return Object.freeze({ bytes: body, value: parsed as Record<string, unknown> });
  } catch {
    throw new Error('provider shim request body is invalid');
  }
}

async function readResponse(response: IncomingMessage): Promise<{
  readonly body: Buffer;
  readonly contentType: string;
  readonly statusCode: number;
}> {
  const selectedType = contentType(response.headers['content-type']);
  const statusCode = response.statusCode ?? 0;
  const declared = response.headers['content-length'];
  if (!selectedType || statusCode < 100 || statusCode > 599 ||
      typeof declared !== 'string' || !/^(?:0|[1-9][0-9]{0,8})$/.test(declared) ||
      Number(declared) > PROVIDER_INFERENCE_MAX_RESPONSE_BYTES) {
    throw new Error('provider shim broker response is invalid');
  }
  const expected = Number(declared);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    if (!Buffer.isBuffer(chunk)) throw new Error('provider shim broker body is invalid');
    bytes += chunk.byteLength;
    if (bytes > expected || bytes > PROVIDER_INFERENCE_MAX_RESPONSE_BYTES) {
      throw new Error('provider shim broker body exceeded its bound');
    }
    chunks.push(Buffer.from(chunk));
  }
  if (bytes !== expected) throw new Error('provider shim broker body length changed');
  return Object.freeze({ body: Buffer.concat(chunks), contentType: selectedType, statusCode });
}

function sendFailure(response: ServerResponse): void {
  if (response.destroyed || response.headersSent) return;
  const body = Buffer.from('{"error":"provider_session_broker_unavailable"}', 'utf8');
  response.writeHead(502, {
    connection: 'close',
    'content-length': body.byteLength,
    'content-type': 'application/json',
  });
  response.end(body);
}

/** Container-local loopback bridge. No inbound credential or cookie is forwarded to Core. */
export class ProviderSessionShimInferenceProxy {
  private readonly brokerSocketPath: string | null;
  private readonly deadlineMs: number;
  private readonly invoke: ProviderSessionShimInferenceInvoke | null;
  private readonly localModelsBody: Buffer | null;
  private readonly maxConcurrent: number;
  private readonly nextRequestId: () => string;
  private readonly onFailure: (failure: ProviderSessionShimInferenceFailure) => void;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly upstreamPaths: ReadonlySet<string>;
  private active = 0;
  private baseUrlValue: string | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: ProviderSessionShimInferenceProxyOptions) {
    if ((typeof options.brokerSocketPath === 'string') === (typeof options.invoke === 'function')) {
      throw new Error('provider shim inference transport is invalid');
    }
    this.brokerSocketPath = options.brokerSocketPath
      ? socketPath(options.brokerSocketPath)
      : null;
    this.invoke = options.invoke ?? null;
    const localModelIds = options.localModelIds ?? [];
    if (localModelIds.length > 8 || new Set(localModelIds).size !== localModelIds.length ||
        localModelIds.some((id) => !MODEL_ID.test(id))) {
      throw new Error('provider shim local model catalog is invalid');
    }
    this.localModelsBody = localModelIds.length === 0 ? null : Buffer.from(JSON.stringify({
      data: localModelIds.map((id) => ({ created: 0, id, object: 'model', owned_by: 'xai' })),
      object: 'list',
    }), 'utf8');
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.nextRequestId = options.nextRequestId ?? randomUUID;
    this.onFailure = options.onFailure ?? (() => undefined);
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs < 1_000 ||
        this.deadlineMs > MAX_DEADLINE_MS || !Number.isSafeInteger(this.maxConcurrent) ||
        this.maxConcurrent < 1 || this.maxConcurrent > 8) {
      throw new Error('provider shim inference proxy limits are invalid');
    }
    if (options.upstreamPaths.length < 1 || options.upstreamPaths.length > 4) {
      throw new Error('provider shim inference routes are invalid');
    }
    const upstreamPaths = options.upstreamPaths.map((path, index) =>
      parseProviderInferenceBrokerRequest({
        schemaVersion: PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION,
        body: {},
        deadlineMs: this.deadlineMs,
        method: 'POST',
        path,
        requestId: `provider-shim-route-validation-${index}`,
      }).path);
    if (new Set(upstreamPaths).size !== upstreamPaths.length) {
      throw new Error('provider shim inference routes are invalid');
    }
    this.upstreamPaths = new Set(upstreamPaths);
    this.server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
      void this.handle(request, response);
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.on('clientError', (_error, socket) => socket.destroy());
  }

  get baseUrl(): string {
    if (!this.baseUrlValue) throw new Error('provider shim inference proxy is not started');
    return this.baseUrlValue;
  }

  async start(): Promise<void> {
    if (this.baseUrlValue) return;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => reject(error);
      this.server.once('error', fail);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', fail);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
      await this.close();
      throw new Error('provider shim inference proxy address is invalid');
    }
    this.baseUrlValue = `http://127.0.0.1:${address.port}/v1`;
  }

  close(): Promise<void> {
    this.closePromise ??= new Promise<void>((resolve, reject) => {
      this.baseUrlValue = null;
      for (const socket of this.sockets) socket.destroy();
      this.server.close((error) => error ? reject(error) : resolve());
    });
    return this.closePromise;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.shouldKeepAlive = false;
    if (request.method === 'GET' && request.url === '/v1/models' && this.localModelsBody) {
      response.writeHead(200, {
        connection: 'close',
        'content-length': this.localModelsBody.byteLength,
        'content-type': 'application/json',
      });
      response.end(this.localModelsBody);
      return;
    }
    if (this.active >= this.maxConcurrent) {
      response.writeHead(429, { connection: 'close', 'content-length': 0 });
      response.end();
      return;
    }
    this.active += 1;
    try {
      if (request.method !== 'POST' || !this.upstreamPaths.has(request.url ?? '') ||
          contentType(request.headers['content-type']) !== 'application/json') {
        throw new Error('provider shim inference route is invalid');
      }
      const body = await readBody(request);
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      request.once('aborted', abort);
      request.socket.once('close', abort);
      const brokerResponse = await this.forward(
        request.url!, body.bytes, body.value, controller.signal,
      )
        .finally(() => {
          request.removeListener('aborted', abort);
          request.socket.removeListener('close', abort);
        });
      response.writeHead(brokerResponse.statusCode, {
        connection: 'close',
        'content-length': brokerResponse.body.byteLength,
        'content-type': brokerResponse.contentType,
      });
      response.end(brokerResponse.body);
    } catch (error) {
      try {
        this.onFailure(Object.freeze({
          path: request.url ?? '',
          reason: error instanceof Error ? error.message : 'provider inference proxy failed',
        }));
      } catch {}
      sendFailure(response);
    } finally {
      this.active -= 1;
    }
  }

  private forward(
    path: string,
    body: Buffer,
    value: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof readResponse>>> {
    const requestId = this.nextRequestId();
    const brokerRequest = parseProviderInferenceBrokerRequest({
      schemaVersion: PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION,
      body: value,
      deadlineMs: this.deadlineMs,
      method: 'POST',
      path,
      requestId,
    });
    if (this.invoke) {
      return this.invoke(brokerRequest, signal).then((value) => {
        const response = parseProviderInferenceBrokerResponse(value);
        if (response.requestId !== requestId) {
          throw new Error('provider shim broker response identity changed');
        }
        return Object.freeze({
          body: Buffer.from(response.body, 'utf8'),
          contentType: response.contentType,
          statusCode: response.statusCode,
        });
      });
    }
    return new Promise((resolve, reject) => {
      const upstream = requestHttp({
        headers: {
          accept: 'application/json, text/event-stream',
          connection: 'close',
          'content-length': body.byteLength,
          'content-type': 'application/json',
          host: 'agent-deck-inference',
          'x-agent-deck-deadline-ms': String(this.deadlineMs),
          'x-agent-deck-request-id': requestId,
        },
        method: 'POST',
        path,
        socketPath: this.brokerSocketPath!,
      }, (response) => void readResponse(response).then(resolve, reject));
      const abort = (): void => {
        upstream.destroy(new Error('provider shim broker request was cancelled'));
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      upstream.once('error', reject);
      upstream.once('close', () => signal.removeEventListener('abort', abort));
      upstream.setTimeout(this.deadlineMs, () => upstream.destroy(
        new Error('provider shim broker request timed out'),
      ));
      upstream.end(body);
    });
  }
}
