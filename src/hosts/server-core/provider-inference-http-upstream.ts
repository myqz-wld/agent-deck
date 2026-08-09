import {
  PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION,
  PROVIDER_INFERENCE_MAX_RESPONSE_BYTES,
  parseProviderInferenceBrokerRequest,
  parseProviderInferenceBrokerResponse,
  type ProviderSessionAdapterId,
} from '@contracts/index';

import type {
  ServerCoreProviderInferenceUpstreamInput,
  ServerCoreProviderInferenceUpstreamPort,
  ServerCoreProviderInferenceUpstreamTarget,
} from './provider-inference-broker-port';
import type { ServerCoreProviderCredentialInjectorPort } from './provider-inference-credential';

export interface ServerCoreProviderHttpRoute {
  readonly adapterId: ProviderSessionAdapterId;
  readonly origin: string;
  readonly paths: readonly string[];
  readonly providerId: string;
  readonly upstreamId: string;
}

export interface ServerCoreProviderHttpUpstreamOptions {
  readonly credentials: ServerCoreProviderCredentialInjectorPort;
  readonly fetch?: typeof fetch;
  readonly routes: readonly ServerCoreProviderHttpRoute[];
}

interface ParsedRoute extends Omit<ServerCoreProviderHttpRoute, 'origin' | 'paths'> {
  readonly origin: URL;
  readonly paths: ReadonlySet<string>;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const MAX_ROUTES = 16;
const MAX_PATHS_PER_ROUTE = 16;

function token(value: string, field: string): string {
  if (!TOKEN.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function path(value: string): string {
  return parseProviderInferenceBrokerRequest({
    schemaVersion: PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION,
    body: {},
    deadlineMs: 1_000,
    method: 'POST',
    path: value,
    requestId: 'route-validation',
  }).path;
}

function route(value: ServerCoreProviderHttpRoute): ParsedRoute {
  const origin = new URL(value.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' ||
      origin.search || origin.hash || value.paths.length < 1 ||
      value.paths.length > MAX_PATHS_PER_ROUTE) {
    throw new Error('provider inference route is invalid');
  }
  const paths = value.paths.map(path);
  if (new Set(paths).size !== paths.length) {
    throw new Error('provider inference route paths are not unique');
  }
  return Object.freeze({
    adapterId: value.adapterId,
    origin,
    paths: new Set(paths),
    providerId: token(value.providerId, 'provider inference route provider'),
    upstreamId: token(value.upstreamId, 'provider inference route upstream'),
  });
}

function routeKeys(value: ParsedRoute): readonly string[] {
  return [...value.paths].map((path) =>
    [value.adapterId, value.providerId, value.upstreamId, path].join('\0'));
}

function contentType(value: string | null): 'application/json' | 'text/event-stream' {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json' && mediaType !== 'text/event-stream') {
    throw new Error('provider inference upstream content type is invalid');
  }
  return mediaType;
}

async function boundedBody(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) ||
      Number(declared) > PROVIDER_INFERENCE_MAX_RESPONSE_BYTES)) {
    throw new Error('provider inference upstream response exceeded its bound');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > PROVIDER_INFERENCE_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('provider inference upstream response exceeded its bound');
      }
      chunks.push(Buffer.from(next.value));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    reader.releaseLock();
  }
}

/** Trusted HTTPS egress. Credentials exist only in the transient fetch Headers instance. */
export class ServerCoreProviderHttpUpstream implements ServerCoreProviderInferenceUpstreamPort {
  private readonly fetch: typeof fetch;
  private readonly routes: readonly ParsedRoute[];

  constructor(private readonly options: ServerCoreProviderHttpUpstreamOptions) {
    if (options.routes.length < 1 || options.routes.length > MAX_ROUTES) {
      throw new Error('provider inference route catalog is invalid');
    }
    this.routes = Object.freeze(options.routes.map(route));
    const keys = this.routes.flatMap(routeKeys);
    if (new Set(keys).size !== keys.length) {
      throw new Error('provider inference route identities are not unique');
    }
    this.fetch = options.fetch ?? fetch;
  }

  async isAvailable(target: ServerCoreProviderInferenceUpstreamTarget): Promise<boolean> {
    try {
      this.requireRoute(target);
      return await this.options.credentials.isAvailable(target);
    } catch {
      return false;
    }
  }

  async invoke(input: ServerCoreProviderInferenceUpstreamInput) {
    const selected = this.requireRoute(input);
    const target = this.target(input);
    const headers = new Headers({
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    });
    await this.options.credentials.inject(target, headers);
    const body = JSON.stringify(input.body);
    let operation: Promise<Response>;
    try {
      operation = this.fetch(new URL(input.path, selected.origin), {
        body,
        cache: 'no-store',
        credentials: 'omit',
        headers,
        method: 'POST',
        redirect: 'manual',
        referrerPolicy: 'no-referrer',
        signal: input.signal,
      });
    } finally {
      headers.delete('authorization');
    }
    const response = await operation;
    return parseProviderInferenceBrokerResponse({
      schemaVersion: PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION,
      body: await boundedBody(response),
      contentType: contentType(response.headers.get('content-type')),
      requestId: input.requestId,
      statusCode: response.status,
    });
  }

  private requireRoute(target: ServerCoreProviderInferenceUpstreamTarget): ParsedRoute {
    const selected = this.routes.find((candidate) =>
      candidate.adapterId === target.adapterId && candidate.providerId === target.providerId &&
      candidate.upstreamId === target.upstreamId && candidate.paths.has(target.path));
    if (!selected || target.method !== 'POST') {
      throw new Error('provider inference upstream route was rejected');
    }
    return selected;
  }

  private target(
    input: ServerCoreProviderInferenceUpstreamInput,
  ): ServerCoreProviderInferenceUpstreamTarget {
    return Object.freeze({
      adapterId: input.adapterId,
      instanceId: input.instanceId,
      method: input.method,
      path: input.path,
      processId: input.processId,
      providerId: input.providerId,
      sessionId: input.sessionId,
      upstreamId: input.upstreamId,
    });
  }
}
