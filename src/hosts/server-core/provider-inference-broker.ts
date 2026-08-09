import { randomUUID } from 'node:crypto';

import {
  PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION,
  PROVIDER_INFERENCE_MAX_DEADLINE_MS,
  PROVIDER_INFERENCE_MAX_REQUEST_BYTES,
  PROVIDER_INFERENCE_MAX_RESPONSE_BYTES,
  PROVIDER_INFERENCE_MIN_DEADLINE_MS,
  PROVIDER_SESSION_ADAPTER_IDS,
  parseProviderInferenceBrokerRequest,
  parseProviderInferenceBrokerResponse,
  type ProviderSessionAdapterId,
} from '@contracts/index';

import {
  ServerCoreProviderInferenceError,
  type ServerCoreProviderInferenceBinding,
  type ServerCoreProviderInferenceBrokerPort,
  type ServerCoreProviderInferenceEndpoint,
  type ServerCoreProviderInferencePeer,
  type ServerCoreProviderInferenceUpstreamPort,
  type ServerCoreProviderInferenceUpstreamTarget,
} from './provider-inference-broker-port';

export const SERVER_CORE_PROVIDER_INFERENCE_MAX_ENDPOINTS = 128;
export const SERVER_CORE_PROVIDER_INFERENCE_MAX_GLOBAL_CONCURRENCY = 32;
export const SERVER_CORE_PROVIDER_INFERENCE_MAX_ENDPOINT_CONCURRENCY = 2;
export const SERVER_CORE_PROVIDER_INFERENCE_MAX_BINDING_PATHS = 4;

interface DeadlineWait {
  readonly promise: Promise<void>;
  cancel(): void;
}

export interface ServerCoreProviderInferenceDeadlinePort {
  wait(delayMs: number): DeadlineWait;
}

export interface ServerCoreProviderInferenceBrokerOptions {
  readonly upstream: ServerCoreProviderInferenceUpstreamPort;
  readonly deadlines?: ServerCoreProviderInferenceDeadlinePort;
  readonly maxEndpoints?: number;
  readonly maxGlobalConcurrency?: number;
  readonly nextEndpointId?: () => string;
}

interface EndpointEntry {
  readonly binding: ServerCoreProviderInferenceBinding;
  readonly controllers: Set<AbortController>;
  active: number;
  closed: boolean;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;

const SYSTEM_DEADLINES: ServerCoreProviderInferenceDeadlinePort = Object.freeze({
  wait(delayMs: number): DeadlineWait {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<void>((resolve) => { timer = setTimeout(resolve, delayMs); });
    return Object.freeze({
      promise,
      cancel: () => {
        if (timer) clearTimeout(timer);
        timer = null;
      },
    });
  },
});

function failure(
  code: ConstructorParameters<typeof ServerCoreProviderInferenceError>[0],
  message: string,
): ServerCoreProviderInferenceError {
  return new ServerCoreProviderInferenceError(code, message);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('access-denied', `${field} is invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw failure('access-denied', `${field} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw failure('access-denied', `${field} is invalid`);
  }
}

function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw failure('access-denied', `${field} is invalid`);
  }
  return value;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw failure('access-denied', `${field} is invalid`);
  }
  return value as number;
}

export function parseServerCoreProviderInferenceBinding(
  value: unknown,
): ServerCoreProviderInferenceBinding {
  const field = 'provider inference binding';
  const raw = object(value, field);
  exactKeys(raw, [
    'adapterId', 'instanceId', 'maxConcurrency', 'maxDeadlineMs', 'maxRequestBytes',
    'maxResponseBytes', 'method', 'paths', 'processId', 'providerId', 'sessionId',
    'upstreamId',
  ], field);
  if (!PROVIDER_SESSION_ADAPTER_IDS.includes(raw.adapterId as ProviderSessionAdapterId)) {
    throw failure('access-denied', `${field} adapter is invalid`);
  }
  const maxDeadlineMs = integer(
    raw.maxDeadlineMs,
    `${field} deadline`,
    PROVIDER_INFERENCE_MIN_DEADLINE_MS,
    PROVIDER_INFERENCE_MAX_DEADLINE_MS,
  );
  if (!Array.isArray(raw.paths) || raw.paths.length < 1 ||
      raw.paths.length > SERVER_CORE_PROVIDER_INFERENCE_MAX_BINDING_PATHS) {
    throw failure('access-denied', `${field} paths are invalid`);
  }
  const parsedPaths = raw.paths.map((path, index) => parseProviderInferenceBrokerRequest({
    schemaVersion: PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION,
    body: {},
    deadlineMs: maxDeadlineMs,
    method: raw.method,
    path,
    requestId: `binding-validation-${index}`,
  }).path);
  if (new Set(parsedPaths).size !== parsedPaths.length) {
    throw failure('access-denied', `${field} paths are invalid`);
  }
  return Object.freeze({
    adapterId: raw.adapterId as ProviderSessionAdapterId,
    instanceId: token(raw.instanceId, `${field} instance`),
    maxConcurrency: integer(
      raw.maxConcurrency,
      `${field} concurrency`,
      1,
      SERVER_CORE_PROVIDER_INFERENCE_MAX_ENDPOINT_CONCURRENCY,
    ),
    maxDeadlineMs,
    maxRequestBytes: integer(
      raw.maxRequestBytes,
      `${field} request bytes`,
      1,
      PROVIDER_INFERENCE_MAX_REQUEST_BYTES,
    ),
    maxResponseBytes: integer(
      raw.maxResponseBytes,
      `${field} response bytes`,
      1,
      PROVIDER_INFERENCE_MAX_RESPONSE_BYTES,
    ),
    method: 'POST',
    paths: Object.freeze(parsedPaths),
    processId: token(raw.processId, `${field} process`),
    providerId: token(raw.providerId, `${field} provider`),
    sessionId: token(raw.sessionId, `${field} session`),
    upstreamId: token(raw.upstreamId, `${field} upstream`),
  });
}

function parsePeer(value: unknown): ServerCoreProviderInferencePeer {
  const field = 'provider inference peer';
  const raw = object(value, field);
  exactKeys(raw, [
    'adapterId', 'endpointId', 'instanceId', 'processId', 'providerId', 'sessionId',
    'upstreamId',
  ], field);
  if (!PROVIDER_SESSION_ADAPTER_IDS.includes(raw.adapterId as ProviderSessionAdapterId)) {
    throw failure('access-denied', `${field} adapter is invalid`);
  }
  return Object.freeze({
    adapterId: raw.adapterId as ProviderSessionAdapterId,
    endpointId: token(raw.endpointId, `${field} endpoint`),
    instanceId: token(raw.instanceId, `${field} instance`),
    processId: token(raw.processId, `${field} process`),
    providerId: token(raw.providerId, `${field} provider`),
    sessionId: token(raw.sessionId, `${field} session`),
    upstreamId: token(raw.upstreamId, `${field} upstream`),
  });
}

function target(
  binding: ServerCoreProviderInferenceBinding,
  path = binding.paths[0]!,
): ServerCoreProviderInferenceUpstreamTarget {
  return Object.freeze({
    adapterId: binding.adapterId,
    instanceId: binding.instanceId,
    method: binding.method,
    path,
    processId: binding.processId,
    providerId: binding.providerId,
    sessionId: binding.sessionId,
    upstreamId: binding.upstreamId,
  });
}

function sameIdentity(
  binding: ServerCoreProviderInferenceBinding,
  peer: ServerCoreProviderInferencePeer,
): boolean {
  return binding.adapterId === peer.adapterId && binding.instanceId === peer.instanceId &&
    binding.processId === peer.processId && binding.providerId === peer.providerId &&
    binding.sessionId === peer.sessionId && binding.upstreamId === peer.upstreamId;
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export class ServerCoreProviderInferenceBroker implements ServerCoreProviderInferenceBrokerPort {
  private readonly deadlines: ServerCoreProviderInferenceDeadlinePort;
  private readonly endpoints = new Map<string, EndpointEntry>();
  private readonly identityKeys = new Set<string>();
  private readonly pendingIdentityKeys = new Set<string>();
  private readonly maxEndpoints: number;
  private readonly maxGlobalConcurrency: number;
  private readonly nextEndpointId: () => string;
  private active = 0;
  private closed = false;

  constructor(private readonly options: ServerCoreProviderInferenceBrokerOptions) {
    this.deadlines = options.deadlines ?? SYSTEM_DEADLINES;
    this.maxEndpoints = integer(
      options.maxEndpoints ?? SERVER_CORE_PROVIDER_INFERENCE_MAX_ENDPOINTS,
      'provider inference endpoint limit',
      1,
      SERVER_CORE_PROVIDER_INFERENCE_MAX_ENDPOINTS,
    );
    this.maxGlobalConcurrency = integer(
      options.maxGlobalConcurrency ?? SERVER_CORE_PROVIDER_INFERENCE_MAX_GLOBAL_CONCURRENCY,
      'provider inference global concurrency',
      1,
      SERVER_CORE_PROVIDER_INFERENCE_MAX_GLOBAL_CONCURRENCY,
    );
    this.nextEndpointId = options.nextEndpointId ?? randomUUID;
  }

  async available(value: ServerCoreProviderInferenceBinding): Promise<boolean> {
    if (this.closed) return false;
    let binding: ServerCoreProviderInferenceBinding;
    try {
      binding = parseServerCoreProviderInferenceBinding(value);
      for (const path of binding.paths) {
        if (!await this.options.upstream.isAvailable(target(binding, path))) return false;
      }
      return !this.closed;
    } catch {
      return false;
    }
  }

  async open(value: ServerCoreProviderInferenceBinding): Promise<ServerCoreProviderInferenceEndpoint> {
    if (this.closed) throw failure('closed', 'Provider inference broker is closed');
    const binding = parseServerCoreProviderInferenceBinding(value);
    if (this.endpoints.size + this.pendingIdentityKeys.size >= this.maxEndpoints) {
      throw failure('limit', 'Provider inference endpoint limit reached');
    }
    const identityKey = this.identityKey(binding);
    if (this.identityKeys.has(identityKey) || this.pendingIdentityKeys.has(identityKey)) {
      throw failure('conflict', 'Provider inference process identity is already active');
    }
    this.pendingIdentityKeys.add(identityKey);
    try {
      let available = false;
      try {
        available = true;
        for (const path of binding.paths) {
          if (!await this.options.upstream.isAvailable(target(binding, path))) {
            available = false;
            break;
          }
        }
      } catch {
        throw failure('unavailable', 'Provider inference upstream is unavailable');
      }
      if (this.closed) throw failure('closed', 'Provider inference broker is closed');
      if (!available) throw failure('unavailable', 'Provider inference upstream is unavailable');
      let endpointId = '';
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          endpointId = token(this.nextEndpointId(), 'provider inference endpoint');
        } catch {
          endpointId = '';
        }
        if (endpointId && !this.endpoints.has(endpointId)) break;
        endpointId = '';
      }
      if (!endpointId) throw failure('conflict', 'Provider inference endpoint identity collided');
      this.endpoints.set(endpointId, {
        active: 0,
        binding,
        closed: false,
        controllers: new Set(),
      });
      this.identityKeys.add(identityKey);
      return Object.freeze({ endpointId });
    } finally {
      this.pendingIdentityKeys.delete(identityKey);
    }
  }

  async invoke(
    peerValue: ServerCoreProviderInferencePeer,
    requestValue: Parameters<typeof parseProviderInferenceBrokerRequest>[0],
    externalSignal?: AbortSignal,
  ) {
    if (this.closed) throw failure('closed', 'Provider inference broker is closed');
    const peer = parsePeer(peerValue);
    const request = parseProviderInferenceBrokerRequest(requestValue);
    const entry = this.endpoints.get(peer.endpointId);
    if (!entry || entry.closed || !sameIdentity(entry.binding, peer)) {
      throw failure('access-denied', 'Provider inference peer identity was rejected');
    }
    if (request.method !== entry.binding.method || !entry.binding.paths.includes(request.path)) {
      throw failure('access-denied', 'Provider inference route was rejected');
    }
    if (request.deadlineMs > entry.binding.maxDeadlineMs ||
        bytes(JSON.stringify(request.body)) > entry.binding.maxRequestBytes) {
      throw failure('limit', 'Provider inference request exceeded its bound');
    }
    if (entry.active >= entry.binding.maxConcurrency || this.active >= this.maxGlobalConcurrency) {
      throw failure('limit', 'Provider inference concurrency limit reached');
    }
    if (externalSignal?.aborted) throw failure('cancelled', 'Provider inference request was cancelled');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });
    entry.controllers.add(controller);
    entry.active += 1;
    this.active += 1;
    let retired = false;
    let upstreamSettled = false;
    const retire = (): void => {
      if (retired) return;
      retired = true;
      entry.controllers.delete(controller);
      entry.active -= 1;
      this.active -= 1;
      if (entry.closed && entry.active === 0) {
        this.identityKeys.delete(this.identityKey(entry.binding));
      }
    };
    const deadline = this.deadlines.wait(request.deadlineMs);
    let onAbort!: () => void;
    const cancelled = new Promise<{ readonly kind: 'cancelled' }>((resolve) => {
      onAbort = () => resolve({ kind: 'cancelled' });
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const upstream = Promise.resolve().then(() => this.options.upstream.invoke({
        ...target(entry.binding, request.path),
        body: request.body,
        deadlineMs: request.deadlineMs,
        requestId: request.requestId,
        signal: controller.signal,
      })).then(
        (response) => ({ kind: 'response' as const, response }),
        () => ({ kind: 'upstream-error' as const }),
      ).then((outcome) => {
        upstreamSettled = true;
        return outcome;
      });
    void upstream.then(retire);
    try {
      const outcome = await Promise.race([
        upstream,
        deadline.promise.then(() => ({ kind: 'deadline' as const })),
        cancelled,
      ]);
      if (outcome.kind === 'deadline') {
        controller.abort();
        throw failure('deadline', 'Provider inference deadline exceeded');
      }
      if (outcome.kind === 'cancelled' || entry.closed) {
        throw failure('cancelled', 'Provider inference request was cancelled');
      }
      if (outcome.kind === 'upstream-error') {
        throw failure('unavailable', 'Provider inference upstream failed');
      }
      let response;
      try {
        response = parseProviderInferenceBrokerResponse(outcome.response);
      } catch {
        throw failure('response-invalid', 'Provider inference response was invalid');
      }
      if (response.requestId !== request.requestId ||
          bytes(response.body) > entry.binding.maxResponseBytes) {
        throw failure('response-invalid', 'Provider inference response exceeded its binding');
      }
      return response;
    } finally {
      deadline.cancel();
      controller.signal.removeEventListener('abort', onAbort);
      externalSignal?.removeEventListener('abort', abort);
      if (upstreamSettled) retire();
    }
  }

  release(endpointIdValue: string): void {
    const endpointId = token(endpointIdValue, 'provider inference endpoint');
    const entry = this.endpoints.get(endpointId);
    if (!entry) return;
    entry.closed = true;
    for (const controller of entry.controllers) controller.abort();
    this.endpoints.delete(endpointId);
    if (entry.active === 0) this.identityKeys.delete(this.identityKey(entry.binding));
  }

  releaseSession(sessionIdValue: string): void {
    const sessionId = token(sessionIdValue, 'provider inference session');
    for (const [endpointId, entry] of [...this.endpoints]) {
      if (entry.binding.sessionId === sessionId) this.release(endpointId);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.endpoints.values()) {
      entry.closed = true;
      for (const controller of entry.controllers) controller.abort();
      if (entry.active === 0) this.identityKeys.delete(this.identityKey(entry.binding));
    }
    this.endpoints.clear();
    this.pendingIdentityKeys.clear();
  }

  private identityKey(binding: ServerCoreProviderInferenceBinding): string {
    return [binding.instanceId, binding.processId, binding.sessionId].join('\0');
  }
}
