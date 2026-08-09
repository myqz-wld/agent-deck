import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import type { SessionRecord } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerCoreMcpBroker } from './mcp-broker';
import type { ServerCoreMcpToolHost } from './mcp-tool-host';

const brokers: ServerCoreMcpBroker[] = [];

function record(
  lifecycle: SessionRecord['lifecycle'] = 'active',
  archivedAt: number | null = null,
): SessionRecord {
  return {
    id: 'session-a',
    agentId: 'codex-cli',
    cwd: process.cwd(),
    title: 'session-a',
    source: 'sdk',
    lifecycle,
    activity: 'working',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt,
  };
}

function harness() {
  let current = record();
  const host = {
    workspaceRoot: process.cwd(),
    privateRoots: [],
    sessions: { get: (id: string) => id === 'session-a' ? current : null },
    tasks: {},
    issues: {},
    teams: { activeTeamIds: () => [] },
    ownership: { isCurrentOwner: () => false },
    metadata: { appendChange: () => 1 },
  } as unknown as ServerCoreMcpToolHost;
  const broker = new ServerCoreMcpBroker({
    host,
    diagnostics: { info: vi.fn(), warn: vi.fn() },
    loadMcpSdk: () => Promise.resolve({
      server: { McpServer },
      http: { StreamableHTTPServerTransport },
    }),
  });
  brokers.push(broker);
  return {
    broker,
    archiveSession: () => { current = record('active', 2); },
    closeSession: () => { current = record('closed'); },
  };
}

function endpoint(broker: ServerCoreMcpBroker): URL {
  return new URL(`http://127.0.0.1:${broker.listeningPort}/mcp`);
}

async function unauthorized(url: URL, token: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

beforeEach(() => mcpSessionTokenMap.clearAll());

afterEach(async () => {
  mcpSessionTokenMap.clearAll();
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.stop()));
});

describe('ServerCoreMcpBroker', () => {
  it('serves dynamically registered provider hooks behind the independent hook token', async () => {
    const { broker } = harness();
    const received: unknown[] = [];
    broker.registerForAdapter('codex-cli', {
      method: 'POST',
      url: '/hook/codex/test',
      handler: async (request, reply) => {
        received.push(request.body);
        await reply.code(200).send({ ok: true });
      },
    });
    await broker.start();
    const url = new URL(`http://127.0.0.1:${broker.listeningPort}/hook/codex/test`);
    const invoke = (token: string) => fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ session_id: 'session-a' }),
    });

    expect((await invoke(broker.mcpBearerToken)).status).toBe(401);
    expect((await invoke(broker.bearerToken)).status).toBe(200);
    expect(received).toEqual([{ session_id: 'session-a' }]);
  });

  it('binds a random loopback port and accepts only a live per-session token', async () => {
    const { broker } = harness();
    await broker.start();
    expect(broker.isRunning).toBe(true);
    expect(broker.listeningPort).toBeGreaterThan(0);

    for (const token of [broker.bearerToken, broker.mcpBearerToken, 'unknown']) {
      const response = await unauthorized(endpoint(broker), token);
      expect(response.status).toBe(401);
    }

    const token = mcpSessionTokenMap.allocate('session-a');
    const transport = new StreamableHTTPClientTransport(endpoint(broker), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'server-core-broker-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain('task_list');
      expect(listed.tools.map((tool) => tool.name)).toContain('report_issue');
    } finally {
      await Promise.allSettled([client.close(), transport.close()]);
    }
  });

  it('rejects released, archived, and closed-session identities', async () => {
    const { archiveSession, broker, closeSession } = harness();
    await broker.start();
    const token = mcpSessionTokenMap.allocate('session-a');

    archiveSession();
    expect((await unauthorized(endpoint(broker), token)).status).toBe(401);
    mcpSessionTokenMap.release('session-a');

    const nextToken = mcpSessionTokenMap.allocate('session-a');
    closeSession();
    expect((await unauthorized(endpoint(broker), nextToken)).status).toBe(401);
    mcpSessionTokenMap.release('session-a');
    expect((await unauthorized(endpoint(broker), nextToken)).status).toBe(401);
  });

  it('stops idempotently and clears the externally visible port', async () => {
    const { broker } = harness();
    await broker.start();
    const first = broker.stop();
    expect(broker.stop()).toBe(first);
    await first;
    expect(broker.isRunning).toBe(false);
    expect(broker.listeningPort).toBe(0);
  });
});
