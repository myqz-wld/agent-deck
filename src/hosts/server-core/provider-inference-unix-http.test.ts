import { chmodSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderInferenceBrokerResponse } from '@contracts/index';
import type { DaemonListener } from '@hosts/daemon';
import { providerSessionBrokerSocketPath } from '@hosts/provider-session/broker-socket-path';

import { ServerCoreProviderInferenceBroker } from './provider-inference-broker';
import type {
  ServerCoreProviderInferenceBinding,
  ServerCoreProviderInferenceBrokerPort,
  ServerCoreProviderInferenceUpstreamInput,
  ServerCoreProviderInferenceUpstreamPort,
  ServerCoreProviderInferenceUpstreamTarget,
} from './provider-inference-broker-port';
import { ServerCoreProviderInferenceUnixHttp } from './provider-inference-unix-http';

const roots: string[] = [];
const services: ServerCoreProviderInferenceUnixHttp[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function binding(): ServerCoreProviderInferenceBinding {
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
  };
}

function response(requestId: string): ProviderInferenceBrokerResponse {
  return {
    schemaVersion: 1,
    body: 'data: {"ok":true}\n\n',
    contentType: 'text/event-stream',
    requestId,
    statusCode: 200,
  };
}

class FakeUpstream implements ServerCoreProviderInferenceUpstreamPort {
  readonly calls: ServerCoreProviderInferenceUpstreamInput[] = [];
  invokeImpl: (input: ServerCoreProviderInferenceUpstreamInput) =>
    Promise<ProviderInferenceBrokerResponse> = async (input) => response(input.requestId);

  async isAvailable(_target: ServerCoreProviderInferenceUpstreamTarget): Promise<boolean> {
    return true;
  }

  invoke(input: ServerCoreProviderInferenceUpstreamInput): Promise<ProviderInferenceBrokerResponse> {
    this.calls.push(input);
    return this.invokeImpl(input);
  }
}

async function harness(upstream = new FakeUpstream()) {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ad-http-')));
  roots.push(root);
  chmodSync(root, 0o700);
  const broker = new ServerCoreProviderInferenceBroker({
    nextEndpointId: () => 'endpoint-a',
    upstream,
  });
  const service = new ServerCoreProviderInferenceUnixHttp({ broker, brokerRoot: root });
  services.push(service);
  const endpoint = await service.open(binding());
  return {
    endpoint,
    root,
    service,
    socketPath: providerSessionBrokerSocketPath(root, endpoint.endpointId),
    upstream,
  };
}

function invoke(socketPath: string, options: {
  readonly body?: Record<string, unknown>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly path?: string;
} = {}): Promise<{
  readonly body: string;
  readonly headers: NodeJS.Dict<string | string[]>;
  readonly statusCode: number;
}> {
  const body = JSON.stringify(options.body ?? {
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
  });
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      agent: false,
      headers: {
        connection: 'close',
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json',
        'x-agent-deck-deadline-ms': '20000',
        'x-agent-deck-request-id': 'request-a',
        ...options.headers,
      },
      method: 'POST',
      path: options.path ?? '/v1/chat/completions',
      socketPath,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
        statusCode: response.statusCode ?? 0,
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

describe('ServerCore Provider inference Unix HTTP endpoint', () => {
  it('derives the authenticated peer from one private socket and returns raw JSON/SSE HTTP', async () => {
    const { service, socketPath, upstream } = await harness();
    await expect(service.available(binding())).resolves.toBe(true);
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    const result = await invoke(socketPath);

    expect(result).toMatchObject({
      body: 'data: {"ok":true}\n\n',
      statusCode: 200,
    });
    expect(result.headers['content-type']).toBe('text/event-stream');
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]).toMatchObject({
      adapterId: 'grok-build',
      instanceId: 'instance-a',
      path: '/v1/chat/completions',
      processId: 'process-a',
      providerId: 'xai',
      sessionId: 'session-a',
      upstreamId: 'grok-chat',
    });
  });

  it('invokes the same identity-bound endpoint directly for a framed Desktop transport', async () => {
    const { endpoint, service, upstream } = await harness();
    await expect(service.invoke(endpoint.endpointId, {
      schemaVersion: 1,
      body: { messages: [{ role: 'user', content: 'hello' }], stream: true },
      deadlineMs: 20_000,
      method: 'POST',
      path: '/v1/chat/completions',
      requestId: 'request-direct-a',
    }, new AbortController().signal)).resolves.toMatchObject({
      requestId: 'request-direct-a',
      statusCode: 200,
    });
    expect(upstream.calls[0]).toMatchObject({
      processId: 'process-a',
      sessionId: 'session-a',
    });
    await expect(service.invoke(endpoint.endpointId, {
      schemaVersion: 1,
      body: {},
      deadlineMs: 20_000,
      method: 'POST',
      path: '/v1/responses',
      requestId: 'request-direct-b',
    }, new AbortController().signal)).resolves.toMatchObject({
      requestId: 'request-direct-b',
      statusCode: 200,
    });
  });

  it('rejects auth headers and route substitution before broker invocation', async () => {
    const { socketPath, upstream } = await harness();
    const auth = await invoke(socketPath, { headers: { authorization: 'Bearer model-secret' } });
    expect(auth.statusCode).toBe(403);
    expect(auth.body).not.toContain('model-secret');
    const route = await invoke(socketPath, { path: '/v1/messages' });
    expect(route.statusCode).toBe(403);
    expect(upstream.calls).toHaveLength(0);
  });

  it('releases the socket and aborts in-flight work before endpoint identity can be reused', async () => {
    const upstream = new FakeUpstream();
    upstream.invokeImpl = () => new Promise(() => undefined);
    const { endpoint, service, socketPath } = await harness(upstream);
    const pending = invoke(socketPath).catch((error: unknown) => error);
    for (let attempt = 0; upstream.calls.length === 0 && attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(upstream.calls).toHaveLength(1);
    await service.release(endpoint.endpointId);
    await pending;

    expect(upstream.calls[0]!.signal.aborted).toBe(true);
    expect(existsSync(socketPath)).toBe(false);
    await expect(invoke(socketPath)).rejects.toBeDefined();
  });

  it('aborts endpoint work before waiting for aggregate close completion', async () => {
    const upstream = new FakeUpstream();
    upstream.invokeImpl = () => new Promise(() => undefined);
    const { service, socketPath } = await harness(upstream);
    const pending = invoke(socketPath).catch((error: unknown) => error);
    for (let attempt = 0; upstream.calls.length === 0 && attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(upstream.calls).toHaveLength(1);
    await expect(service.close()).resolves.toBeUndefined();
    await pending;
    expect(upstream.calls[0]!.signal.aborted).toBe(true);
  });

  it('does not cache a rejected aggregate close result', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ad-hc-')));
    roots.push(root);
    chmodSync(root, 0o700);
    const delegate = new ServerCoreProviderInferenceBroker({
      nextEndpointId: () => 'endpoint-a',
      upstream: new FakeUpstream(),
    });
    const close = vi.fn(() => {
      delegate.close();
      if (close.mock.calls.length === 1) throw new Error('first close failed');
    });
    const broker: ServerCoreProviderInferenceBrokerPort = {
      available: (value) => delegate.available(value),
      open: (value) => delegate.open(value),
      invoke: (peer, request, signal) => delegate.invoke(peer, request, signal),
      release: (endpointId) => delegate.release(endpointId),
      releaseSession: (sessionId) => delegate.releaseSession(sessionId),
      close,
    };
    const service = new ServerCoreProviderInferenceUnixHttp({ broker, brokerRoot: root });
    services.push(service);

    await expect(service.close()).rejects.toThrow('shutdown failed');
    await expect(service.close()).resolves.toBeUndefined();
  });

  it('retries endpoint cleanup that failed before the listener was stopped', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ad-hc-')));
    roots.push(root);
    chmodSync(root, 0o700);
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error('listener stop failed'))
      .mockResolvedValueOnce(undefined);
    const listener: DaemonListener = { start: vi.fn(async () => undefined), stop };
    const service = new ServerCoreProviderInferenceUnixHttp({
      broker: new ServerCoreProviderInferenceBroker({
        nextEndpointId: () => 'endpoint-a',
        upstream: new FakeUpstream(),
      }),
      brokerRoot: root,
      listener: () => listener,
    });
    services.push(service);
    await service.open(binding());

    await expect(service.close()).rejects.toThrow('shutdown failed');
    expect(stop).toHaveBeenCalledOnce();
    await expect(service.close()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('sweeps an endpoint published by an open racing aggregate close', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ad-hc-')));
    roots.push(root);
    chmodSync(root, 0o700);
    const delegate = new ServerCoreProviderInferenceBroker({
      nextEndpointId: () => 'endpoint-a',
      upstream: new FakeUpstream(),
    });
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const broker: ServerCoreProviderInferenceBrokerPort = {
      available: (value) => delegate.available(value),
      open: async (value) => {
        await openGate;
        return delegate.open(value);
      },
      invoke: (peer, request, signal) => delegate.invoke(peer, request, signal),
      release: (endpointId) => delegate.release(endpointId),
      releaseSession: (sessionId) => delegate.releaseSession(sessionId),
      close: () => delegate.close(),
    };
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error('listener stop failed'))
      .mockResolvedValueOnce(undefined);
    const listener: DaemonListener = { start: vi.fn(async () => undefined), stop };
    const service = new ServerCoreProviderInferenceUnixHttp({
      broker,
      brokerRoot: root,
      listener: () => listener,
    });
    services.push(service);

    const opening = service.open(binding());
    const closing = service.close();
    releaseOpen();

    await expect(opening).rejects.toThrow('closed');
    await expect(closing).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
    await expect(service.close()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('bounds HTTP connection admission independently from broker concurrency', async () => {
    const { root, service } = await harness();
    expect(() => new ServerCoreProviderInferenceUnixHttp({
      broker: new ServerCoreProviderInferenceBroker({
        nextEndpointId: () => 'endpoint-b',
        upstream: new FakeUpstream(),
      }),
      brokerRoot: root,
      maxConnectionsPerEndpoint: 0,
    })).toThrow('connection limit');
    await service.releaseSession('session-a');
  });
});
