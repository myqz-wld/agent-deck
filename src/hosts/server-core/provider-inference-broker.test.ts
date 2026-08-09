import { describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_INFERENCE_MAX_RESPONSE_BYTES,
  type ProviderInferenceBrokerResponse,
} from '@contracts/index';

import {
  ServerCoreProviderInferenceBroker,
  parseServerCoreProviderInferenceBinding,
  type ServerCoreProviderInferenceDeadlinePort,
} from './provider-inference-broker';
import type {
  ServerCoreProviderInferenceBinding,
  ServerCoreProviderInferencePeer,
  ServerCoreProviderInferenceUpstreamInput,
  ServerCoreProviderInferenceUpstreamPort,
  ServerCoreProviderInferenceUpstreamTarget,
} from './provider-inference-broker-port';

function binding(overrides: Partial<ServerCoreProviderInferenceBinding> = {}) {
  return {
    adapterId: 'grok-build',
    instanceId: 'instance-a',
    maxConcurrency: 2,
    maxDeadlineMs: 30_000,
    maxRequestBytes: 4_096,
    maxResponseBytes: 8_192,
    method: 'POST',
    paths: ['/v1/chat/completions', '/v1/responses'],
    processId: 'process-a',
    providerId: 'xai',
    sessionId: 'session-a',
    upstreamId: 'grok-chat',
    ...overrides,
  } satisfies ServerCoreProviderInferenceBinding;
}

function peer(endpointId: string, overrides: Partial<ServerCoreProviderInferencePeer> = {}) {
  return {
    adapterId: 'grok-build',
    endpointId,
    instanceId: 'instance-a',
    processId: 'process-a',
    providerId: 'xai',
    sessionId: 'session-a',
    upstreamId: 'grok-chat',
    ...overrides,
  } satisfies ServerCoreProviderInferencePeer;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    body: { messages: [{ role: 'user', content: 'hello' }], stream: true },
    deadlineMs: 20_000,
    method: 'POST',
    path: '/v1/chat/completions',
    requestId: 'request-a',
    ...overrides,
  };
}

function response(requestId = 'request-a'): ProviderInferenceBrokerResponse {
  return {
    schemaVersion: 1,
    body: '{"choices":[]}',
    contentType: 'application/json',
    requestId,
    statusCode: 200,
  };
}

class FakeUpstream implements ServerCoreProviderInferenceUpstreamPort {
  available = true;
  availabilityImpl: (target: ServerCoreProviderInferenceUpstreamTarget) => Promise<boolean> =
    async () => this.available;
  readonly availability = vi.fn((target: ServerCoreProviderInferenceUpstreamTarget) =>
    this.availabilityImpl(target));
  readonly calls: ServerCoreProviderInferenceUpstreamInput[] = [];
  invokeImpl: (input: ServerCoreProviderInferenceUpstreamInput) =>
    Promise<ProviderInferenceBrokerResponse> = async (input) => response(input.requestId);

  isAvailable(target: ServerCoreProviderInferenceUpstreamTarget): Promise<boolean> {
    return this.availability(target);
  }

  invoke(input: ServerCoreProviderInferenceUpstreamInput): Promise<ProviderInferenceBrokerResponse> {
    this.calls.push(input);
    return this.invokeImpl(input);
  }
}

class ManualDeadlines implements ServerCoreProviderInferenceDeadlinePort {
  private readonly entries: Array<{
    cancelled: boolean;
    delayMs: number;
    resolve: () => void;
  }> = [];

  wait(delayMs: number) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const entry = { cancelled: false, delayMs, resolve };
    this.entries.push(entry);
    return { promise, cancel: () => { entry.cancelled = true; } };
  }

  active(): number {
    return this.entries.filter((entry) => !entry.cancelled).length;
  }

  expireNext(): void {
    const entry = this.entries.find((candidate) => !candidate.cancelled);
    if (!entry) throw new Error('missing deadline');
    entry.resolve();
  }
}

async function opened(options: {
  readonly deadlines?: ManualDeadlines;
  readonly maxEndpoints?: number;
  readonly maxGlobalConcurrency?: number;
  readonly upstream?: FakeUpstream;
} = {}) {
  const upstream = options.upstream ?? new FakeUpstream();
  let nextId = 0;
  const broker = new ServerCoreProviderInferenceBroker({
    upstream,
    deadlines: options.deadlines,
    maxEndpoints: options.maxEndpoints,
    maxGlobalConcurrency: options.maxGlobalConcurrency,
    nextEndpointId: () => `endpoint-${++nextId}`,
  });
  const endpoint = await broker.open(binding());
  return { broker, endpoint, upstream };
}

describe('ServerCoreProviderInferenceBroker', () => {
  it('binds exact identity and route while leaving credential ownership in the upstream port', async () => {
    const { broker, endpoint, upstream } = await opened();
    await expect(broker.invoke(peer(endpoint.endpointId), request())).resolves.toEqual(response());
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]).toMatchObject({
      adapterId: 'grok-build',
      instanceId: 'instance-a',
      method: 'POST',
      path: '/v1/chat/completions',
      processId: 'process-a',
      providerId: 'xai',
      sessionId: 'session-a',
      upstreamId: 'grok-chat',
    });
    expect(Object.keys(upstream.calls[0]!).sort()).toEqual([
      'adapterId', 'body', 'deadlineMs', 'instanceId', 'method', 'path', 'processId',
      'providerId', 'requestId', 'sessionId', 'signal', 'upstreamId',
    ]);
    expect(JSON.stringify(upstream.calls[0])).not.toMatch(/authorization|credential|apiKey|token/i);
  });

  it('rejects every peer identity mismatch before invoking upstream', async () => {
    const { broker, endpoint, upstream } = await opened();
    for (const changed of [
      { adapterId: 'codex-cli' as const },
      { instanceId: 'instance-b' },
      { processId: 'process-b' },
      { providerId: 'other-provider' },
      { sessionId: 'session-b' },
      { upstreamId: 'other-upstream' },
      { endpointId: 'endpoint-other' },
    ]) {
      await expect(broker.invoke(peer(endpoint.endpointId, changed), request()))
        .rejects.toMatchObject({ code: 'access-denied' });
    }
    expect(upstream.calls).toHaveLength(0);
  });

  it('constrains method, path, body bytes, and per-binding deadline', async () => {
    const upstream = new FakeUpstream();
    const broker = new ServerCoreProviderInferenceBroker({
      upstream,
      nextEndpointId: () => 'endpoint-a',
    });
    const endpoint = await broker.open(binding({
      maxDeadlineMs: 5_000,
      maxRequestBytes: 64,
    }));
    await expect(broker.invoke(peer(endpoint.endpointId), request({
      body: {},
      deadlineMs: 5_000,
      path: '/v1/responses',
      requestId: 'responses-a',
    }))).resolves.toMatchObject({ requestId: 'responses-a' });
    await expect(broker.invoke(peer(endpoint.endpointId), request({
      path: '/v1/messages',
    }))).rejects.toMatchObject({ code: 'access-denied' });
    await expect(broker.invoke(peer(endpoint.endpointId), request({
      deadlineMs: 6_000,
    }))).rejects.toMatchObject({ code: 'limit' });
    await expect(broker.invoke(peer(endpoint.endpointId), request({
      body: { prompt: 'x'.repeat(65) },
    }))).rejects.toMatchObject({ code: 'limit' });
    await expect(broker.invoke(peer(endpoint.endpointId), request({
      method: 'GET',
    }))).rejects.toThrow();
    expect(upstream.calls).toHaveLength(1);
  });

  it('enforces endpoint and global concurrency without queueing hidden work', async () => {
    const upstream = new FakeUpstream();
    const pending: Array<{
      input: ServerCoreProviderInferenceUpstreamInput;
      resolve: (value: ProviderInferenceBrokerResponse) => void;
    }> = [];
    upstream.invokeImpl = (input) => new Promise((resolve) => pending.push({ input, resolve }));
    let nextId = 0;
    const broker = new ServerCoreProviderInferenceBroker({
      upstream,
      maxGlobalConcurrency: 2,
      nextEndpointId: () => `endpoint-${++nextId}`,
    });
    const endpoint = await broker.open(binding());
    const first = broker.invoke(peer(endpoint.endpointId), request({ requestId: 'request-1' }));
    const second = broker.invoke(peer(endpoint.endpointId), request({ requestId: 'request-2' }));
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    await expect(broker.invoke(peer(endpoint.endpointId), request({ requestId: 'request-3' })))
      .rejects.toMatchObject({ code: 'limit' });
    pending[0]!.resolve(response('request-1'));
    pending[1]!.resolve(response('request-2'));
    await expect(first).resolves.toMatchObject({ requestId: 'request-1' });
    await expect(second).resolves.toMatchObject({ requestId: 'request-2' });
  });

  it('aborts at the exact request deadline and releases concurrency', async () => {
    const deadlines = new ManualDeadlines();
    const upstream = new FakeUpstream();
    upstream.invokeImpl = () => new Promise(() => undefined);
    const { broker, endpoint } = await opened({ deadlines, upstream });
    const operation = broker.invoke(peer(endpoint.endpointId), request());
    await Promise.resolve();
    expect(deadlines.active()).toBe(1);
    deadlines.expireNext();
    await expect(operation).rejects.toMatchObject({ code: 'deadline' });
    expect(upstream.calls[0]!.signal.aborted).toBe(true);
    expect(deadlines.active()).toBe(0);
  });

  it('aborts active work and invalidates the endpoint on session release', async () => {
    const upstream = new FakeUpstream();
    upstream.invokeImpl = () => new Promise(() => undefined);
    const { broker, endpoint } = await opened({ upstream });
    const operation = broker.invoke(peer(endpoint.endpointId), request());
    await Promise.resolve();
    broker.releaseSession('session-a');
    await expect(operation).rejects.toMatchObject({ code: 'cancelled' });
    expect(upstream.calls[0]!.signal.aborted).toBe(true);
    await expect(broker.invoke(peer(endpoint.endpointId), request()))
      .rejects.toMatchObject({ code: 'access-denied' });
  });

  it('rejects invalid or oversized upstream responses and request-id substitution', async () => {
    for (const result of [
      response('request-other'),
      { ...response(), body: 'x'.repeat(8_193) },
      { ...response(), statusCode: 999 },
      { ...response(), body: 'x'.repeat(PROVIDER_INFERENCE_MAX_RESPONSE_BYTES + 1) },
    ]) {
      const upstream = new FakeUpstream();
      upstream.invokeImpl = async () => result;
      const { broker, endpoint } = await opened({ upstream });
      await expect(broker.invoke(peer(endpoint.endpointId), request()))
        .rejects.toMatchObject({ code: 'response-invalid' });
    }
  });

  it('fails closed for unavailable upstreams, duplicate identities, and endpoint exhaustion', async () => {
    const upstream = new FakeUpstream();
    upstream.available = false;
    const unavailable = new ServerCoreProviderInferenceBroker({ upstream });
    await expect(unavailable.available(binding())).resolves.toBe(false);
    await expect(unavailable.open(binding())).rejects.toMatchObject({ code: 'unavailable' });

    upstream.available = true;
    let nextId = 0;
    const bounded = new ServerCoreProviderInferenceBroker({
      upstream,
      maxEndpoints: 1,
      nextEndpointId: () => `endpoint-${++nextId}`,
    });
    await bounded.open(binding());
    await expect(bounded.open(binding())).rejects.toMatchObject({ code: 'limit' });
  });

  it('reserves process identity across concurrent readiness checks and close', async () => {
    const upstream = new FakeUpstream();
    let resolveAvailability!: (available: boolean) => void;
    const availability = new Promise<boolean>((resolve) => {
      resolveAvailability = resolve;
    });
    upstream.availabilityImpl = () => availability;
    const broker = new ServerCoreProviderInferenceBroker({
      upstream,
      nextEndpointId: () => 'endpoint-a',
    });
    const first = broker.open(binding());
    await Promise.resolve();
    await expect(broker.open(binding())).rejects.toMatchObject({ code: 'conflict' });
    broker.close();
    resolveAvailability(true);
    await expect(first).rejects.toMatchObject({ code: 'closed' });
  });

  it('retains process identity until every released-endpoint request has retired', async () => {
    const upstream = new FakeUpstream();
    let settleUpstream!: () => void;
    upstream.invokeImpl = () => new Promise((resolve) => {
      settleUpstream = () => resolve(response());
    });
    let nextId = 0;
    const broker = new ServerCoreProviderInferenceBroker({
      upstream,
      nextEndpointId: () => `endpoint-${++nextId}`,
    });
    const endpoint = await broker.open(binding());
    const operation = broker.invoke(peer(endpoint.endpointId), request());
    await Promise.resolve();
    broker.release(endpoint.endpointId);
    await expect(broker.open(binding())).rejects.toMatchObject({ code: 'conflict' });
    await expect(operation).rejects.toMatchObject({ code: 'cancelled' });
    await expect(broker.open(binding())).rejects.toMatchObject({ code: 'conflict' });
    settleUpstream();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(broker.open(binding())).resolves.toEqual({ endpointId: 'endpoint-2' });
  });

  it('exact-parses binding limits and rejects widened auth or endpoint fields', () => {
    expect(parseServerCoreProviderInferenceBinding(binding())).toEqual(binding());
    expect(() => parseServerCoreProviderInferenceBinding({
      ...binding(), credential: 'reusable-token',
    })).toThrow();
    expect(() => parseServerCoreProviderInferenceBinding({
      ...binding(), maxConcurrency: 3,
    })).toThrow();
    expect(() => parseServerCoreProviderInferenceBinding({
      ...binding(), paths: ['https://api.x.ai/v1/chat/completions'],
    })).toThrow();
    expect(() => parseServerCoreProviderInferenceBinding({
      ...binding(), paths: ['/v1/chat/completions', '/v1/chat/completions'],
    })).toThrow();
  });
});
