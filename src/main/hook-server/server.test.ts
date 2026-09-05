import type { FastifyInstance } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import type { McpAuthInfo } from '@main/agent-deck-mcp/types';
import { HookServer } from './server';

const requireFromTest = createRequire(import.meta.url);
const injectRaw = createRequire(requireFromTest.resolve('fastify'))('light-my-request');

async function injectTarget(app: FastifyInstance, target: string, authorization?: string) {
  await app.ready();
  return injectRaw((request: IncomingMessage, response: ServerResponse) => {
    request.url = target;
    app.server.emit('request', request, response);
  }, {
    method: 'POST',
    url: '/raw-target-fixture',
    headers: authorization ? { authorization } : {},
    payload: {},
  });
}

function appOf(server: HookServer): FastifyInstance {
  return (server as unknown as { app: FastifyInstance }).app;
}

afterEach(() => {
  mcpSessionTokenMap.clearAll();
});

describe('HookServer authority boundary', () => {
  it.each([
    ['/hook/test', '/hook/test', 'hook-token'],
    ['/hook/test', '/%68ook/test', 'hook-token'],
    ['/hook/test', '/h%6fok/test', 'hook-token'],
    ['/hook/test', 'http://localhost/hook/test', 'hook-token'],
    ['/mcp', '/mcp', 'mcp-token'],
    ['/mcp', '/%6dcp', 'mcp-token'],
    ['/mcp', 'http://localhost/mcp', 'mcp-token'],
  ])('authenticates matched route %s for raw target %s', async (route, target, token) => {
    const server = new HookServer(0, 'hook-token', 'mcp-token');
    let executed = 0;
    server.registerRoute({ method: 'POST', url: route, handler: async () => {
      executed += 1;
      return { ok: true };
    } });
    const app = appOf(server);
    try {
      for (const authorization of [undefined, 'Bearer wrong-token']) {
        expect((await injectTarget(app, target, authorization)).statusCode).toBe(401);
      }
      expect(executed).toBe(0);
      expect((await injectTarget(app, target, `Bearer ${token}`)).statusCode).toBe(200);
      expect(executed).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('keeps health routes public without applying a protected-route policy to 404s', async () => {
    const server = new HookServer(0, 'hook-token', 'mcp-token');
    server.registerRoute({ method: 'GET', url: '/health', handler: async () => ({ ok: true }) });
    const app = appOf(server);
    try {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/missing' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('rejects empty hook and MCP tokens at construction', () => {
    expect(() => new HookServer(47_821, '', 'mcp-token')).toThrow(
      'non-empty hookToken',
    );
    expect(() => new HookServer(47_821, 'hook-token', '   ')).toThrow(
      'non-empty mcpToken',
    );
  });

  it('accepts only the configured hook bearer token without listening', async () => {
    const server = new HookServer(47_821, 'hook-token', 'mcp-token');
    server.registerRoute({
      method: 'POST',
      url: '/hook/test',
      handler: async (_request, reply) => reply.send({ ok: true }),
    });

    const invalid = await appOf(server).inject({
      method: 'POST',
      url: '/hook/test',
      headers: { authorization: 'Bearer wrong-token' },
      payload: {},
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toEqual({ ok: false, error: 'unauthorized' });

    const valid = await appOf(server).inject({
      method: 'POST',
      url: '/hook/test',
      headers: { authorization: 'Bearer hook-token' },
      payload: {},
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ ok: true });
  });

  it('keeps per-session MCP identity and global read-only fallback semantics', async () => {
    const server = new HookServer(47_821, 'hook-token', 'global-mcp-token');
    server.registerRoute({
      method: 'POST',
      url: '/mcp/test',
      handler: async (request, reply) =>
        reply.send({
          auth: (request.raw as { auth?: McpAuthInfo }).auth ?? null,
        }),
    });
    const sessionToken = mcpSessionTokenMap.allocate('session-owner');

    const perSession = await appOf(server).inject({
      method: 'POST',
      url: '/mcp/test',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(perSession.statusCode).toBe(200);
    expect(perSession.json()).toEqual({
      auth: { resolvedSid: 'session-owner', fallbackToGlobal: false },
    });

    const global = await appOf(server).inject({
      method: 'POST',
      url: '/mcp/test',
      headers: { authorization: 'Bearer global-mcp-token' },
    });
    expect(global.statusCode).toBe(200);
    expect(global.json()).toEqual({
      auth: { resolvedSid: null, fallbackToGlobal: true },
    });

    const invalid = await appOf(server).inject({
      method: 'POST',
      url: '/mcp/test',
      headers: { authorization: 'Bearer invalid-mcp-token' },
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it.each(['/hook/test', '/%68ook/test'])(
    'normalizes malformed hook JSON for %s without exposing parser details', async (url) => {
    const server = new HookServer(47_821, 'hook-token', 'mcp-token');
    server.registerRoute({
      method: 'POST',
      url: '/hook/test',
      handler: async (_request, reply) => reply.send({ ok: true }),
    });

    const response = await appOf(server).inject({
      method: 'POST',
      url,
      headers: {
        authorization: 'Bearer hook-token',
        'content-type': 'application/json',
      },
      payload: '{"prompt":"credential-secret"',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'invalid hook payload',
    });
    expect(response.body).not.toContain('credential-secret');
    expect(response.body).not.toContain('JSON');
  });
});
