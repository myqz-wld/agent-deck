import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ProviderSessionShimInferenceProxy } from './shim-inference-proxy';

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function broker(): Promise<{
  readonly calls: Array<{ body: string; headers: Record<string, unknown>; url: string }>;
  readonly socketPath: string;
}> {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'adp-')));
  roots.push(root);
  const socketPath = join(root, 'b.sock');
  const calls: Array<{ body: string; headers: Record<string, unknown>; url: string }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      calls.push({ body, headers: { ...request.headers }, url: request.url ?? '' });
      const output = 'data: {"ok":true}\n\ndata: [DONE]\n\n';
      response.writeHead(200, {
        'content-length': Buffer.byteLength(output),
        'content-type': 'text/event-stream',
      });
      response.end(output);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  servers.push(server);
  return { calls, socketPath };
}

describe('ProviderSessionShimInferenceProxy', () => {
  it('forwards only bounded JSON/SSE over UDS and strips model-visible auth', async () => {
    const upstream = await broker();
    const proxy = new ProviderSessionShimInferenceProxy({
      brokerSocketPath: upstream.socketPath,
      localModelIds: ['grok-4.5'],
      nextRequestId: () => 'request-a',
      upstreamPaths: ['/v1/chat/completions', '/v1/responses'],
    });
    await proxy.start();
    try {
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], stream: true }),
        headers: {
          authorization: 'Bearer model-visible-marker',
          cookie: 'provider=marker',
          'content-type': 'application/json',
          'x-foreign-auth': 'marker',
        },
        method: 'POST',
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(await response.text()).toContain('data: [DONE]');
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]).toMatchObject({
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], stream: true }),
        url: '/v1/chat/completions',
        headers: {
          'x-agent-deck-request-id': 'request-a',
          host: 'agent-deck-inference',
        },
      });
      expect(JSON.stringify(upstream.calls[0]!.headers)).not.toMatch(
        /authorization|cookie|foreign|model-visible-marker/i,
      );
      const responses = await fetch(`${proxy.baseUrl}/responses`, {
        body: JSON.stringify({ input: 'hello', model: 'grok-4.5', stream: true }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(responses.status).toBe(200);
      expect(upstream.calls[1]).toMatchObject({ url: '/v1/responses' });
      const models = await fetch(`${proxy.baseUrl}/models`, {
        headers: { authorization: 'Bearer model-visible-marker' },
      });
      expect(models.status).toBe(200);
      await expect(models.json()).resolves.toEqual({
        data: [{ created: 0, id: 'grok-4.5', object: 'model', owned_by: 'xai' }],
        object: 'list',
      });
      expect(upstream.calls).toHaveLength(2);
    } finally {
      await proxy.close();
    }
  });

  it('uses the bounded direct transport without exposing model-visible auth fields', async () => {
    const calls: unknown[] = [];
    const proxy = new ProviderSessionShimInferenceProxy({
      invoke: async (request) => {
        calls.push(request);
        return {
          schemaVersion: 1,
          body: 'data: {"ok":true}\n\ndata: [DONE]\n\n',
          contentType: 'text/event-stream',
          requestId: request.requestId,
          statusCode: 200,
        };
      },
      nextRequestId: () => 'request-direct-a',
      upstreamPaths: ['/v1/messages'],
    });
    await proxy.start();
    try {
      const response = await fetch(`${proxy.baseUrl}/messages`, {
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], stream: true }),
        headers: {
          authorization: 'Bearer model-visible-marker',
          cookie: 'provider=marker',
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('data: [DONE]');
      expect(calls).toEqual([expect.objectContaining({
        method: 'POST',
        path: '/v1/messages',
        requestId: 'request-direct-a',
      })]);
      expect(JSON.stringify(calls)).not.toMatch(/authorization|cookie|model-visible-marker/i);
    } finally {
      await proxy.close();
    }
  });

  it('reports only a bounded route/reason diagnostic when a request fails closed', async () => {
    const failures: unknown[] = [];
    const proxy = new ProviderSessionShimInferenceProxy({
      invoke: async () => { throw new Error('broker route rejected'); },
      onFailure: (failure) => failures.push(failure),
      upstreamPaths: ['/v1/responses'],
    });
    await proxy.start();
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        body: JSON.stringify({ input: 'MODEL_VISIBLE_SECRET' }),
        headers: { authorization: 'Bearer MODEL_VISIBLE_TOKEN', 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(response.status).toBe(502);
      expect(failures).toEqual([{
        path: '/v1/responses',
        reason: 'broker route rejected',
      }]);
      expect(JSON.stringify(failures)).not.toMatch(/MODEL_VISIBLE|authorization/i);
    } finally {
      await proxy.close();
    }
  });
});
