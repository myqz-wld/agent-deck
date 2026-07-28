import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import type { McpAuthInfo } from '@main/agent-deck-mcp/types';
import { HookServer } from './server';

function appOf(server: HookServer): FastifyInstance {
  return (server as unknown as { app: FastifyInstance }).app;
}

afterEach(() => {
  mcpSessionTokenMap.clearAll();
});

describe('HookServer authority boundary', () => {
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

  it('normalizes malformed hook JSON without exposing parser details', async () => {
    const server = new HookServer(47_821, 'hook-token', 'mcp-token');
    server.registerRoute({
      method: 'POST',
      url: '/hook/test',
      handler: async (_request, reply) => reply.send({ ok: true }),
    });

    const response = await appOf(server).inject({
      method: 'POST',
      url: '/hook/test',
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
